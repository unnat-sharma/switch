import { test } from "node:test";
import assert from "node:assert/strict";
import { parseFiles, parseLatestVersion, parsePutSeq, parseSpaces } from "./auggie.js";

// Output shaped like real `auggie cloud` runs. IDs, names, and paths are made up.

test("parseSpaces reads name and id pairs", () => {
  const out = `Found 3 space(s):
- Team Alpha
  id: 11111111-2222-4333-8444-555555555555
  updated: 2026-01-01T00:00:00.000000Z
- Team Beta
  id: aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
  updated: 2026-01-02T00:00:00.000000Z
- Broken
  id: not-a-uuid
`;
  assert.deepEqual(parseSpaces(out), [
    { name: "Team Alpha", id: "11111111-2222-4333-8444-555555555555" },
    { name: "Team Beta", id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
  ]);
});

test("parseFiles lists remote paths and ignores the header", () => {
  const out = `Fetching files with version history...
Files with version history (user filesystem):

  .augment/skills/pdf-tools/SKILL.md      1 version      latest: 2026-01-01T10:00:00Z
  .augment/skills/pdf-tools/references/fonts.md 1 version      latest: 2026-01-01T10:00:02Z
  notes/todo.md                            2 versions     latest: 2026-01-03T09:00:00Z
`;
  assert.deepEqual(parseFiles(out), [
    ".augment/skills/pdf-tools/SKILL.md",
    ".augment/skills/pdf-tools/references/fonts.md",
    "notes/todo.md",
  ]);
});

test("parseLatestVersion picks the highest seq", () => {
  const out = `Fetching version history for: .augment/skills/release-notes/SKILL.md
.augment/skills/release-notes/SKILL.md -- 2 versions

  2026-01-01T10:00:00Z  seq=1  size=2.9KB  by=dev  agent=AGENT0000000000000000000000
  2026-01-05T12:30:00Z  seq=57  size=4B  by=dev

To restore a version: auggie cloud vfs checkout ...
`;
  assert.deepEqual(parseLatestVersion(out), { seq: 57, ts: "2026-01-05T12:30:00Z" });
});

test("parseLatestVersion returns undefined when there is no version", () => {
  assert.equal(parseLatestVersion("Fetching version history for: x\n"), undefined);
});

test("parsePutSeq reads the seq of an upload", () => {
  assert.equal(parsePutSeq("Uploading a.md to VFS path probe/b.md...\nUploaded a.md to user:probe/b.md seq=55\n"), 55);
  assert.equal(parsePutSeq("VFS command failed: API call failed: 409 Conflict"), undefined);
});

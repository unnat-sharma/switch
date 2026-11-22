import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scan, validateFrontmatter } from "./scan.js";

const skillMd = (name: string, description = "Does a thing.") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

test("validateFrontmatter accepts a good name and description", () => {
  assert.deepEqual(validateFrontmatter(skillMd("release-notes")), {
    kind: "valid",
    name: "release-notes",
    description: "Does a thing.",
  });
});

test("validateFrontmatter rejects bad names and missing fields", () => {
  assert.equal(validateFrontmatter(skillMd("Bad_Name")).kind, "invalid");
  assert.equal(validateFrontmatter(skillMd("double--hyphen")).kind, "invalid");
  assert.equal(validateFrontmatter(skillMd("a".repeat(65))).kind, "invalid");
  assert.equal(validateFrontmatter("# no frontmatter").kind, "invalid");
  assert.equal(validateFrontmatter("---\nname: x\n---\n").kind, "invalid"); // no description
  assert.equal(validateFrontmatter("---\n: : bad\n---\n").kind, "invalid");
});

test("scan finds skills, dedupes symlinks, skips invalid and nested skills", async () => {
  const base = await mkdtemp(join(tmpdir(), "switch-scan-test-"));
  try {
    const rootA = join(base, "a");
    const rootB = join(base, "b");
    await mkdir(join(rootA, "good", "refs"), { recursive: true });
    await writeFile(join(rootA, "good", "SKILL.md"), skillMd("good"));
    await writeFile(join(rootA, "good", "refs", "notes.md"), "notes");
    // A skill inside another skill is supporting material, not a second skill.
    await mkdir(join(rootA, "good", "refs", "inner"), { recursive: true });
    await writeFile(join(rootA, "good", "refs", "inner", "SKILL.md"), skillMd("inner"));
    await mkdir(join(rootA, "broken"), { recursive: true });
    await writeFile(join(rootA, "broken", "SKILL.md"), skillMd("Not_Valid"));
    await mkdir(rootB, { recursive: true });
    await symlink(join(rootA, "good"), join(rootB, "good")); // same skill, second root

    const result = await scan([rootA, rootB, join(base, "missing")]);

    assert.deepEqual(result.skills.map((s) => s.name), ["good"]);
    assert.equal(result.skills[0].root, rootA); // first root wins
    assert.deepEqual(result.skills[0].files.map((f) => f.rel).sort(), ["SKILL.md", "refs/inner/SKILL.md", "refs/notes.md"]);
    assert.equal(result.rejected.length, 1);
    assert.match(result.rejected[0].reason, /name must be/);
    assert.deepEqual(result.missingRoots, [join(base, "missing")]);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("scan gives the same hash to identical content and a new hash to changed content", async () => {
  const base = await mkdtemp(join(tmpdir(), "switch-hash-test-"));
  try {
    const one = join(base, "one", "s");
    const two = join(base, "two", "s");
    await mkdir(one, { recursive: true });
    await mkdir(two, { recursive: true });
    await writeFile(join(one, "SKILL.md"), skillMd("s"));
    await writeFile(join(two, "SKILL.md"), skillMd("s"));
    const same = await scan([join(base, "one"), join(base, "two")]);
    assert.equal(same.skills.length, 2);
    assert.equal(same.skills[0].hash, same.skills[1].hash);

    await writeFile(join(two, "SKILL.md"), skillMd("s", "Changed."));
    const diff = await scan([join(base, "one"), join(base, "two")]);
    assert.notEqual(diff.skills[0].hash, diff.skills[1].hash);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

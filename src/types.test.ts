import { test } from "node:test";
import assert from "node:assert/strict";
import { isRemotePath, isSkillName, isSpaceId, remotePath } from "./types.js";

test("isSkillName follows the SKILL.md name rule", () => {
  assert.equal(isSkillName("release-notes"), true);
  assert.equal(isSkillName("a".repeat(64)), true);
  for (const bad of ["", "Release", "a_b", "-a", "a-", "a--b", "a".repeat(65)]) {
    assert.equal(isSkillName(bad), false, bad);
  }
});

test("isSpaceId accepts only UUIDs", () => {
  assert.equal(isSpaceId("11111111-2222-4333-8444-555555555555"), true);
  assert.equal(isSpaceId("default"), false);
});

test("isRemotePath keeps writes inside the skills folder", () => {
  assert.equal(isRemotePath(".augment/skills/pdf-tools/SKILL.md"), true);
  for (const bad of [
    "notes/todo.md",
    ".augment/skills/../rules/x.md",
    ".augment/skills/pdf-tools/./SKILL.md",
    ".augment/skills//SKILL.md",
  ]) {
    assert.equal(isRemotePath(bad), false, bad);
  }
});

test("remotePath rejects a relative path that climbs out", () => {
  const skill = "pdf-tools";
  if (!isSkillName(skill)) throw new Error("fixture name must be valid");
  assert.equal(remotePath({ skill, rel: "refs/a.md" }), ".augment/skills/pdf-tools/refs/a.md");
  assert.throws(() => remotePath({ skill, rel: "../../rules/x.md" }));
});

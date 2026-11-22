// Branded strings. A brand comes only from its guard, never from `as`.
export type SkillName = string & { readonly __brand: "SkillName" };
export type SpaceId = string & { readonly __brand: "SpaceId" };
export type RemotePath = string & { readonly __brand: "RemotePath" };

const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKILLS_PREFIX = ".augment/skills/";

export function isSkillName(input: string): input is SkillName {
  return input.length >= 1 && input.length <= 64 && SKILL_NAME_RE.test(input);
}

export function isSpaceId(input: string): input is SpaceId {
  return UUID_RE.test(input);
}

// A file path inside the skills folder of a Cosmos filesystem, with no empty, `.`, or `..` segment.
export function isRemotePath(input: string): input is RemotePath {
  if (!input.startsWith(SKILLS_PREFIX)) return false;
  return input.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function skillPrefix(skill: SkillName): string {
  return `${SKILLS_PREFIX}${skill}/`;
}

export function remotePath({ skill, rel }: { skill: SkillName; rel: string }): RemotePath {
  const path = `${skillPrefix(skill)}${rel}`;
  if (!isRemotePath(path)) throw new Error(`not a valid skill path: ${path}`);
  return path;
}

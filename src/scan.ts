import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { errorMessage } from "./errors.js";
import { isSkillName, type SkillName } from "./types.js";

export const DEFAULT_ROOTS = ["~/.cursor/skills", "~/.pi/agent/skills", "~/.agents/skills"];
export const MAX_FILE_BYTES = 12_000_000; // Cosmos VFS per-file cap
const MAX_DEPTH = 5; // how deep to look for SKILL.md folders
const MAX_FILE_DEPTH = 12; // how deep to collect files inside a skill (guards symlink loops)
const SKILL_FILE = "SKILL.md";

export type LocalFile = { rel: string; abs: string; bytes: Buffer };
export type Skill = {
  name: SkillName;
  description: string;
  dir: string;
  root: string;
  files: LocalFile[];
  hash: string;
};
export type Rejected = { dir: string; reason: string };
export type ScanResult = { skills: Skill[]; rejected: Rejected[]; missingRoots: string[] };

export type Frontmatter =
  | { kind: "valid"; name: SkillName; description: string }
  | { kind: "invalid"; reason: string };

type ReadResult = { kind: "skill"; skill: Skill } | { kind: "rejected"; rejected: Rejected };

function parseYamlBlock(block: string): { kind: "ok"; data: unknown } | { kind: "error"; reason: string } {
  try {
    return { kind: "ok", data: parseYaml(block) };
  } catch (err) {
    return { kind: "error", reason: `frontmatter is not valid YAML: ${errorMessage(err)}` };
  }
}

// SKILL.md is file content, so its frontmatter is untrusted until this returns `valid`.
export function validateFrontmatter(text: string): Frontmatter {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1];
  if (block === undefined) return { kind: "invalid", reason: `${SKILL_FILE} has no frontmatter` };
  const parsed = parseYamlBlock(block);
  if (parsed.kind === "error") return { kind: "invalid", reason: parsed.reason };
  const { data } = parsed;
  if (typeof data !== "object" || data === null) {
    return { kind: "invalid", reason: "frontmatter is not a YAML mapping" };
  }
  const name = "name" in data ? data.name : undefined;
  const description = "description" in data ? data.description : undefined;
  if (typeof name !== "string" || !isSkillName(name)) {
    return { kind: "invalid", reason: "name must be 1-64 lowercase letters, digits, or single hyphens" };
  }
  if (typeof description !== "string" || description.trim().length < 1 || description.length > 1024) {
    return { kind: "invalid", reason: "description must be 1-1024 characters" };
  }
  return { kind: "valid", name, description: description.trim() };
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function isSkipped(name: string): boolean {
  return name.startsWith(".") || name === "node_modules";
}

// A folder with SKILL.md is a skill. Its contents are not searched for more skills.
async function findSkillDirs(dir: string, depth: number, out: string[]): Promise<void> {
  if (depth > MAX_DEPTH) return;
  const entries = await readdir(dir).catch(() => undefined);
  if (entries === undefined) return;
  if (entries.includes(SKILL_FILE)) {
    out.push(dir);
    return;
  }
  for (const name of entries) {
    if (isSkipped(name)) continue;
    const full = join(dir, name);
    const st = await stat(full).catch(() => undefined);
    if (st?.isDirectory()) await findSkillDirs(full, depth + 1, out);
  }
}

async function collectFiles(args: { base: string; rel: string; depth: number; out: LocalFile[] }): Promise<void> {
  const { base, rel, depth, out } = args;
  if (depth > MAX_FILE_DEPTH) throw new Error(`folders nested deeper than ${MAX_FILE_DEPTH} levels`);
  for (const name of await readdir(join(base, rel))) {
    if (isSkipped(name)) continue;
    const childRel = rel === "" ? name : `${rel}/${name}`;
    const abs = join(base, childRel);
    const st = await stat(abs);
    if (st.isDirectory()) {
      await collectFiles({ base, rel: childRel, depth: depth + 1, out });
    } else if (st.isFile()) {
      if (st.size > MAX_FILE_BYTES) throw new Error(`${childRel} is larger than 12 MB`);
      out.push({ rel: childRel, abs, bytes: await readFile(abs) });
    }
  }
}

function hashFiles(files: LocalFile[]): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.rel.localeCompare(b.rel))) {
    hash.update(file.rel).update("\0").update(file.bytes).update("\0");
  }
  return hash.digest("hex");
}

async function readSkill({ dir, root }: { dir: string; root: string }): Promise<ReadResult> {
  const reject = (reason: string): ReadResult => ({ kind: "rejected", rejected: { dir, reason } });
  const files: LocalFile[] = [];
  try {
    await collectFiles({ base: dir, rel: "", depth: 0, out: files });
  } catch (err) {
    return reject(errorMessage(err));
  }
  const skillFile = files.find((file) => file.rel === SKILL_FILE);
  if (skillFile === undefined) return reject(`${SKILL_FILE} is not a regular file`);
  const frontmatter = validateFrontmatter(skillFile.bytes.toString("utf8"));
  switch (frontmatter.kind) {
    case "invalid":
      return reject(frontmatter.reason);
    case "valid": {
      const { name, description } = frontmatter;
      return { kind: "skill", skill: { name, description, dir, root, files, hash: hashFiles(files) } };
    }
    default: {
      const _exhaustive: never = frontmatter;
      return _exhaustive;
    }
  }
}

export async function scan(roots: string[]): Promise<ScanResult> {
  const result: ScanResult = { skills: [], rejected: [], missingRoots: [] };
  const seen = new Set<string>(); // real paths, so a skill linked from two roots counts once
  for (const root of roots) {
    const rootPath = expandHome(root);
    const st = await stat(rootPath).catch(() => undefined);
    if (!st?.isDirectory()) {
      result.missingRoots.push(root);
      continue;
    }
    const dirs: string[] = [];
    await findSkillDirs(rootPath, 0, dirs);
    for (const dir of dirs) {
      const real = await realpath(dir);
      if (seen.has(real)) continue;
      seen.add(real);
      const read = await readSkill({ dir, root });
      switch (read.kind) {
        case "skill":
          result.skills.push(read.skill);
          break;
        case "rejected":
          result.rejected.push(read.rejected);
          break;
        default: {
          const _exhaustive: never = read;
          void _exhaustive;
        }
      }
    }
  }
  return result;
}

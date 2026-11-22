import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { download, latestVersion, type Target } from "./auggie.js";
import type { Skill } from "./scan.js";
import { remotePath, skillPrefix, type RemotePath } from "./types.js";

// `new`: not in Cosmos. `same`: bytes match. `changed`: bytes differ; `baseSeq` is the remote write the plan saw.
export type PlannedFile =
  | { kind: "new"; rel: string; abs: string; remote: RemotePath }
  | { kind: "same"; rel: string; abs: string; remote: RemotePath }
  | { kind: "changed"; rel: string; abs: string; remote: RemotePath; baseSeq: number };
export type FileKind = PlannedFile["kind"];
export type SkillPlan = { skill: Skill; files: PlannedFile[]; remoteOnly: string[] };

export async function planSkill(args: {
  skill: Skill;
  remoteFiles: ReadonlySet<string>;
  target: Target;
  tmp: string;
}): Promise<SkillPlan> {
  const { skill, remoteFiles, target, tmp } = args;
  const files: PlannedFile[] = [];
  for (const [index, file] of skill.files.entries()) {
    const remote = remotePath({ skill: skill.name, rel: file.rel });
    const base = { rel: file.rel, abs: file.abs, remote };
    if (!remoteFiles.has(remote)) {
      files.push({ kind: "new", ...base });
      continue;
    }
    const version = await latestVersion({ remote, target });
    const copy = join(tmp, `${skill.hash}-${index}`);
    await download({ remote, version, target, dest: copy });
    const same = (await readFile(copy)).equals(file.bytes);
    files.push(same ? { kind: "same", ...base } : { kind: "changed", ...base, baseSeq: version.seq });
  }
  const prefix = skillPrefix(skill.name);
  const planned = new Set<string>(files.map((file) => file.remote));
  const remoteOnly = [...remoteFiles]
    .filter((remote) => remote.startsWith(prefix) && !planned.has(remote))
    .map((remote) => remote.slice(prefix.length));
  return { skill, files, remoteOnly };
}

export async function withTmp<T>(fn: (tmp: string) => Promise<T>): Promise<T> {
  const tmp = await mkdtemp(join(tmpdir(), "switch-"));
  try {
    return await fn(tmp);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { execErrorDetail } from "./errors.js";
import { isSpaceId, type RemotePath, type SpaceId } from "./types.js";

const exec = promisify(execFile);

export class AuggieError extends Error {}

export type Target = { kind: "user" } | { kind: "space"; spaceId: SpaceId };
export type Space = { name: string; id: SpaceId };
export type Version = { seq: number; ts: string };
// What `put` requires of the remote file: not there yet, or still at the planned write.
export type Precondition = { kind: "absent" } | { kind: "seq"; baseSeq: number };

function targetArgs(target: Target): string[] {
  switch (target.kind) {
    case "user":
      return ["--filesystem-id", "user"];
    case "space":
      return ["--filesystem-id", "space", "--space-id", target.spaceId];
    default: {
      const _exhaustive: never = target;
      return _exhaustive;
    }
  }
}

async function auggie(args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await exec("auggie", ["cloud", ...args], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout + stderr;
  } catch (err) {
    throw new AuggieError(`auggie cloud ${args.join(" ")} failed:\n${execErrorDetail(err)}`);
  }
}

// `auggie cloud space list` prints "- <name>" then "  id: <uuid>".
export function parseSpaces(out: string): Space[] {
  const spaces: Space[] = [];
  let name: string | undefined;
  for (const line of out.split("\n")) {
    const nameMatch = /^- (.+)$/.exec(line)?.[1];
    if (nameMatch !== undefined) {
      name = nameMatch.trim();
      continue;
    }
    const id = /^\s+id: (\S+)/.exec(line)?.[1];
    if (id !== undefined && name !== undefined) {
      if (isSpaceId(id)) spaces.push({ name, id });
      name = undefined;
    }
  }
  return spaces;
}

// `auggie cloud vfs files` prints "  <path>  <n> version(s)  latest: <ts>".
export function parseFiles(out: string): string[] {
  return out.split("\n").flatMap((line) => {
    const path = /^\s+(\S+)\s+\d+ versions?\s+latest:/.exec(line)?.[1];
    return path === undefined ? [] : [path];
  });
}

// `auggie cloud vfs history` prints "  <ts>  seq=<n>  size=...  by=...".
export function parseLatestVersion(out: string): Version | undefined {
  let best: Version | undefined;
  for (const line of out.split("\n")) {
    const m = /^\s+(\S+)\s+seq=(\d+)/.exec(line);
    const ts = m?.[1];
    const seqText = m?.[2];
    if (ts === undefined || seqText === undefined) continue;
    const seq = Number(seqText);
    if (best === undefined || seq > best.seq) best = { seq, ts };
  }
  return best;
}

// `auggie cloud vfs put` prints "Uploaded <local> to <fs>:<path> seq=<n>".
export function parsePutSeq(out: string): number | undefined {
  const seq = /seq=(\d+)/.exec(out)?.[1];
  return seq === undefined ? undefined : Number(seq);
}

export async function listSpaces(): Promise<Space[]> {
  return parseSpaces(await auggie(["space", "list"]));
}

export async function listFiles(target: Target): Promise<string[]> {
  return parseFiles(await auggie(["vfs", "files", ...targetArgs(target)]));
}

export async function latestVersion({ remote, target }: { remote: RemotePath; target: Target }): Promise<Version> {
  const version = parseLatestVersion(await auggie(["vfs", "history", remote, ...targetArgs(target)]));
  if (version === undefined) throw new AuggieError(`no version found for ${remote}`);
  return version;
}

export async function download(args: {
  remote: RemotePath;
  version: Version;
  target: Target;
  dest: string;
}): Promise<void> {
  const { remote, version, target, dest } = args;
  await auggie([
    "vfs", "checkout", remote, version.ts, "--seq", String(version.seq), "--output", dest, ...targetArgs(target),
  ]);
}

// With `absent`, `put` fails if the file exists. With `seq`, it fails if someone wrote the file after `baseSeq`.
export async function put(args: {
  local: string;
  remote: RemotePath;
  target: Target;
  precondition: Precondition;
}): Promise<number> {
  const { local, remote, target, precondition } = args;
  const cmd = ["vfs", "put", local, remote, ...targetArgs(target)];
  switch (precondition.kind) {
    case "absent":
      break;
    case "seq":
      cmd.push("--base-seq", String(precondition.baseSeq));
      break;
    default: {
      const _exhaustive: never = precondition;
      return _exhaustive;
    }
  }
  const seq = parsePutSeq(await auggie(cmd));
  if (seq === undefined) throw new AuggieError(`put ${remote}: no seq in output`);
  return seq;
}

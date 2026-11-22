import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { download, latestVersion, listFiles, put, type Precondition, type Target } from "./auggie.js";
import { errorMessage } from "./errors.js";
import type { PlannedFile } from "./plan.js";
import type { RemotePath } from "./types.js";

// Only files that need a write. `same` files never reach the upload step.
export type UploadFile = Extract<PlannedFile, { kind: "new" | "changed" }>;
export type UploadResult =
  | { kind: "uploaded"; file: UploadFile; seq: number }
  | { kind: "failed"; file: UploadFile; error: string };
export type VerifyProblem = { remote: RemotePath; reason: string };

function preconditionFor(file: UploadFile): Precondition {
  switch (file.kind) {
    case "new":
      return { kind: "absent" };
    case "changed":
      return { kind: "seq", baseSeq: file.baseSeq };
    default: {
      const _exhaustive: never = file;
      return _exhaustive;
    }
  }
}

export async function upload({ files, target }: { files: UploadFile[]; target: Target }): Promise<UploadResult[]> {
  const results: UploadResult[] = [];
  for (const file of files) {
    try {
      const seq = await put({ local: file.abs, remote: file.remote, target, precondition: preconditionFor(file) });
      results.push({ kind: "uploaded", file, seq });
    } catch (err) {
      results.push({ kind: "failed", file, error: errorMessage(err) });
    }
  }
  return results;
}

// Reads Cosmos back. A file passes only if it is listed, its latest version is the
// one `put` wrote, and its bytes match the local file.
export async function verify(args: {
  results: UploadResult[];
  target: Target;
  tmp: string;
}): Promise<VerifyProblem[]> {
  const { results, target, tmp } = args;
  const problems: VerifyProblem[] = [];
  const listed = new Set(await listFiles(target));
  for (const [index, result] of results.entries()) {
    if (result.kind === "failed") continue;
    const remote = result.file.remote;
    if (!listed.has(remote)) {
      problems.push({ remote, reason: "missing after upload" });
      continue;
    }
    const version = await latestVersion({ remote, target });
    if (version.seq !== result.seq) {
      problems.push({ remote, reason: `latest seq ${version.seq}, expected ${result.seq}` });
      continue;
    }
    const copy = join(tmp, `verify-${index}`);
    await download({ remote, version, target, dest: copy });
    if (!(await readFile(copy)).equals(await readFile(result.file.abs))) {
      problems.push({ remote, reason: "bytes differ from local file" });
    }
  }
  return problems;
}

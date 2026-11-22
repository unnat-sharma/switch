export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// `execFile` errors carry the child's stdout and stderr. Prefer them over the generic message.
export function execErrorDetail(err: unknown): string {
  if (typeof err !== "object" || err === null) return String(err);
  const stdout = "stdout" in err && typeof err.stdout === "string" ? err.stdout : "";
  const stderr = "stderr" in err && typeof err.stderr === "string" ? err.stderr : "";
  return `${stdout}${stderr}`.trim() || errorMessage(err);
}

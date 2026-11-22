#!/usr/bin/env node
import * as p from "@clack/prompts";
import { parseArgs } from "node:util";
import { listFiles, listSpaces, type Space, type Target } from "./auggie.js";
import { upload, verify, type UploadFile } from "./apply.js";
import { errorMessage } from "./errors.js";
import { planSkill, withTmp, type FileKind, type PlannedFile, type SkillPlan } from "./plan.js";
import { DEFAULT_ROOTS, scan, type Skill } from "./scan.js";
import { isSkillName, type SkillName } from "./types.js";

const USAGE = `switch [folders...] [options]

Copy local agent skills into Cosmos.
Default folders: ${DEFAULT_ROOTS.join(", ")}

Options:
  --to <private|space name or id>  Destination. Asks when omitted.
  --skills <a,b,c>                 Skills to upload. Asks when omitted.
  --replace                        Replace changed files in Cosmos without asking.
  --dry-run                        Show the plan and stop.
  -y, --yes                        Skip prompts. Needs --to and --skills.
  -h, --help                       Show this help.
`;

type Destination = { target: Target; label: string };
type Mode = { kind: "interactive" } | { kind: "unattended"; to: string; skills: SkillName[] };
type Options = {
  roots: string[];
  mode: Mode;
  to: string | undefined;
  skills: SkillName[] | undefined;
  replace: boolean;
  dryRun: boolean;
};
type Command = { kind: "help" } | { kind: "run"; options: Options };

class Cancelled extends Error {}
class UsageError extends Error {}

const PRIVATE: Destination = { target: { kind: "user" }, label: "Private (only you)" };

function spaceDestination(space: Space): Destination {
  return { target: { kind: "space", spaceId: space.id }, label: `Space ${space.name}` };
}

function parseSkillList(raw: string): SkillName[] {
  const names = raw.split(",").map((name) => name.trim()).filter((name) => name !== "");
  const invalid = names.filter((name) => !isSkillName(name));
  if (invalid.length > 0) throw new UsageError(`not a valid skill name: ${invalid.join(", ")}`);
  return names.filter(isSkillName);
}

// CLI arguments are external input. Parse them once into `Command`.
function parseCommand(argv: string[]): Command {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      to: { type: "string" },
      skills: { type: "string" },
      replace: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) return { kind: "help" };
  const skills = values.skills === undefined ? undefined : parseSkillList(values.skills);
  let mode: Mode = { kind: "interactive" };
  if (values.yes) {
    if (values.to === undefined || skills === undefined) throw new UsageError("--yes needs --to and --skills.");
    mode = { kind: "unattended", to: values.to, skills };
  }
  return {
    kind: "run",
    options: {
      roots: [...DEFAULT_ROOTS, ...positionals],
      mode,
      to: values.to,
      skills,
      replace: values.replace,
      dryRun: values["dry-run"],
    },
  };
}

function resolveTo({ to, spaces }: { to: string; spaces: Space[] }): Destination {
  if (to === "private" || to === "user") return PRIVATE;
  const query = to.toLowerCase();
  const [match, ...rest] = spaces.filter((space) => space.id === to || space.name.toLowerCase() === query);
  if (match === undefined || rest.length > 0) {
    throw new UsageError(`no single Space matches "${to}". Run \`auggie cloud space list\`.`);
  }
  return spaceDestination(match);
}

async function askDestination(spaces: Space[]): Promise<Destination> {
  const picked = await p.select<Destination>({
    message: "Where should the skills go?",
    options: [
      { value: PRIVATE, label: "Private", hint: "only you" },
      ...spaces.map((space) => ({ value: spaceDestination(space), label: `Space: ${space.name}` })),
    ],
  });
  if (p.isCancel(picked)) throw new Cancelled();
  return picked;
}

// Two folders can hold one skill name with different content. Pick one per name.
async function chooseSources({ skills, mode }: { skills: Skill[]; mode: Mode }): Promise<Skill[]> {
  const byName = new Map<SkillName, Skill[]>();
  for (const skill of skills) byName.set(skill.name, [...(byName.get(skill.name) ?? []), skill]);
  const chosen: Skill[] = [];
  for (const [name, group] of byName) {
    const [first, ...others] = [...new Map(group.map((skill) => [skill.hash, skill])).values()];
    if (first === undefined) continue;
    if (others.length === 0) {
      chosen.push(first);
      continue;
    }
    const count = others.length + 1;
    if (mode.kind === "unattended") {
      p.log.warn(`"${name}" has ${count} versions. Using ${first.dir}.`);
      chosen.push(first);
      continue;
    }
    const picked = await p.select<Skill>({
      message: `"${name}" has ${count} different versions. Which one?`,
      options: [first, ...others].map((skill) => ({ value: skill, label: skill.dir })),
    });
    if (p.isCancel(picked)) throw new Cancelled();
    chosen.push(picked);
  }
  return chosen;
}

async function pickSkills({ sources, wanted }: { sources: Skill[]; wanted: SkillName[] | undefined }): Promise<Skill[]> {
  if (wanted !== undefined) {
    const unknown = wanted.filter((name) => !sources.some((skill) => skill.name === name));
    if (unknown.length > 0) throw new UsageError(`unknown skill(s): ${unknown.join(", ")}`);
    return sources.filter((skill) => wanted.includes(skill.name));
  }
  const picked = await p.multiselect<Skill>({
    message: "Which skills to upload?",
    options: sources.map((skill) => ({ value: skill, label: skill.name, hint: skill.description.slice(0, 70) })),
    required: true,
  });
  if (p.isCancel(picked)) throw new Cancelled();
  return picked;
}

function countKind({ plan, kind }: { plan: SkillPlan; kind: FileKind }): number {
  return plan.files.filter((file) => file.kind === kind).length;
}

function printPlan(plan: SkillPlan): void {
  const counts = `${countKind({ plan, kind: "new" })} new, ${countKind({ plan, kind: "same" })} same, ${countKind({ plan, kind: "changed" })} changed`;
  const remoteOnly = plan.remoteOnly.length > 0 ? `, ${plan.remoteOnly.length} only in Cosmos` : "";
  p.log.message(`${plan.skill.name}: ${counts}${remoteOnly}`);
  for (const file of plan.files) {
    if (file.kind === "changed") p.log.warn(`  changed: ${file.remote}`);
  }
  for (const rel of plan.remoteOnly) p.log.info(`  only in Cosmos (left alone): ${plan.skill.name}/${rel}`);
}

// Curried so `filter` can use it as a type guard.
function needsUpload(replace: boolean): (file: PlannedFile) => file is UploadFile {
  return (file): file is UploadFile => {
    switch (file.kind) {
      case "new":
        return true;
      case "changed":
        return replace;
      case "same":
        return false;
      default: {
        const _exhaustive: never = file;
        return _exhaustive;
      }
    }
  };
}

async function confirmReplace(args: { changed: number; destination: Destination; options: Options }): Promise<boolean> {
  const { changed, destination, options } = args;
  if (changed === 0 || options.replace) return options.replace;
  if (options.mode.kind === "unattended") return false;
  const answer = await p.confirm({ message: `Replace ${changed} changed file(s) in ${destination.label}?`, initialValue: false });
  if (p.isCancel(answer)) throw new Cancelled();
  return answer;
}

async function run(options: Options): Promise<void> {
  if (options.mode.kind === "interactive" && !process.stdin.isTTY) {
    throw new UsageError("No terminal. Run in a terminal, or pass --yes with --to and --skills.");
  }

  p.intro("switch");
  const found = await scan(options.roots);
  for (const root of found.missingRoots) p.log.info(`Folder not found, skipped: ${root}`);
  for (const rejected of found.rejected) p.log.warn(`Skipped ${rejected.dir}: ${rejected.reason}`);
  if (found.skills.length === 0) {
    p.outro("No valid skills found.");
    process.exitCode = 1;
    return;
  }

  const sources = await chooseSources({ skills: found.skills, mode: options.mode });
  const chosen = await pickSkills({ sources, wanted: options.skills });

  const spinner = p.spinner();
  spinner.start("Reading your Cosmos Spaces");
  const spaces = await listSpaces();
  spinner.stop(`Found ${spaces.length} Space(s)`);
  const destination = options.to === undefined ? await askDestination(spaces) : resolveTo({ to: options.to, spaces });

  await withTmp(async (tmp) => {
    spinner.start(`Comparing with ${destination.label}`);
    const remoteFiles = new Set(await listFiles(destination.target));
    const plans: SkillPlan[] = [];
    for (const skill of chosen) {
      plans.push(await planSkill({ skill, remoteFiles, target: destination.target, tmp }));
    }
    spinner.stop("Compared");
    plans.forEach(printPlan);

    if (options.dryRun) {
      p.outro("Dry run. Nothing uploaded.");
      return;
    }

    const files = plans.flatMap((plan) => plan.files);
    const changed = files.filter((file) => file.kind === "changed").length;
    const replace = await confirmReplace({ changed, destination, options });
    if (changed > 0 && !replace) p.log.warn(`Leaving ${changed} changed file(s) as they are in Cosmos.`);

    const work = files.filter(needsUpload(replace));
    if (work.length === 0) {
      p.outro("Nothing to upload.");
      return;
    }
    if (options.mode.kind === "interactive") {
      const ok = await p.confirm({ message: `Upload ${work.length} file(s) to ${destination.label}?` });
      if (p.isCancel(ok)) throw new Cancelled();
      if (!ok) {
        p.outro("Cancelled. Nothing uploaded.");
        return;
      }
    }

    spinner.start(`Uploading ${work.length} file(s)`);
    const results = await upload({ files: work, target: destination.target });
    spinner.stop("Upload finished");
    let failed = 0;
    for (const result of results) {
      if (result.kind !== "failed") continue;
      failed += 1;
      p.log.error(`${result.file.remote}: ${result.error}`);
    }

    spinner.start("Checking Cosmos copies");
    const problems = await verify({ results, target: destination.target, tmp });
    spinner.stop("Check finished");
    for (const problem of problems) p.log.error(`${problem.remote}: ${problem.reason}`);

    const total = failed + problems.length;
    p.outro(`Uploaded ${results.length - failed} of ${results.length} file(s) to ${destination.label}. ${total} problem(s).`);
    if (total > 0) process.exitCode = 1;
  });
}

async function main(): Promise<void> {
  const command = parseCommand(process.argv.slice(2));
  switch (command.kind) {
    case "help":
      process.stdout.write(USAGE);
      return;
    case "run":
      await run(command.options);
      return;
    default: {
      const _exhaustive: never = command;
      void _exhaustive;
    }
  }
}

main().catch((err: unknown) => {
  if (err instanceof Cancelled) {
    p.cancel("Cancelled.");
    return;
  }
  p.log.error(errorMessage(err));
  process.exitCode = 1;
});

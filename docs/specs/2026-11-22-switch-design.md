# switch: move local agent skills to Cosmos

## Why

Developers keep agent skills in several local folders: `~/.cursor/skills`, `~/.pi/agent/skills`, and `~/.agents/skills`. Cosmos loads skills from `.augment/skills/<name>/` in its virtual filesystem (VFS). `switch` copies the skills a developer picks into Cosmos, so the move takes one command instead of one `auggie cloud vfs put` per file.

## Goals

- Find every skill in the default folders and in any extra paths the developer passes.
- Let the developer pick the skills and one destination per run:
  - **Private**: the user VFS. Only the developer sees it.
  - **Space**: the VFS of one Cosmos Space the developer belongs to.
- Show, before any write, which skills are new, unchanged, or changed in Cosmos.
- Replace a changed skill only after the developer agrees.
- Check every uploaded file in Cosmos after the upload.

## Non-goals

- Organization-wide upload. A developer must not share a skill with everyone by accident.
- Deleting remote files that no longer exist locally. `switch` reports them and leaves them.
- Rules, `AGENTS.md`, and subagent definitions.

## Anti-goals

- Never overwrite a remote file without the developer's agreement.
- Never handle Cosmos credentials. `auggie` owns login.

## Approaches

1. **TypeScript CLI that runs `auggie` (picked).** Good prompts with `@clack/prompts`. `auggie` keeps login, permissions, and conflict checks. `tsc` compiles to `dist/`, so the CLI runs on any Node 22 or later.
2. Python script that runs `auggie`. No dependencies, but the prompts are worse.
3. Direct calls to the Cosmos API. Rejected: `switch` would have to handle tokens.

## Design

`switch [paths...] [--to private|<space name or id>] [--skills a,b] [--replace] [--dry-run] [--yes]`

1. **Scan.** Walk each root, up to depth 5, for folders that contain `SKILL.md`. Skip dot folders and `node_modules`. Resolve symlinks. The same real folder found twice counts once.
2. **Validate.** `SKILL.md` frontmatter needs a `name` of 1 to 64 lowercase letters, digits, or single hyphens, and a `description` of 1 to 1024 characters. Invalid skills are listed with the reason and skipped.
3. **Merge names.** If two folders use one `name`: identical content counts as one skill. Different content makes the developer pick a source. With `--yes`, the first root wins.
4. **Pick.** Skills (multi-select) and the destination. `auggie cloud space list` returns the Spaces and checks login.
5. **Plan.** `auggie cloud vfs files` lists the remote files. For each remote file of a picked skill, `vfs history` gives the latest `seq`, and `vfs checkout` downloads it for a byte compare. Each file is `new`, `same`, or `changed`. Remote files that are not in the local skill are listed as only in Cosmos.
6. **Confirm.** The developer confirms the upload. Changed files need a second, explicit agreement, or `--replace`.
7. **Upload.** New files use `vfs put` with no flags, so `put` fails if the file appeared in the meantime. Changed files use `vfs put --base-seq <latest seq>`, which fails if someone wrote the file after the plan.
8. **Verify.** List the remote files again. For each upload, check that the latest `seq` is the one `put` returned and that the bytes match the local file.

`seq` is a per-filesystem write counter, not a per-file one. `--base-seq` must be the file's latest `seq` from `vfs history`.

## Types

- `SkillName`, `SpaceId`, and `RemotePath` are branded strings. Each comes only from its guard in `src/types.ts`.
- `RemotePath` must start with `.augment/skills/` and must not contain an empty, `.`, or `..` segment. A skill file therefore cannot be written outside the skills folder.
- Plan states, upload results, destinations, and `put` preconditions are discriminated unions on `kind`. Each `switch` ends with a `never` check.

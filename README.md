# switch

`switch` copies agent skills from your laptop into Cosmos. Each skill goes to your private storage or to one Cosmos Space you belong to.

## Before you start

- Install `auggie` and log in with `auggie login`.
- Use Node 22 or later.

## Install

From this repo:

```bash
npm install
npm run build
npm link
```

`npm link` puts `switch` on your PATH. Run `switch --help` to check.

## Upload skills

Run `switch` and answer the prompts:

```bash
switch
```

Pick the skills with space, then press enter. Pick a destination: **Private** for only you, or a Space by name.

`switch` compares each file with Cosmos before it writes anything. A file is **new**, **same**, or **changed**.

To see the plan without uploading, add `--dry-run`:

```bash
switch --dry-run
```

## Upload without prompts

Pass the destination and the skills, then add `--yes`:

```bash
switch --yes --to private --skills pdf-tools,release-notes
```

Skills come from `~/.cursor/skills`, `~/.pi/agent/skills`, and `~/.agents/skills`. Pass more folders after the options to scan them too:

```bash
switch ~/work/team-skills
```

## Replace changed files

A **changed** file is a file in Cosmos whose bytes differ from your copy. `switch` leaves it alone unless you agree to replace it. In a prompt, answer yes to the replace question. Without prompts, add `--replace`:

```bash
switch --yes --replace --to private --skills release-notes
```

## Check the result

After each upload, `switch` reads the file back from Cosmos and compares the bytes. It prints a problem if the file is missing or differs.

## Remove a test skill

`switch` never deletes a file in Cosmos. To remove one, run:

```bash
auggie cloud vfs rm .augment/skills/<skill-name>/SKILL.md --filesystem-id user
```

Repeat for each file in the skill folder.

## Run the tests

```bash
npm test
```

## License

MIT. See `LICENSE`.

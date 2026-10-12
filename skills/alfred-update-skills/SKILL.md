---
name: alfred-update-skills
description: Update the /alfred-* Claude Code skills to the Alfred installed on this machine - shows which version each skill came from, then (on the user's yes) re-installs them for the user and, when the current repo carries its own copy, for that repo. Use after updating Alfred, when a skill looks out of date or a new /alfred-* skill is missing, when the user says "update the Alfred skills", or "/alfred-update-skills".
argument-hint: "[--project <folder>] [--force]"
---

# Alfred update skills

Read `rules.md` in this skill's folder first. Installing replaces files in the user's skills folder (and maybe a
repo): say exactly what you will run and ask before running it. No Alfred MCP tools are needed for this skill.

A native Alfred refreshes the skills of every user who installed them on its own start after an update. This skill
is for everything else: a Docker install or source checkout, a repo's own copy (project scope), or right now without
waiting for a restart.

## 1. Find the installer

- **Native install**: `alfred version` answers (the `alfred` command is on PATH). Use `alfred skill ...`.
- **Source checkout / Docker**: no `alfred` command. Ask for the Alfred checkout folder (the one with
  `alfred_skill.py` and `skills/`) unless the user already said it, then use `python <checkout>/alfred_skill.py ...`
  (`python3` where `python` is missing). Suggest `git pull` in the checkout first when it is a git repo - the skills
  come from that folder as it is.
- Neither: say Alfred is not installed here; the skills of an Alfred on another machine come from its release
  `alfred-skills-<version>.zip` (unzip into `~/.claude/skills/`). Stop.

## 2. What is installed

Run `status` for the user (`alfred skill status`, or `python <checkout>/alfred_skill.py status`). When the current
folder (or `--project <folder>`) has `.claude/skills/alfred-*`, also run `status --project <folder>`.

Show one short table: scope, how many skills, the version they came from (`Alfred 1.4.0`, `Alfred source`), what is
missing, which ones are "present, not from Alfred". Then what install would do: the installed Alfred's version
(`alfred version`; a checkout installs as `source`).

## 3. Ask, then install

Show the exact commands, ask, and on yes run them:

```bash
alfred skill install                       # user: ~/.claude/skills
alfred skill install --project <folder>    # only when that repo has its own copy, or the user asked
```

(or the same with `python <checkout>/alfred_skill.py install ...`). Run them as the user - never with sudo, never in
an Administrator prompt: Claude Code reads the skills of the account that runs it.

- A skill "present, not from Alfred" is **skipped** (exit code 3 natively). Say which; add `--force` only when the
  user says to replace their own folder.
- The retired `/alfred-qa` is removed by install when Alfred put it there.

## 4. Tell the user

- Each line the install printed (installed / updated `old -> new` / skipped / removed).
- **Start a new Claude Code session** (or `/clear`): a running session keeps the skill text it loaded.
- Project scope: the changed files are in that repo - they need a commit to reach the team. Never commit for them.

## Never

Never run install as Administrator or root; never touch another user's home; never use `--force` unasked; never edit
a skill's files by hand instead of installing.

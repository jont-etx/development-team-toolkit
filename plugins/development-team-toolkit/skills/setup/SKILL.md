---
name: setup
description: Guided setup or change of the Development Team Toolkit for this project. Interviews the user one decision at a time (roles, write scopes, review and hot paths, parallel workers, model tiers), writes the project settings, syncs Claude Code and Codex specialists, installs the role guard and verifies it. Use for first-time setup, or to change one part later ("make QA top tier", "add payments as a hot path").
---

# Toolkit setup

Run this in the main session, not in a specialist. Use the directory two levels above this skill as `<plugin-root>`
(in Claude Code also `${CLAUDE_PLUGIN_ROOT}`); run commands from the project root as
`node <plugin-root>/bin/toolkit.mjs <command>`. Read the [workflow](../../toolkit-wiki/workflow.md) and the
role catalog (`roles`) first so recommendations match how the toolkit works.

## 1. Look before asking

Run `status`, `doctor` and `setup scan`. They tell you, without asking the user:

- whether settings exist and where (`status`), and what is already broken or missing (`doctor`);
- the project's main file types, any wiki folder, existing non-toolkit agent files, other Coordinator stores and
  which runtimes are installed (`setup scan`);
- how many files each role's default write scope covers (`roles.<id>.matches`) and paths that look high-stakes
  (`hotPathCandidates`).

If settings already exist, this is a **change run**: read them with `config`, ask only about what the user wants
to change, and skip to step 3 with a before/after diff.

## 2. Interview, one decision at a time

Ask each question on its own and wait for the answer. With each question give your recommended answer, based on
the scan, and its main tradeoff. Never ask what the scan already answered. Keep the user's words; do not invent
requirements. Stop asking once the remaining defaults are fine and say which defaults you kept.

1. **Project identity.** A slug id and title. Where settings live: the project wiki folder if the scan found one
   (settings then follow that wiki's review process), otherwise `.development-team/project.json`.
2. **Which roles to use.** All roles are available; small projects often skip Concept Artist, Release Reviewer or
   Test Engineer. Switch a role off with `roles.<id>.enabled: false`; its generated profiles are then removed and the guard no longer lists it.
3. **Write scopes.** Walk only the writing roles whose default scope fits poorly: a scope with 0 matches, or one
   far wider than the project needs. Propose concrete globs from the scan, such as Designer →
   `web/src/**/*.scss` or Test Engineer → `spec/**`. Recommend keeping reviewers read-only.
4. **Review independence.** Recommend `review.crossFamily: hot-paths` with hot paths from `hotPathCandidates` that
   the user confirms. Offer `always` for high-stakes projects and `off` when only one runtime is used.
5. **Parallel work.** `parallel.maxWorkers` (default 2), and `rolePolicy.linkedWorktreeOnly: true` if writers
   should never touch the primary checkout.
6. **Model tiers.** Keep the catalog tiers unless the user has a reason; per-role `tier` overrides and runtime
   `models` overrides are available. Point to `models check` and `models eval` for evidence-based changes.

## 3. Confirm, then write

Show one summary: the settings JSON you will save (for a change run, a before/after diff) and the commands you will
run. Write nothing until the user confirms. Then:

- Write the settings to a scratch file and run `init <file>` (first run; add `--wiki <path>` when needed) or
  `save <file>` (change run). Fix and re-ask on any validation error; do not loosen values to get past it.
- Run `sync-claude` and `sync-codex` for the runtimes the user uses. If a sync reports a conflicting custom
  profile, stop and ask how to handle it; never overwrite it.
- For Codex, run `install-codex-hooks`, then have the user open Codex in the project, run `/hooks` and trust
  "Checking toolkit role access". Codex silently skips untrusted hooks.

## 4. Verify

Run `doctor` and fix anything it reports, or tell the user exactly what is left. Then run a one-minute live check
in each runtime: ask a reviewer specialist (for example `toolkit-qa-code`) to run one read-only command and then
create a scratch file. The read must work and the write must be blocked by the guard; delete the scratch file if
it was created and report the failure. In Codex the subagent's hook output is not printed by `codex exec`; check
that the file was not created.

## Boundaries

Settings, agent files and hooks change only after the user confirms. If `doctor` or `setup scan` finds another
Coordinator store, say that the toolkit Coordinator will refuse claims until the project deliberately retires
it; do not retire it here. Keep secrets, personal details and credentials out of settings. Re-run this skill any
time to change one part of the setup.

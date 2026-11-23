# Changelog

Releases are tagged `vX.Y.Z`. `node scripts/release.mjs <version>` adds the next entry from the commits since the
last tag.

## 0.9.0 - 2026-11-23

- Write each eval run to its own ledger or checks file

## 0.8.0 - 2026-11-23

- Add eval checks and check-report (improvement loop phase 2)

## 0.7.2 - 2026-11-23

- Accept --evals-dir before or after the eval action and add --task to eval run

## 0.7.1 - 2026-11-23

- Let eval commands keep tasks in another repository with --evals-dir

## 0.7.0 - 2026-11-23

- Document the planned generator, verifier and coach improvement loop
- Add removal challengers to the planned improvement loop
- Add eval harvest, seed, run, outcome and report (improvement loop phase 1)

## 0.6.0 - 2026-11-21

- Add release script, update-installs and handoff gates
- Pass test files explicitly in the release script

## 0.5.0 - 2026-11-21

- Add guided setup skill, setup scan and doctor
- Accept CRLF checkouts in the setup skill test

## 0.4.0 - 2026-11-21

- Add parallel workers with file and contract reservations

## 0.3.0 - 2026-11-21

- Add Test Engineer and Release Reviewer, cross-family review and runtime fallback

## 0.2.0 - 2026-11-21

- Enforce role access with a guard hook in Claude Code and Codex

## 0.1.12 - 2026-11-20

- Add handoff check, local MCP credentials, and models eval

## 0.1.11 - 2026-11-20

- Prune retired profiles and old requests, add supervisor withdraw

## 0.1.10 - 2026-11-20

- Run the Coordinator tool without approval prompts in Codex
- Fetch full history in CI for the legacy-migration test

## 0.1.9 - 2026-11-20

- Ship the Coordinator MCP server from the plugin

## 0.1.8 - 2026-11-20

- Add Claude Code support alongside Codex
- Map roles to model tiers and add model review

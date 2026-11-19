# Development Team Toolkit

A private plugin and project-local specialist setup. The toolkit wiki is kept with the plugin so each release can reproduce its role behavior. Edit the [role catalog](plugins/development-team-toolkit/toolkit-wiki/roles.json) and [workflow](plugins/development-team-toolkit/toolkit-wiki/workflow.md) there. Pin a plugin version or marketplace Git ref for repeatable setup.

## Project setup

Requires Node.js 22+ and a current Codex CLI for the Codex integration. The configuration CLI uses Node's standard library.

1. Run `codex plugin marketplace add <toolkit-checkout>` and `codex plugin add development-team-toolkit@development-team-private`.
2. In the project root, run `node <toolkit-checkout>/plugins/development-team-toolkit/bin/toolkit.mjs status`.
3. Prepare settings with `schemaVersion` set to 1, a slug `id`, a `title`, and any project-specific fields. Run the same CLI with `init <seed.json>`, then `sync-codex`. The resulting project-local agents take their instructions and personalities from the toolkit wiki. The PM runs in the hub.
4. Open the project in Codex and invoke the Development Team plugin. Review the project before running its agents. For project settings changes use `config` to read and `save <settings.json>` to update.

| Environment | Settings location |
| --- | --- |
| No project wiki | `.development-team/project.json` in the project |
| One `.wiki/` or `wiki/` directory in the project | `development-team/project.json` in that wiki |
| Separate wiki checkout or two candidates | Select its path with `init <seed.json> --wiki <path>` |

Wiki initialization records the selected path in `.development-team/wiki.json`. Treat a Git-backed wiki as a checked-out directory and follow its review and publishing process. Commands write to the checkout only. A missing configured wiki blocks settings operations. When adding a wiki to a project with existing local settings, relocate the settings deliberately before initializing the wiki. Keep project decisions, settings, evidence and secret values out of the toolkit wiki. Use your project's secret manager for credentials.

To update roles, use `sync-codex` from the newly pinned toolkit release. The command refreshes unedited generated roles and stops if it finds a conflicting file. It does not write to the user's global Codex setup.

## Verification

Run `node --test tests/toolkit.test.mjs`. The pilot has a separate checkout. The current plugin contains the team workflow and role setup. The Composer visual review and additional host adapters have separate acceptance checks.

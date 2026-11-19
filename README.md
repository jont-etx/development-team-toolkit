# Development Team Toolkit

A Codex plugin for project intake, specialist handoffs, and independent review. Use it in a plain Git repo or in a project with its own wiki. The project manager runs in the hub chat. Native Codex profiles cover interviewing, architecture, design, concept art, development, code QA, UX QA, security review, and coordination.

## Install

You need Git, Node.js 22 or later, and a Codex CLI with `codex plugin` support. Setup has been tested with Codex CLI 0.147.0.

Clone the toolkit alongside the project you want to use it in. The examples use PowerShell and assume your project and the toolkit are sibling folders.

```powershell
git clone https://github.com/jont-etx/development-team-toolkit.git
codex plugin marketplace add ./development-team-toolkit
codex plugin add development-team-toolkit@development-team-private
```

`development-team-private` is the marketplace ID used by version 0.1.0. To reproduce an install, check out a specific toolkit commit before adding the marketplace.

## Set up a project

1. Open a terminal in the **project** root. Create a seed file such as `team-seed.json`:

   ```json
   {
     "schemaVersion": 1,
     "id": "example-project",
     "title": "Example Project",
     "summary": "Describe what this project does."
   }
   ```

2. Run the setup commands from that project root:

   ```powershell
   $toolkit = "../development-team-toolkit/plugins/development-team-toolkit/bin/toolkit.mjs"
   node $toolkit status
   node $toolkit init ./team-seed.json
   node $toolkit sync-codex
   ```

   `init` stores a copy in the project's configured location. After verifying it with `node $toolkit config`, the seed file is optional.

3. Open the project in Codex and select **Development Team Toolkit**. For a first task, try: “Use Development Team Toolkit to scope this change. Ask me for the decision that affects acceptance, then prepare the Developer and independent QA handoffs.”

4. Keep the decision and handoffs in the project. Give the reviewer the same decision and acceptance checks as the Developer, plus the exact candidate to verify. The owner makes the final acceptance decision.

## Project settings and shared roles

| Project setup | Settings file |
| --- | --- |
| No project wiki | `.development-team/project.json` in the project |
| One `.wiki/` or `wiki/` directory in the project | `development-team/project.json` inside that wiki |
| Separate wiki checkout or two wiki candidates | Choose the wiki with `node $toolkit init ./team-seed.json --wiki <path>` |

Wiki setup records the wiki path in `.development-team/wiki.json`. If the selected wiki is unavailable, restore access before updating settings. Wiki commands operate on the checkout and follow the project's own review and publishing process. Keep credentials in your project's secret manager.

| Command | Result |
| --- | --- |
| `node $toolkit status` | Shows the settings location, initialization state, and toolkit role revision |
| `node $toolkit config` | Prints the active project settings |
| `node $toolkit save ./updated-settings.json` | Updates settings in the active store |
| `node $toolkit roles` | Prints the shared roles, personalities, and Codex model mappings |
| `node $toolkit sync-codex` | Creates or refreshes toolkit profiles under `.codex/agents/` and stops on conflicting edits |

The toolkit wiki travels with the plugin. It holds the shared [role catalog](plugins/development-team-toolkit/toolkit-wiki/roles.json) and [workflow](plugins/development-team-toolkit/toolkit-wiki/workflow.md). Project settings, decisions, and evidence belong to the project. To pick up shared role changes, update the toolkit checkout and rerun `sync-codex` from the project.

## Verify

Run `node --test tests/toolkit.test.mjs` from the toolkit checkout. The tests cover local and wiki settings, an unavailable wiki, and preservation of edited agent files.

Version 0.1.0 packages the Codex workflow and native role setup. The Composer visual review and additional host adapters are pending.

## License

The toolkit code, shared role files, workflows, and documentation are licensed under the [Apache License, Version 2.0](LICENSE).

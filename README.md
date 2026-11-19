# Development Team Toolkit

A Codex plugin for project intake, specialist handoffs, and independent review. Use it in a plain Git repo or in a project with its own wiki. The project manager runs in the hub chat. Native Codex profiles cover interviewing, architecture, design, concept art, development, code QA, UX QA, security review, and coordination.

## Install

You need Git, Node.js 22.13 or later, and a Codex CLI with `codex plugin` support. Setup has been tested with Codex CLI 0.147.0.

Clone the toolkit alongside the project you want to use it in. The examples use PowerShell and assume your project and the toolkit are sibling folders.

```powershell
git clone https://github.com/jont-etx/development-team-toolkit.git
codex plugin marketplace add ./development-team-toolkit
codex plugin add development-team-toolkit@development-team-private
```

`development-team-private` is the marketplace ID. To reproduce an install, check out a specific toolkit commit before adding the marketplace.

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

## Coordinate parallel work

The toolkit includes a local Coordinator for each Git clone. All linked worktrees in that clone use the same queue. The queue lives in Git's common directory and works with Node.js 22.13+ without a wiki or a service. Use project handoffs to record the exact base, owned paths, acceptance checks, and next owner.

The Coordinator reserves a whole request at once. Use `file:<repo-relative-path>` for code or directory ownership and agree on one `resource:<name>` for each shared test runner, fixture, or browser session. Overlapping paths and identical resource names wait in request order. Disjoint claims can run together. Claims are cooperative. Git and the filesystem still allow writes by a process that skips the Coordinator.

```powershell
$request = node $toolkit coordinate request worker-a file:src/search resource:browser-qa | ConvertFrom-Json
$request.capability | node $toolkit coordinate claim $request.id
# Start work only once the request is held. If queued, check again at your next checkpoint.
node $toolkit coordinate status
# Stop work and clean up the reserved resources before releasing.
$request.capability | node $toolkit coordinate release $request.id
```

Use an absolute path for `$toolkit` when running from a linked worktree. Capture the request output privately as shown. Keep the capability out of chat, logs, and command arguments. Pipe it into `coordinate cancel <id>` to withdraw queued work. Held claims survive process exit. Every participant must use the Coordinator before touching shared resources. The current queue coordinates one clone on one machine. Separate clones and machines need a single shared authority for common resources.

### Recover a claim or hand off supervision

Before other participants use the Coordinator, the project owner initializes supervision once with `coordinate authority-init`, supplying a fresh random 64-character lowercase hex credential on standard input. Generate credentials locally and store them in a protected location. Send only request IDs and evidence references through chat. Run `coordinate status` to inspect the queue and `coordinate audit` to review supervision changes, recoveries, and cleanup references.

| Situation | Operation |
| --- | --- |
| A queued request lost its credential | Run `coordinate recover <id> <inspection-ref>` with the supervisor credential and a fresh request credential on separate stdin lines. The request keeps its queue position. |
| A held request may still be running or may have left dirty state | Run `coordinate quarantine <id> <reason-ref>` with the supervisor credential on stdin. It still blocks conflicts and its old credential stops working. |
| A quarantined worker has stopped and its fixture cleanup is verified | Run `coordinate recover <id> <stop-ref> [evidence.json]` with the supervisor credential and a fresh request credential on separate stdin lines. The request returns to its original queue position and must claim again. |
| Another supervisor is taking over | Run `coordinate handoff <current-epoch>` with the current and successor supervisor credentials on separate stdin lines. The epoch advances atomically. Active workers keep their own credentials and the queue keeps its order. |

Evidence references identify actual inspection or cleanup records. The CLI records and checks the required references and method names. The supervisor must establish that a worker has stopped and cleanup actually ran before recovery. An uncertain claim stays quarantined. Loss of the supervisor credential requires a separately authorized recovery procedure.

### Project wiki and fixture rules

Add a `coordinator` object to the toolkit project settings. The same schema works with wiki-backed settings or local `.development-team/project.json`.

```json
{
  "coordinator": {
    "fixtures": { "resource:browser-fixture": "reset-fixture" }
  }
}
```

Run `coordinate policy-sync` from the primary project root with the supervisor credential on stdin. Sync before admitting fixture work. The Coordinator pins the rules in its private Git state. A handoff keeps that policy, and changed rules require an empty active queue. If the configured wiki is unavailable, policy sync fails and the last pinned rules still govern claims. For a release or quarantined recovery that holds `resource:browser-fixture`, supply an evidence JSON file like the one below. Repeat the entry for every fixture held by the request.

```json
{"resource:browser-fixture":{"method":"reset-fixture","ref":"evidence/fixture-reset-42"}}
```

Project settings can live in the project wiki. Live grants, credentials, queues, and administrative state stay local. This workflow uses the project wiki's existing review and publication rules.

### Replacing an existing Coordinator

Projects with a live Coordinator keep it as the authority for its existing resources. The clean-repo handoff rotates supervision on the toolkit store. Before a live switch, reconcile active work and queue order, verify environment and fixture enforcement through project adapters, and prove that only one service can grant each shared resource. The project owner approves the live cutover separately.

### Optional CPD v1 compatibility adapter

Run the rehearsal in a disposable Git repository. Copy a consistent CPD v1 snapshot to `.coordinator/state.sqlite3` at the primary checkout root, the path the old CPD Coordinator resolves by default. The adapter uses that same SQLite store directly and retains CPD resource keys and modes, request and lease IDs, sequence, usage, outbox, and work records. It validates the store format and uses a project-provided CPD backend file whose SHA-256 was verified independently. The native toolkit Coordinator refuses to create a second store in that checkout. Projects using the standalone Coordinator still need only Node and Git.

Use `node $toolkit coordinate cpd --project <disposable-root> --backend <trusted-backend.py> --backend-sha256 <digest>` with Python on `PATH`. Supply one JSON packet on stdin. Only the authorized operator sends `{"op":"handoff","authority":"<fresh-64-hex-credential>"}`. On this store, handoff is durable. Older CPD clients cannot write or grant after it, including clients that were already running. The operator keeps the credential private. Subsequent packets use `authority`, `op`, and the existing CPD operation fields. `request` and `item_create` can issue private CPD tokens. Capture their response securely.

For MCP, use the project-controlled Python environment with the `mcp` SDK. Launch `cpd-coordinator-mcp.py` with `python -I -B`, the same project and backend flags, and `--authority-file <absolute-path-in-git-common-dir>`. The file contains the private credential and must be readable only by the service user (use owner-only permissions or ACLs). The stdio server exposes `coordinator_call(operation, payload)` with the existing payload and response structure. The handoff command stays local. To enable `refresh_usage`, also configure a trusted `--weekly-usage <file>` and independently verified `--weekly-usage-sha256 <digest>`. With no adapter, refresh refuses. Verify the telemetry allowance binding before deployment.

This adapter protects writes through older Coordinator clients sharing the same SQLite database. It assumes a trusted local operator and does not guard against an OS owner editing the database or another service still granting from a different copy. A live switch requires an approved MCP configuration change, disabled grant admission against the previous store, and tested recovery. Wiki edits, notification delivery, fixture cleanup, and test eligibility remain with the existing project tools and permissions.

## Verify

Run `node --test tests/*.test.mjs` from the toolkit checkout. The tests cover local and wiki settings, preservation of edited agent files, and coordination, recovery, and handoff in disposable Git worktrees.

The Composer visual review and additional host adapters are pending on this branch.

## License

The toolkit code, shared role files, workflows, and documentation are licensed under the [Apache License, Version 2.0](LICENSE).

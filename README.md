# Development Team Toolkit

A Codex and Claude Code plugin for project intake, specialist handoffs, and independent review. Use it in a plain Git repo or in a project with its own wiki. The project manager runs in the hub chat. Native Codex profiles and Claude Code subagents cover interviewing, architecture, design, concept art, development, code QA, UX QA, security review, and coordination.

## Install

You need Git, Node.js 22.13 or later, and Codex CLI with `codex plugin` support or Claude Code with `claude plugin` support. Setup has been tested with Codex CLI 0.147.0 and Claude Code 2.1.330.

Clone the toolkit alongside the project you want to use it in. The examples use PowerShell and assume your project and the toolkit are sibling folders.

```powershell
git clone https://github.com/jont-etx/development-team-toolkit.git
```

For Codex:

```powershell
codex plugin marketplace add ./development-team-toolkit
codex plugin add development-team-toolkit@development-team-private
```

For Claude Code:

```powershell
claude plugin marketplace add ./development-team-toolkit
claude plugin install development-team-toolkit@development-team-private
```

`development-team-private` is the marketplace ID for both runtimes. Codex reads `.agents/plugins/marketplace.json` and `.codex-plugin/plugin.json`; Claude Code reads `.claude-plugin/marketplace.json` and `.claude-plugin/plugin.json`. Both point at the same skill, role catalog, and scripts. To reproduce an install, check out a specific toolkit commit before adding the marketplace. Add `--scope project` to the Claude Code install to record it in the project's `.claude/settings.json` for everyone who opens the project.

## Set up a project

**Guided setup (recommended).** In Claude Code run `/development-team-toolkit:setup`; in Codex ask for the toolkit's `setup` skill. It scans the repository (`setup scan`), interviews you one decision at a time with a recommended answer for each (roles, write scopes, cross-family review and hot paths, parallel workers, model tiers), shows the settings before writing them, then syncs both runtimes, installs the Codex guard hook and checks everything with `doctor`. Run it again later to change one part; it shows a before/after diff.

**Manual setup.**

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
   node $toolkit sync-codex    # Codex: .codex/agents/toolkit-*.toml
   node $toolkit sync-claude   # Claude Code: .claude/agents/toolkit-*.md
   ```

   Run the sync for each runtime you use. Both read the same role catalog.

   `init` stores a copy in the project's configured location. After verifying it with `node $toolkit config`, the seed file is optional.

3. Open the project in Codex and select **Development Team Toolkit**, or open it in Claude Code, where the `development-team` skill loads from the plugin. For a first task, try: “Use Development Team Toolkit to scope this change. Ask me for the decision that affects acceptance, then prepare the Developer and independent QA handoffs.”

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
| `node $toolkit roles` | Prints the shared roles, personalities, and Codex and Claude Code model mappings |
| `node $toolkit sync-codex` | Creates or refreshes toolkit profiles under `.codex/agents/`, removes unedited profiles for retired roles, and stops on conflicting edits |
| `node $toolkit sync-claude` | Creates or refreshes toolkit subagents under `.claude/agents/`, removes unedited subagents for retired roles, and stops on conflicting edits |
| `node $toolkit models check [--record]` | Compares the Codex model catalog with the models used by tiers and project agent profiles, and flags unavailable or newly offered models |
| `node $toolkit models retarget <codex\|claude> <from> <to>` | Moves hand-written project agent profiles from one model to another after an approved review |
| `node $toolkit worker start <name> <files>... --role <id> [--resource resource:<name>]` | Reserves a worker's files (and named resources) through the Coordinator and creates its linked worktree under `.worktrees/`. `--role` names the writing role it runs as; untyped, unknown or read-only roles are refused |
| `node $toolkit worker status` / `worker finish <name>` | Lists workers; finishes one by refusing undeclared changes, fast-forwarding it into its branch and releasing its reservation |
| `node $toolkit doctor` | Checks Node, settings, generated profiles, the role policy and the Codex hook (installed, current and trusted), with a fix for each problem |
| `node $toolkit setup scan` | Read-only repository scan used by the setup skill: file types, hot-path candidates and how many files each role's default write scope covers |
| `node $toolkit update-installs [--ref <sha>]` | After a release: re-pins Codex to the latest `main` (or the given commit) and refreshes the Codex and Claude Code installs. Close the Codex app first; it locks the old plugin folder |
| `node $toolkit install-codex-hooks` | Installs the role guard as a Codex project hook; trust it once in Codex with `/hooks` |
| `node $toolkit models eval ./eval.json` | Replays frozen tasks for each contender in throwaway worktrees and reports must-pass results per role |
| `node $toolkit handoff check ./handoff.md` | Checks a handoff has a decision, a real base commit, repo-relative owned files, acceptance checks and a next owner that is an enabled role (or the owner); a Security Reviewer handoff must quote its named `trigger:` |
| `node $toolkit usage scan [--since 14d\|YYYY-MM-DD] [--tests <regex>]` | Read-only scan of local Codex and Claude Code transcripts. Separate buckets: agent waits by spawned role and thread (split into child running, no known running child and unknown; wait time includes time children were working), cross-chat waits, identified test and gate runs (`--tests` sets the pattern), unclassified background commands, polling loops, and the model's gap after test calls. The report lists its limits. Nothing leaves the machine |

The toolkit wiki travels with the plugin. It holds the shared [role catalog](plugins/development-team-toolkit/toolkit-wiki/roles.json) and [workflow](plugins/development-team-toolkit/toolkit-wiki/workflow.md). Project settings, decisions, and evidence belong to the project. To pick up shared role changes, update the toolkit checkout and rerun `sync-codex` or `sync-claude` from the project.

Each role names a capability tier, and `modelTiers` in the role catalog maps tiers to models for each runtime. To change a tier for one project, add a `models` object to the project settings, for example `{"models": {"codex": {"top": "<model>"}, "claude": {"strong": "opus"}}}`, save it, and rerun the sync. The [workflow](plugins/development-team-toolkit/toolkit-wiki/workflow.md#model-review) describes how to evaluate a new model before changing a tier.

`models eval` automates the replay. An eval file names at least two contenders, each a command that reads the task prompt on standard input, and a fixed task list:

```json
{
  "runs": 2,
  "contenders": {
    "champion": { "command": ["codex", "exec", "-m", "gpt-6.2-sol", "--sandbox", "workspace-write", "-"] },
    "challenger": { "command": ["claude", "-p", "--model", "opus", "--permission-mode", "acceptEdits"] }
  },
  "tasks": [
    { "id": "search-cache", "role": "developer", "base": "<commit>", "prompt": "<the original handoff>",
      "checks": [["npm", "test"], ["npm", "run", "lint"]], "timeoutSeconds": 1800 }
  ]
}
```

For each task, contender and run, the harness checks out the base commit in a throwaway linked worktree, runs the contender there, runs every check, and removes the worktree. A run passes only when every check exits 0. The report gives pass counts and agent time per contender and role, plus each run's first failed check and changed-file count. Save it with the project's evidence. Contender commands run with your permissions, so write eval files yourself and keep them with the project. On Windows, bare command names such as `codex` or `npm` run through the shell and must use plain arguments; use an absolute executable path otherwise.

Start each handoff from the [handoff template](plugins/development-team-toolkit/toolkit-wiki/handoff-template.md) and run `handoff check` before passing it on. The check exits 1 and lists what to fix.

New initiatives start with the `memo` skill and [memo template](plugins/development-team-toolkit/toolkit-wiki/memo-template.md): a one-page memo from a one-question-at-a-time interview (what, for one real named person, not, done, smallest proof and hook, features), then build and don't-build lists, triage of every new ask, follow-ups, and rounds closed by a Done check. The workflow's [waiting](plugins/development-team-toolkit/toolkit-wiki/workflow.md#waiting), [review tiers](plugins/development-team-toolkit/toolkit-wiki/workflow.md#review-tiers) and [typed spawns](plugins/development-team-toolkit/toolkit-wiki/workflow.md#typed-spawns) sections say how the hub dispatches and waits.

## Role access and the guard

Each role in the catalog has an access level, and a hook enforces it while the specialist runs:

| Field | Values | Meaning |
| --- | --- | --- |
| `access` | `read-only`, `scoped-writer` | Read-only roles cannot change files. Scoped writers may write only paths matching `writeScope`. |
| `shell` | `read-only`, `read-only+unit-tests`, `full` | Which shell commands the role may run. Limited shells allow reading commands such as `rg`, `git diff` and `git log`, plus unit-test runners for `read-only+unit-tests`. |
| `writeScope` | glob list | Paths relative to the Git worktree root, such as `**/*.scss` or `docs/adr/**`. |
| `readTools` | tool names, or `browser` | Extra read tools the role may use. |

Defaults: QA Code, QA UX, Security Reviewer, Release Reviewer and Coordinator are read-only. Test Engineer writes only test files. Interviewer, Architect, Designer and Concept Artist write only their own kinds of files. Developer keeps a full shell and writes anywhere in the worktree. Override any role for one project under `roles` in the project settings (`enabled: false` switches a role off), and set `rolePolicy.linkedWorktreeOnly` to keep writers out of the primary checkout:

```json
{
  "roles": { "designer": { "writeScope": ["web/**/*.scss", "docs/design/**"] }, "qa-code": { "tier": "top" } },
  "rolePolicy": { "linkedWorktreeOnly": true }
}
```

`sync-claude` and `sync-codex` write the policy to `development-team-role-policy.json` in Git's common directory, so every linked worktree shares it, and `sync-claude` adds a tool allowlist to limited Claude profiles. The guard (`bin/role-guard.mjs`) runs before each tool call. It finds the specialist by the `agent_type` both runtimes send, matching `toolkit-designer` and Codex's display name alike. It never blocks the main session or roles the policy does not name, and it refuses any tool a limited role is not known to need.

- **Claude Code:** the plugin installs the guard as a `PreToolUse` hook. Nothing else is needed.
- **Codex:** plugins cannot ship hooks, so run `node $toolkit install-codex-hooks` once per project. It adds the hook to `.codex/hooks.json` and keeps a stable copy of the guard in `.development-team/`, which `sync-codex` refreshes. Then open Codex in the project, run `/hooks` and trust "Checking toolkit role access"; Codex silently skips untrusted hooks and asks again after any change to `hooks.json`.

Limits: Codex ignores `sandbox_mode` in custom agent files (subagents inherit the parent sandbox), so the hook is the lock. `codex exec` does not print hook lines for subagent threads; check the subagent's session file under `~/.codex/sessions`. Full shells and unit-test runners can still run code that writes, and file claims or review still apply to them.

Cross-family review and hot paths live under `review` in the project settings, for example `{"review": {"hotPaths": ["src/billing/**", "migrations/**"]}}`. `crossFamily` is `hot-paths` (default), `always` or `off`. `handoff check` then requires the handoff's Runtime section to name a reviewer from the other runtime than the builder, or a `cross-family review pending` marker when that runtime is unavailable. The [workflow](plugins/development-team-toolkit/toolkit-wiki/workflow.md#review-independence) covers review independence, Test Engineer and Release Reviewer, and how work continues when one runtime is unavailable.

## Measure specialists (improvement loop, phase 1)

Scores come only from checks, planted bugs and real outcomes, never from an agent grading its own work. Tasks live in `.development-team/evals/` (set `evals.dir` in the project settings to keep them elsewhere, such as the project wiki); commit them so scheduled runs can use them. Older single `ledger.jsonl` and `checks.jsonl` files are still read as history. `--evals-dir <dir>` on any `eval` command keeps tasks in another repository, such as a separate wiki checkout, while the code they replay stays in this one.

| Command | Result |
| --- | --- |
| `node $toolkit eval harvest <handoff.md> --accepted <commit> --role <id> [--kind golden\|regression] [--check "<cmd>"]...` | Freezes an accepted handoff as a golden task (or a fixed failure as a regression case): base commit, handoff, owned and changed files, and must-pass checks. Acceptance checks written as `` `command` `` bullets become checks. About one task in five goes to the holdout set. |
| `node $toolkit eval seed <task-id> --patch <file> --file <path> --keyword <word>...` | Plants a known bug (a patch that must apply to the accepted commit) as a review task, by default for `qa-code`. A reviewer passes only if its findings name the file and one of the keywords. |
| `node $toolkit eval run <contenders.json> [--role <id>] [--split train\|holdout\|all]` | Replays tasks for each contender in throwaway worktrees. Golden and regression tasks pass when every check passes and changes stay inside the owned files; seeded tasks pass when the planted bug is found. Each run writes its own file under `ledger/`, so runs recorded on separate branches (such as nightly pull requests) never conflict. |
| `node $toolkit eval outcome <handoff.md> --role <id> --result accepted\|rework\|rejected [--defects <n>] [--version <label>]` | Records how a real handoff went, as one file under `outcomes/` (an older `outcomes.jsonl` is still read). Pass the role's version so the watch window can compare versions. |
| `node $toolkit eval checks [--role <id>] [--task <id>]` | Checks the checks: runs each task's must-pass checks where they should fail (the base commit, and the accepted commit with a planted bug) and where they should pass (the accepted commit). Each run writes its own file under `checks/`. |
| `node $toolkit eval check-report` | Per check: catch rate, false-alarm rate and average time, with a suggestion (earning its place, weak, fix false alarms, too few samples). Also reviewer catch rates on planted bugs and failure states no check caught. List checks that must never be proposed for retirement under `evals.protectedChecks` (command fragments such as `gates.py`). |
| `node $toolkit eval misses --role <id> --version <label>` | Coach input: the training tasks that version missed (with the file and keywords for planted bugs). Holdout misses are only counted, never named, so a challenger cannot be written to fit them. |
| `node $toolkit eval readiness --role <id> --version <label> [--review-day monday] [--today YYYY-MM-DD]` | Whether the coach should propose now. `urgent`: a high-severity task (task field `severity`: high, medium or low) missed on half its runs or more, or a weighted miss rate of 25% or more. `review`: the weekly review day, with misses to fix or, with none, one removal challenger. `wait`: too few runs, only holdout misses, minor misses seen fewer than 4 times, or not yet the review day. |
| `node $toolkit eval compare --role <id> --champion <version> --challenger <version> [--min-runs 2] [--champion-cost <n> --challenger-cost <n>]` | Strict-win test. `promote` only if the challenger has enough runs per task, loses no task the champion always passes and no regression task, and scores higher on both the training and holdout sets, or ties on both at least 10% cheaper (pass charter size as the cost to favor smaller charters). A promote verdict qualifies a pull request; merging it is the promotion. |
| `node $toolkit eval watch --role <id> --promoted <version> --previous <version> --since <YYYY-MM-DD> [--hot] [--handoffs 10] [--days 14]` | Watch window after a promotion. Compares live outcomes of the promoted version since `--since` with the previous version's. `revert` on a clear drop (acceptance 20 points lower, or 0.5 more defects per handoff, over at least 3 handoffs each): at once with `--hot`, otherwise when the window closes. `keep` when it closes without one; `watching` until then. |
| `node $toolkit eval generate <contenders.json> [--role <id>] [--task <id>]` | For judged tasks (prose roles such as interviewer plans, architecture or designs): runs each contender and saves its output under `outputs/<role>/<task>/`, one file per output, without scoring. Can run where no judge is available, such as a scheduled cloud agent. |
| `node $toolkit eval judge <judge.json> --role <id> [--champion <version> --challenger <version>]` | Scores saved outputs blind with a judge command (`{"name": "codex", "command": [...]}`, reading the prompt on standard input and ending with `{"winner": "A"|"B"|"tie", ...}`). Default: each output against the accepted output, passing on a win or tie. With champion and challenger: their outputs are paired, with the accepted output as context only. A/B order is random; each pair is judged once. Use a judge from the other model family. |
| `node $toolkit eval labels export --role <id> [--count 5]` / `eval labels import <answers.json>` | Owner calibration. Export gives a few judged pairs as blind A/B items (the key stays in `label-packs/`); import takes `{"pack": ..., "answers": [{"item": "p1", "choice": "A"|"B"|"tie", "note": ...}]}` and records whether the judge agreed. |
| `node $toolkit eval calibration --role <id>` | Whether the judge is trusted: at least 5 owner labels and 80% agreement over the latest 20. Until then `eval compare` returns `judge-not-calibrated` and `eval readiness` waits for any role with judged tasks. |
| `node $toolkit eval report [--role <id>]` | Task counts per role, kind and split; pass rates per contender and version; live outcomes per version. |

A judged task has `kind: "judged"`, a `prompt` (the brief), a `rubric` path inside the evals folder and the accepted output as `reference` text.

Rows from an agent that never started are flagged `agentError` and left out of every score instead of counting as a miss.

A contenders file names each version and the command that runs it, with the task prompt on standard input: `{"runs": 2, "contenders": {"champion": {"command": ["claude", "-p", "--agent", "toolkit-qa-code"], "version": "v1"}, "challenger": {"command": ["..."], "version": "v2"}}}`.

## Coordinate parallel work

For several specialists on one task, use the [parallel workers](plugins/development-team-toolkit/toolkit-wiki/workflow.md#parallel-workers) procedure: `worker start` gives each worker its own worktree and Coordinator reservation, `worker finish` checks and merges it, and `parallel.maxWorkers` in the project settings caps how many run at once (default 2).

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

### Coordinator MCP server

MCP is the tool interface Codex and Claude Code use to call the Coordinator. The plugin ships the server, so installing the plugin is the only setup: no Python, no per-project registration, and nothing to repair when the plugin updates. It runs on the same Node.js as the CLI, and the MCP server and local CLI call the same queue.

The tool is `coordinator_call`. Codex starts plugin servers in the plugin folder, so pass `project` as the absolute path of the Git checkout you are working in. Claude Code tells the server its project directory, so `project` is optional there. The tool supports `status`, `request`, `claim`, `release` and `cancel`. Codex runs it without an approval prompt because it only changes the local queue for the checkout it is given; remove `default_tools_approval_mode` from the plugin's `.codex-mcp.json` to require approval. Use the local CLI for supervision and policy sync. Agents handle only request IDs: the server keeps each request's private credential in a file under Git's common directory (`development-team-credentials/<id>`), uses it for `claim`, `release` and `cancel`, and deletes it on release or cancel. After a supervisor `recover`, pass the newly issued credential as `capability`; recovery credentials are issued through the CLI and stay out of the stored files.

Projects with an existing Coordinator store at `.coordinator/state.sqlite3` keep their designated Coordinator: the toolkit's server and CLI refuse to grant claims there. Earlier toolkit versions offered `coordinate mcp install`; remove any `development-team-coordinator` entry it added to `.codex/config.toml` or `.mcp.json`.

`coordinate status` shows when each request was made and claimed, plus `age_seconds` in its current state, so a stalled holder or an abandoned queued request stands out. Requests created before toolkit 0.1.9 show no times. Released and cancelled requests leave the queue a week after they were made, the next time someone files a request; `coordinate audit` keeps their release, cancel and withdrawal history.

### Recover a claim or hand off supervision

Before other participants use the Coordinator, the project owner initializes supervision once with `coordinate authority-init`, supplying a fresh random 64-character lowercase hex credential on standard input. Generate credentials locally and store them in a protected location. Send only request IDs and evidence references through chat. Run `coordinate status` to inspect the queue and `coordinate audit` to review supervision changes, recoveries, and cleanup references.

| Situation | Operation |
| --- | --- |
| A queued request lost its credential | Run `coordinate recover <id> <inspection-ref>` with the supervisor credential and a fresh request credential on separate stdin lines. The request keeps its queue position. |
| A queued request is abandoned and nobody will claim it | Run `coordinate withdraw <id> <reason-ref>` with the supervisor credential on stdin. The request is cancelled in one step and later requests move up. |
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

Keep project profiles, compatibility adapters, and their deployment instructions in the owning project’s local configuration. The public toolkit provides the standalone Coordinator and its MCP setup.

## Releases

Maintainers cut a release with `node scripts/release.mjs <version>`. It refuses a dirty tree, runs the tests, bumps the version in both plugin manifests and the role catalog, adds a [CHANGELOG](CHANGELOG.md) entry from the commits since the last tag, then commits and tags `v<version>`. Push with `git push origin HEAD:main --follow-tags`, then run `update-installs` on each machine. `--dry-run` shows the entry without changing anything.

## Verify

Run `node --test tests/*.test.mjs` from the toolkit checkout. The tests cover local and wiki settings, Codex profiles and Claude Code subagents, preservation of edited agent files, and coordination, recovery, and handoff in disposable Git worktrees.

The tests also drive the plugin's MCP server over stdio and check that it shares the CLI queue. GitHub Actions runs the suite on Linux and Windows with Node.js 22.13 and 24 on every push.

The Composer visual review and additional host adapters are pending on this branch.

## License

The toolkit code, shared role files, workflows, and documentation are licensed under the [Apache License, Version 2.0](LICENSE).

# Development Team workflow

The hub holds the PM role. Start with the project's outcome, owner, scope and acceptance checks. Use the Interviewer to resolve material unknowns. Route architecture, design, concept and implementation to their specialists as needed.

Read project configuration through the toolkit. Treat project notes, wiki pages and attachments as project evidence. Shared role behavior comes from this toolkit wiki and remains subject to the user's instructions and host permissions.

Create a handoff from the [handoff template](handoff-template.md) with a stable decision ID, the approved choice and its evidence, unresolved items, owned files, base revision, acceptance checks and next owner. Run `handoff check <file>` and fix what it lists before passing the handoff on. For visual review, include the asset revision, precise region, section profile revision and the user's annotation when provided. Keep these records with the project.

## Review independence

Reviewers (QA Code, QA UX, Security Reviewer, Release Reviewer) are read-only. They rely on the Developer's test or gate evidence for the exact candidate and rerun unit tests only to probe a suspected defect; full suites stay with the project's own gate or CI.

Work on the project's hot paths gets QA Code or Security review from the other model family: Codex-built work is reviewed in Claude Code and the reverse. Projects list hot paths under `review.hotPaths` (globs), or set `review.crossFamily` to `always` or `off`; the default applies it to hot paths only. Each handoff names `built:` and `reviewed:` runtimes in its Runtime section, and `handoff check` refuses a hot-path handoff without a cross-family reviewer. Hot-path work starts with Test Engineer tests written from the acceptance checks; the Developer does not weaken or delete them without QA Code sign-off. Every release candidate gets a Release Reviewer go before the owner approves the push or deploy. `handoff check` enforces both through the handoff's Gates section: hot-path work needs `tests first: <evidence>` (unless the handoff goes to the Test Engineer), and a handoff marked `release: yes` needs `release reviewer: go <evidence>`.

## When a runtime is unavailable

Claude Code or Codex may run out of usage, hit a limit mid-task or be unavailable. That must not stop the work: the available runtime takes over the same task, claim and handoff.

1. Confirm the stopped agent has stopped, then make its work safe: keep verified commits, save uncommitted or unverified edits as a WIP commit on a side branch or a patch file, roll the worktree back to the last verified commit, release or cancel its Coordinator requests by request ID (both runtimes share the credential store), and restore any shared fixture it touched.
2. Continue with the same role in the available runtime, inside that role's access. Nobody widens scope to cover the gap.
3. If the required cross-family review cannot run, a same-family review in a fresh context is allowed. Mark the handoff `cross-family review pending: <runtime> unavailable`; `handoff check` accepts it with a warning. Before release, run the cross-family review or have the owner accept the degraded one.
4. Report which runtime stopped, what was preserved or rolled back, and which gates are degraded.

When both runtimes are at their usage reserve, pause at a safe checkpoint instead.

## Parallel workers

The hub may run several specialists at once on one task, up to the project's `parallel.maxWorkers` (default 2; the hub is not counted).

1. **Split by files.** Give each worker files or directories no other worker touches. Files every part would change (version numbers, import or registry lists, shared data IDs) stay with the hub and change after the workers merge. If a split needs the same file twice, run those parts in sequence.
2. **Start each worker** with `worker start <name> <files>...`. It reserves exactly those paths through the Coordinator and creates a linked worktree on branch `worker/<name>`. Overlapping workers queue in request order; rerun `worker start <name>` to retry a queued one.
3. **Reserve shared contracts too.** When a worker changes something another area depends on (a shared model, API, schema or template), add `--resource resource:contract-<name>`. Anyone else changing that contract queues behind it, while work that only uses the contract continues.
4. **Hand off and dispatch together.** Write each worker's handoff (owned files = its declared files) and check it, then start the specialists in the same turn, each told its worktree path. Workers edit and commit only in their own worktree; the role guard keeps them inside their write scope.
5. **Integrate in order.** `worker finish <name>` refuses uncommitted work and any changed file the worker did not declare. It merges by fast-forward only, then releases the reservation and removes the worktree. When the target branch has moved on, rebase the worker as the message says, rerun its checks, and finish again. After all workers merge, the hub makes the shared-file changes and sends the combined result to a fresh QA review.
6. **Failures stay visible.** A blocked or failed worker keeps its worktree, branch and reservation for review. Do not delete them without the owner.

File reservations stop two workers editing the same files. They cannot see semantic clashes in different files, such as duplicate IDs, routes or incompatible dependencies, so tests and review still apply.

## Improvement loop

Phase 1 (measurement: `eval harvest`, `eval seed`, `eval run`, `eval outcome`, `eval report`) and phase 2 (checking the checks: `eval checks`, `eval check-report`) are available, and so are the coach's tools: `eval misses` (training misses only), `eval readiness` (propose now, at the weekly review, or keep collecting) and `eval compare` (the strict-win test) and `eval watch` (keep or revert after a promotion, from live `eval outcome` records). Phase 3 adds judged roles: `eval generate` saves outputs, `eval judge` scores them blind with a judge from the other model family, and `eval labels` plus `eval calibration` keep judged scores out of promotions until the judge agrees with the owner's blind labels. The coach itself is a scheduled agent each project writes around these; see the README.

Specialists improve without grading their own work. A **generator** is a specialist at a given role version, a **verifier** is a read-only scorer, and a **coach** proposes changed role versions (challengers) and compares them with the current one (champion). Planned design:

- **Ground truth from outside the loop.** Golden tasks frozen from owner-accepted work decide pass or fail. Seeded defects show whether reviewers and checks catch planted bugs. Real outcomes (rework, defects found later, owner rejections) break ties over time. Every failure in real work becomes a permanent regression case.
- **Verifier.** Deterministic checks first; a model judge only for subjective roles, with a rubric, blind comparison and the other model family. The judge counts only while it agrees with the owner's weekly blind labels. The coach can never edit the verifier, the task sets, or any role's write scope, shell or gates.
- **Promotion.** A challenger replaces the champion only if it passes every hard gate the champion passes, regresses on no regression case, and scores better on both a training and a holdout set over repeated runs. Promotions and reverts are pull requests the owner merges; every version and score is kept, and a promotion that does worse in real work is reverted.
- **Removal challengers.** The coach also tests taking things out: a skill, an instruction block, an example or a guidance rule. Ties go to the simpler version, and a removal is allowed only if the role still passes the regression case that part was added to fix. After a model change, a bare-role control (purpose, done criteria and safety rules only) shows how much the scaffolding still adds. The role itself never changes, and safety limits (write scope, shell, gates, hot-path and security checks) are never removal-tested; loosening them stays an owner decision.
- **Checking the checks.** A check report shows each check's catch rate on seeded defects, false alarms, cost and escaped bugs it would have caught, so weak checks can be retired and missing ones added.
- **Cadence and budget.** The coach runs nightly from the repositories for roles with new evidence, capped per night and paused near the usage reserve. Projects supply their own role source, hard checks, hot paths and task sets.

## Local Coordinator

Choose one reservation authority for each shared resource. Use the toolkit's local Coordinator for a standalone clone. Where an existing project service owns shared resources, use that service until ownership is deliberately transferred. Never grant the same resource through both. Split independent work by repo-relative paths and run it in linked Git worktrees.

From the project root or linked worktree, capture `node <plugin-root>/bin/toolkit.mjs coordinate request <owner> file:<repo-relative-path> resource:<name>` in a shell variable or protected local store so its output never enters the tool transcript. Surface only the request ID and state. Pass the ID to `coordinate claim <id>` and pipe the capability to its standard input. Start only once the request is held. Use `coordinate status` to inspect the queue. Pipe the capability into `coordinate release <id> [evidence.json]` after the worker stops and cleanup is verified, or into `coordinate cancel <id>` for work still queued. Keep the capability in a protected location until release or cancellation.

Only a designated supervisor may rotate supervision, quarantine a held claim, recover a lost capability, or withdraw an abandoned queued request. Quarantine keeps conflicting work blocked. Verify stop and fixture cleanup before recovery, then rotate the request credential and let the request claim again. Keep fixture definitions in project settings and sync from the configured project root. Wiki-backed settings use the project's existing wiki controls. Keep the live queue and credentials in private local state.

Each specialist is held to its role's access by a hook: reviewers are read-only and writers stay inside their write scope. Hand anything outside a role's scope to its owner rather than working around the guard. Send the exact candidate and original acceptance checks to a fresh QA context. Run Security review on changes to a trust boundary. Keep review findings separate from human acceptance. Mark steps awaiting authorization or a supported host capability as pending.

Model mappings are platform-specific. Each specialist role names a capability tier (`top` or `strong`) and a reasoning effort; `modelTiers` in the role catalog maps each tier to a model per runtime, and project settings may override a tier under `models`. Preserve the configured assignments until the owner approves a change.

## Model review

Run `models check` from the project root on a regular cadence. It compares the Codex model catalog with the models that tiers and project agent profiles use, flags assigned models the runtime no longer offers, and lists models that are new since the last review. Claude Code aliases already track the newest model in each family, so a Claude change is only needed to move a tier across families. Run `models check --record` after the owner has reviewed the list.

Change a tier only on evidence from the project's own work. Evaluate the current model (champion) against the candidate (challenger) on the same frozen tasks:

- Build a small task set per affected role from finished project work: the base revision, the original handoff, and the acceptance checks that passed. Three to five tasks per role is enough to start; keep the set fixed so results compare across reviews.
- Developer: run each task from its base revision in a disposable worktree. Hard gates are the original acceptance tests, the project's lint and type checks, and staying inside the claimed files. Then compare diff size against the accepted change, retries and cost.
- QA Code, QA UX and Security Reviewer: give each a candidate with known defects, taken from real past findings. Score defects found, false positives and evidence quality.
- Interviewer, Architect, Designer and Concept Artist: produce the deliverable for each task and have it judged blind and pairwise against the champion's output with a written rubric, preferably by a model from another family, with an owner spot check.
- Run every task at least twice per model; single runs are noisy.

`models eval <eval.json>` runs the Developer part of this: it replays each frozen task per contender in a throwaway worktree, runs the must-pass checks, and reports pass counts per role. Score review and judged roles from their outputs as described above.

The challenger wins only when it passes every hard gate the champion passes and is better on the role's scores, or equal at clearly lower cost or time. Record the scores, cost and decision as project evidence. After owner approval, update the project `models` settings and rerun `sync-codex` or `sync-claude`; use `models retarget <runtime> <from> <to>` for hand-written project profiles. If a mapped model is unavailable, pause that assignment and surface it. If a required mapped model is unavailable, pause that assignment and surface the unavailable mapping.

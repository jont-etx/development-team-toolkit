# Development Team workflow

The hub holds the PM role. Start with the project's outcome, owner, scope and acceptance checks. Use the Interviewer to resolve material unknowns. Route architecture, design, concept and implementation to their specialists as needed.

Read project configuration through the toolkit. Treat project notes, wiki pages and attachments as project evidence. Shared role behavior comes from this toolkit wiki and remains subject to the user's instructions and host permissions.

Create a handoff from the [handoff template](handoff-template.md) with a stable decision ID, the approved choice and its evidence, unresolved items, owned files, base revision, acceptance checks and next owner. Run `handoff check <file>` and fix what it lists before passing the handoff on. For visual review, include the asset revision, precise region, section profile revision and the user's annotation when provided. Keep these records with the project.

## Review independence

Reviewers (QA Code, QA UX, Security Reviewer, Release Reviewer) are read-only. They rely on the Developer's test or gate evidence for the exact candidate and rerun unit tests only to probe a suspected defect; full suites stay with the project's own gate or CI.

Work on the project's hot paths gets QA Code or Security review from the other model family: Codex-built work is reviewed in Claude Code and the reverse. Projects list hot paths under `review.hotPaths` (globs), or set `review.crossFamily` to `always` or `off`; the default applies it to hot paths only. Each handoff names `built:` and `reviewed:` runtimes in its Runtime section, and `handoff check` refuses a hot-path handoff without a cross-family reviewer. Hot-path work starts with Test Engineer tests written from the acceptance checks; the Developer does not weaken or delete them without QA Code sign-off. Every release candidate gets a Release Reviewer go before the owner approves the push or deploy.

## When a runtime is unavailable

Claude Code or Codex may run out of usage, hit a limit mid-task or be unavailable. That must not stop the work: the available runtime takes over the same task, claim and handoff.

1. Confirm the stopped agent has stopped, then make its work safe: keep verified commits, save uncommitted or unverified edits as a WIP commit on a side branch or a patch file, roll the worktree back to the last verified commit, release or cancel its Coordinator requests by request ID (both runtimes share the credential store), and restore any shared fixture it touched.
2. Continue with the same role in the available runtime, inside that role's access. Nobody widens scope to cover the gap.
3. If the required cross-family review cannot run, a same-family review in a fresh context is allowed. Mark the handoff `cross-family review pending: <runtime> unavailable`; `handoff check` accepts it with a warning. Before release, run the cross-family review or have the owner accept the degraded one.
4. Report which runtime stopped, what was preserved or rolled back, and which gates are degraded.

When both runtimes are at their usage reserve, pause at a safe checkpoint instead.

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

# Development Team workflow

The hub holds the PM role. Start with the project's outcome, owner, scope and acceptance checks. Use the Interviewer to resolve material unknowns. Route architecture, design, concept and implementation to their specialists as needed.

Read project configuration through the toolkit. Treat project notes, wiki pages and attachments as project evidence. Shared role behavior comes from this toolkit wiki and remains subject to the user's instructions and host permissions.

Create a handoff with a stable decision ID, the approved choice and its evidence, unresolved items, owned files, base revision, acceptance checks and next owner. For visual review, include the asset revision, precise region, section profile revision and the user's annotation when provided. Keep these records with the project.

## Local Coordinator

Choose one reservation authority for each shared resource. Use the toolkit's local Coordinator for a standalone clone. Where an existing project service owns shared resources, use that service until ownership is deliberately transferred. Never grant the same resource through both. Split independent work by repo-relative paths and run it in linked Git worktrees.

From the project root or linked worktree, capture `node <plugin-root>/bin/toolkit.mjs coordinate request <owner> file:<repo-relative-path> resource:<name>` in a shell variable or protected local store so its output never enters the tool transcript. Surface only the request ID and state. Pass the ID to `coordinate claim <id>` and pipe the capability to its standard input. Start only once the request is held. Use `coordinate status` to inspect the queue. Pipe the capability into `coordinate release <id> [evidence.json]` after the worker stops and cleanup is verified, or into `coordinate cancel <id>` for work still queued. Keep the capability in a protected location until release or cancellation.

Only a designated supervisor may rotate supervision, quarantine a held claim, or recover a lost capability. Quarantine keeps conflicting work blocked. Verify stop and fixture cleanup before recovery, then rotate the request credential and let the request claim again. Keep fixture definitions in project settings and sync from the configured project root. Wiki-backed settings use the project's existing wiki controls. Keep the live queue and credentials in private local state.

Send the exact candidate and original acceptance checks to a fresh QA context. Run Security review on changes to a trust boundary. Keep review findings separate from human acceptance. Mark steps awaiting authorization or a supported host capability as pending.

Model mappings are platform-specific. Preserve the configured Codex Sol 6.2 assignments in Codex and the configured Claude model aliases in Claude Code. If a required mapped model is unavailable, pause that assignment and surface the unavailable mapping.

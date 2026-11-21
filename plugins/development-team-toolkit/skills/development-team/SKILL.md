---
name: development-team
description: Set up or run a project interview, specialist assignment, handoff, or independent review using the Development Team Toolkit.
---

# Development Team

Read [the workflow](../../toolkit-wiki/workflow.md) and [role catalog](../../toolkit-wiki/roles.json) from this plugin version. The role catalog holds team-wide responsibilities and personalities. Project configuration supplies project context.

From the project root, run `node <plugin-root>/bin/toolkit.mjs status` to locate its configuration. Use the directory two levels above this skill as the plugin root (in Claude Code this is also `${CLAUDE_PLUGIN_ROOT}`). If uninitialized, or the user wants to change the setup, use the [setup skill](../setup/SKILL.md); run `doctor` to check an existing setup. A configured or detected project wiki is the settings store; a project without a wiki uses its local settings. Save settings only when authorized using `save <project.json>`. A configured wiki that cannot be accessed blocks the update.

The PM runs in the current hub. For authorized native specialist work, use the project-local `toolkit-*` specialists. In Codex they are custom agents under `.codex/agents/`; run `sync-codex` to materialize them if needed. In Claude Code they are subagents under `.claude/agents/`; run `sync-claude` to materialize them if needed, and dispatch them with the Agent tool. A hook enforces each role's access (reviewers read-only, writers limited to their write scope); in Codex, run `install-codex-hooks` once and have the user trust it with `/hooks`. Identify the exact candidate, current role, evidence, and approval boundary before handing work to the next specialist. Write handoffs from [the handoff template](../../toolkit-wiki/handoff-template.md) and run `handoff check <file>` before dispatch. Record which roles actually ran. Keep pending reviews and owner decisions visible.

For parallel work on one task, follow [parallel workers](../../toolkit-wiki/workflow.md#parallel-workers): `worker start <name> <files>...` per worker, dispatch together, then `worker finish` in order. Before dispatching parallel work, identify overlapping files and shared resources. Follow the project's designated reservation authority. For a standalone clone, use the [Coordinator commands in the workflow](../../toolkit-wiki/workflow.md#local-coordinator). Dispatch only after the full request is held. Keep capabilities out of transcripts.

The plugin ships the Coordinator MCP tool `coordinator_call`; pass `project` as the absolute path of the current Git checkout. It keeps request credentials in local Git state, so pass only request IDs to `claim`, `release` and `cancel`. If the project already has its own Coordinator, follow that authority and the project's handoff process instead.

For model reviews, run `node <plugin-root>/bin/toolkit.mjs models check` from the project root, use `models eval <eval.json>` to replay frozen tasks, and follow the [model review workflow](../../toolkit-wiki/workflow.md#model-review). Change tiers or retarget profiles only after the owner approves the evaluation result.

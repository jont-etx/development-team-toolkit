---
name: development-team
description: Set up or run a project interview, specialist assignment, handoff, or independent review using the Development Team Toolkit.
---

# Development Team

Read [the workflow](../../toolkit-wiki/workflow.md) and [role catalog](../../toolkit-wiki/roles.json) from this plugin version. The role catalog holds team-wide responsibilities and personalities. Project configuration supplies project context.

From the project root, run `node <plugin-root>/bin/toolkit.mjs status` to locate its configuration. Use the directory two levels above this skill as the plugin root (in Claude Code this is also `${CLAUDE_PLUGIN_ROOT}`). If uninitialized, confirm the project's identity, then use `init <seed.json>`. A configured or detected project wiki is the settings store; a project without a wiki uses its local settings. Save settings only when authorized using `save <project.json>`. A configured wiki that cannot be accessed blocks the update.

The PM runs in the current hub. For authorized native specialist work, use the project-local `toolkit-*` specialists. In Codex they are custom agents under `.codex/agents/`; run `sync-codex` to materialize them if needed. In Claude Code they are subagents under `.claude/agents/`; run `sync-claude` to materialize them if needed, and dispatch them with the Agent tool. Identify the exact candidate, current role, evidence, and approval boundary before handing work to the next specialist. Record which roles actually ran. Keep pending reviews and owner decisions visible.

Before dispatching parallel work, identify overlapping files and shared resources. Follow the project's designated reservation authority. For a standalone clone, use the [Coordinator commands in the workflow](../../toolkit-wiki/workflow.md#local-coordinator). Dispatch only after the full request is held. Keep capabilities out of transcripts.

For Coordinator MCP setup, run `node <plugin-root>/bin/toolkit.mjs coordinate mcp status` from the primary checkout root. In Claude Code, add `--runtime claude` to both commands so detection and installation use `.mcp.json` and Claude Code's user config. When the user requests registration and status shows an available standalone setup, run `coordinate mcp install --python <executable>` through the same toolkit command with an MCP-enabled Python environment. Follow any existing Coordinator registration and the project's handoff process.

For model reviews, run `node <plugin-root>/bin/toolkit.mjs models check` from the project root and follow the [model review workflow](../../toolkit-wiki/workflow.md#model-review). Change tiers or retarget profiles only after the owner approves the evaluation result.

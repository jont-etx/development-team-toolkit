---
name: development-team
description: Set up or run a project interview, specialist assignment, handoff, or independent review using the Development Team Toolkit.
---

# Development Team

Read [the workflow](../../toolkit-wiki/workflow.md) and [role catalog](../../toolkit-wiki/roles.json) from this plugin version. The role catalog holds team-wide responsibilities and personalities. Project configuration supplies project context.

From the project root, run `node <plugin-root>/bin/toolkit.mjs status` to locate its configuration. Use the directory two levels above this skill as the plugin root. If uninitialized, confirm the project's identity, then use `init <seed.json>`. A configured or detected project wiki is the settings store; a project without a wiki uses its local settings. Save settings only when authorized using `save <project.json>`. A configured wiki that cannot be accessed blocks the update.

The PM runs in the current hub. For authorized native specialist work, use the project-local `toolkit-*` custom agents. Run `sync-codex` to materialize them if needed. Identify the exact candidate, current role, evidence, and approval boundary before handing work to the next specialist. Record which roles actually ran. Keep pending reviews and owner decisions visible.

Before dispatching parallel work, identify overlapping files and shared resources. Follow the project's designated reservation authority. For a standalone clone, use the [Coordinator commands in the workflow](../../toolkit-wiki/workflow.md#local-coordinator). Dispatch only after the full request is held. Keep capabilities out of transcripts.

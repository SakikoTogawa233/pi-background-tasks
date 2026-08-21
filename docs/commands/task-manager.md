---
doc_id: commands/task-manager
audience: user
mode: mixed
review_policy: contract
stability: stable
covers_surfaces: [command:bg-tasks, command:tasks]
covers_sources: []
---
# Task manager commands

`/tasks` and `/bg-tasks` open the same focused overlay for shell and external tasks.

<!-- pi-docs:begin name="command-contract-tasks-bg-tasks" generator="scripts/docs/generate.mjs" -->
| Command | Description | Provenance |
| --- | --- | --- |
| `/tasks` | Open the Claude-like background task manager UI | `src/extension.ts:544` |
| `/bg-tasks` | Open the background task manager UI | `src/extension.ts:552` |
<!-- pi-docs:end name="command-contract-tasks-bg-tasks" -->

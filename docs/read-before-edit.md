---
doc_id: read-before-edit
audience: agent
mode: generated
review_policy: contract
stability: stable
covers_surfaces: []
covers_sources: []
---
# Read before editing production sources

Every production file under `src/**` and `extensions/**` has exactly one primary behavioral documentation owner. This file is generated from authored ownership frontmatter and owns no production source itself.

## Source ownership

| Source | Primary behavioral owner |
| --- | --- |
| `extensions/background-tasks.ts` | [subsystems/host-ui](./subsystems/host-ui.md) |
| `src/core/common.ts` | [subsystems/background-task-runtime](./subsystems/background-task-runtime.md) |
| `src/core/durable-fs.ts` | [subsystems/durability-and-safety](./subsystems/durability-and-safety.md) |
| `src/core/extension-api.ts` | [api/eventbus-v1](./api/eventbus-v1.md) |
| `src/core/foreground-bash.ts` | [subsystems/background-task-runtime](./subsystems/background-task-runtime.md) |
| `src/core/registry.ts` | [subsystems/background-task-runtime](./subsystems/background-task-runtime.md) |
| `src/core/update-check.ts` | [subsystems/host-ui](./subsystems/host-ui.md) |
| `src/core/windows-taskkill.ts` | [subsystems/background-task-runtime](./subsystems/background-task-runtime.md) |
| `src/extension.ts` | [subsystems/host-ui](./subsystems/host-ui.md) |
| `src/ui/background-tasks-manager.ts` | [subsystems/host-ui](./subsystems/host-ui.md) |

## Public surfaces

- `command:bg`
- `command:bg-clear`
- `command:bg-tasks`
- `command:bg-update`
- `command:jobs`
- `command:kill`
- `command:logs`
- `command:tasks`
- `eventbus:background-task-v1`
- `eventbus:external-task-v2`
- `renderer:background-task-notification`
- `shortcut:ctrl+alt+c`
- `shortcut:ctrl+b`
- `shortcut:shift+down`
- `tool:bash`
- `tool:bg_kill`
- `tool:bg_logs`
- `tool:bg_run`
- `tool:bg_status`

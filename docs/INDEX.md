---
doc_id: INDEX
audience: user
mode: generated
review_policy: contract
stability: stable
covers_surfaces: []
covers_sources: []
---
# Documentation index

Generated navigation for every package-local documentation page. This index intentionally owns no public surface and no production source; ownership is explicit in each primary doc's frontmatter.

## Start here

- [Getting started](./getting-started.md)
- [Choose a workflow](./choose-a-workflow.md)
- [Read before editing production sources](./read-before-edit.md)
- [Runtime contracts](./reference/runtime-contracts.md)

## Docs by audience

### agent

| Doc | Mode | Review | Stability |
| --- | --- | --- | --- |
| [concepts/completion-delivery](./concepts/completion-delivery.md) | authored | contract | stable |
| [read-before-edit](./read-before-edit.md) | generated | contract | stable |
| [tools/bg_kill](./tools/bg_kill.md) | mixed | contract | stable |
| [tools/bg_logs](./tools/bg_logs.md) | mixed | contract | stable |
| [tools/bg_run](./tools/bg_run.md) | mixed | contract | stable |
| [tools/bg_status](./tools/bg_status.md) | mixed | contract | stable |

### maintainer

| Doc | Mode | Review | Stability |
| --- | --- | --- | --- |
| [api/eventbus-v1](./api/eventbus-v1.md) | mixed | behavioral | stable |
| [operations/configuration](./operations/configuration.md) | authored | contract | stable |
| [operations/releasing](./operations/releasing.md) | authored | contract | stable |
| [operations/testing](./operations/testing.md) | authored | contract | stable |
| [operations/troubleshooting](./operations/troubleshooting.md) | authored | contract | stable |
| [reference/runtime-contracts](./reference/runtime-contracts.md) | mixed | contract | stable |
| [subsystems/background-task-runtime](./subsystems/background-task-runtime.md) | authored | behavioral | stable |
| [subsystems/docs-freshness-gate](./subsystems/docs-freshness-gate.md) | mixed | contract | stable |
| [subsystems/durability-and-safety](./subsystems/durability-and-safety.md) | authored | behavioral | stable |
| [subsystems/host-ui](./subsystems/host-ui.md) | authored | behavioral | stable |

### user

| Doc | Mode | Review | Stability |
| --- | --- | --- | --- |
| [choose-a-workflow](./choose-a-workflow.md) | authored | contract | stable |
| [commands/bg](./commands/bg.md) | mixed | contract | stable |
| [commands/bg-clear](./commands/bg-clear.md) | mixed | contract | stable |
| [commands/bg-update](./commands/bg-update.md) | mixed | contract | stable |
| [commands/jobs](./commands/jobs.md) | mixed | contract | stable |
| [commands/kill](./commands/kill.md) | mixed | contract | stable |
| [commands/logs](./commands/logs.md) | mixed | contract | stable |
| [commands/task-manager](./commands/task-manager.md) | mixed | contract | stable |
| [getting-started](./getting-started.md) | authored | contract | stable |
| [INDEX](./INDEX.md) | generated | contract | stable |
| [reference/shortcuts-and-dock](./reference/shortcuts-and-dock.md) | mixed | contract | stable |

## Docs by category

- **api**: [api/eventbus-v1](./api/eventbus-v1.md)
- **commands**: [commands/bg](./commands/bg.md), [commands/bg-clear](./commands/bg-clear.md), [commands/bg-update](./commands/bg-update.md), [commands/jobs](./commands/jobs.md), [commands/kill](./commands/kill.md), [commands/logs](./commands/logs.md), [commands/task-manager](./commands/task-manager.md)
- **concepts**: [concepts/completion-delivery](./concepts/completion-delivery.md)
- **operations**: [operations/configuration](./operations/configuration.md), [operations/releasing](./operations/releasing.md), [operations/testing](./operations/testing.md), [operations/troubleshooting](./operations/troubleshooting.md)
- **reference**: [reference/runtime-contracts](./reference/runtime-contracts.md), [reference/shortcuts-and-dock](./reference/shortcuts-and-dock.md)
- **root**: [choose-a-workflow](./choose-a-workflow.md), [getting-started](./getting-started.md), [INDEX](./INDEX.md), [read-before-edit](./read-before-edit.md)
- **subsystems**: [subsystems/background-task-runtime](./subsystems/background-task-runtime.md), [subsystems/docs-freshness-gate](./subsystems/docs-freshness-gate.md), [subsystems/durability-and-safety](./subsystems/durability-and-safety.md), [subsystems/host-ui](./subsystems/host-ui.md)
- **tools**: [tools/bg_kill](./tools/bg_kill.md), [tools/bg_logs](./tools/bg_logs.md), [tools/bg_run](./tools/bg_run.md), [tools/bg_status](./tools/bg_status.md)

## Public surface owners

| Surface | Primary doc |
| --- | --- |
| `command:bg` | [commands/bg](./commands/bg.md) |
| `command:bg-clear` | [commands/bg-clear](./commands/bg-clear.md) |
| `command:bg-tasks` | [commands/task-manager](./commands/task-manager.md) |
| `command:bg-update` | [commands/bg-update](./commands/bg-update.md) |
| `command:jobs` | [commands/jobs](./commands/jobs.md) |
| `command:kill` | [commands/kill](./commands/kill.md) |
| `command:logs` | [commands/logs](./commands/logs.md) |
| `command:tasks` | [commands/task-manager](./commands/task-manager.md) |
| `eventbus:background-task-v1` | [api/eventbus-v1](./api/eventbus-v1.md) |
| `eventbus:external-task-v2` | [api/eventbus-v1](./api/eventbus-v1.md) |
| `renderer:background-task-notification` | [concepts/completion-delivery](./concepts/completion-delivery.md) |
| `shortcut:ctrl+alt+c` | [reference/shortcuts-and-dock](./reference/shortcuts-and-dock.md) |
| `shortcut:ctrl+b` | [reference/shortcuts-and-dock](./reference/shortcuts-and-dock.md) |
| `shortcut:shift+down` | [reference/shortcuts-and-dock](./reference/shortcuts-and-dock.md) |
| `tool:bash` | [subsystems/background-task-runtime](./subsystems/background-task-runtime.md) |
| `tool:bg_kill` | [tools/bg_kill](./tools/bg_kill.md) |
| `tool:bg_logs` | [tools/bg_logs](./tools/bg_logs.md) |
| `tool:bg_run` | [tools/bg_run](./tools/bg_run.md) |
| `tool:bg_status` | [tools/bg_status](./tools/bg_status.md) |

## Public surface inventory

| Kind | Name | ID | Provenance |
| --- | --- | --- | --- |
| command | `bg` | `command:bg` | `src/extension.ts:518` |
| command | `bg-clear` | `command:bg-clear` | `src/extension.ts:560` |
| command | `bg-tasks` | `command:bg-tasks` | `src/extension.ts:552` |
| command | `bg-update` | `command:bg-update` | `src/extension.ts:568` |
| command | `jobs` | `command:jobs` | `src/extension.ts:606` |
| command | `kill` | `command:kill` | `src/extension.ts:650` |
| command | `logs` | `command:logs` | `src/extension.ts:619` |
| command | `tasks` | `command:tasks` | `src/extension.ts:544` |
| tool | `bash` | `tool:bash` | `src/core/foreground-bash.ts:611` |
| tool | `bg_kill` | `tool:bg_kill` | `src/extension.ts:839` |
| tool | `bg_logs` | `tool:bg_logs` | `src/extension.ts:794` |
| tool | `bg_run` | `tool:bg_run` | `src/extension.ts:683` |
| tool | `bg_status` | `tool:bg_status` | `src/extension.ts:763` |
| shortcut | `ctrl+alt+c` | `shortcut:ctrl+alt+c` | `src/extension.ts:598` |
| shortcut | `ctrl+b` | `shortcut:ctrl+b` | `src/core/foreground-bash.ts:641` |
| shortcut | `shift+down` | `shortcut:shift+down` | `src/extension.ts:591` |
| renderer | `background-task-notification` | `renderer:background-task-notification` | `src/extension.ts:400` |
| eventbus | `background-task-v1` | `eventbus:background-task-v1` | `src/core/extension-api.ts` |
| eventbus | `external-task-v2` | `eventbus:external-task-v2` | `src/core/extension-api.ts` |

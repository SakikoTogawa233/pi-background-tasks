# @sakiko233/pi-background-tasks

Durable background shell task lifecycle for Pi.

<!-- pi-docs:begin name="readme-package-facts" generator="scripts/docs/generate.mjs" -->
| Fact | Value |
| --- | --- |
| Package | `@sakiko233/pi-background-tasks` |
| Version | `2.6.0` |
| Node engine | `>=22.19.0` |
| Pi entrypoints | `./extensions/background-tasks.ts` |
| Package image | [logo.png](https://raw.githubusercontent.com/SakikoTogawa233/pi-background-tasks/main/logo.png) |
<!-- pi-docs:end name="readme-package-facts" -->

<!-- pi-docs:begin name="readme-public-surfaces" generator="scripts/docs/generate.mjs" -->
| Surface kind | Count |
| --- | --- |
| command | 8 |
| tool | 5 |
| shortcut | 3 |
| renderer | 1 |
| eventbus | 2 |
| workflow | 0 |

Public commands: `/bg`, `/bg-clear`, `/bg-tasks`, `/bg-update`, `/jobs`, `/kill`, `/logs`, `/tasks`.

Public tools: `bash`, `bg_kill`, `bg_logs`, `bg_run`, `bg_status`.

Full owner map and generated contracts live in [docs/INDEX.md](docs/INDEX.md).
<!-- pi-docs:end name="readme-public-surfaces" -->

## Install

```bash
pi install npm:@sakiko233/pi-background-tasks
```

## Public tools

- `bash` — foreground shell with `Ctrl+B` or timed handoff in TUI mode.
- `bg_run` — start a named background command and return immediately.
- `bg_status` — inspect one task or recent tasks.
- `bg_logs` — read bounded output.
- `bg_kill` — stop a running task.

## Commands and UI

`/bg`, `/jobs`, `/logs`, `/kill`, `/tasks`, `/bg-tasks`, `/bg-clear`, and `/bg-update` share one registry and footer dock. Completion notifications are durable terminal truth and can trigger one follow-up turn.

## EventBus

The package preserves the closed shell EventBus v1 contract and provides a closed external-task EventBus v2 contract. V2 supports handshake, registration, generic updates, bounded log append, correlated cancellation acknowledgement, settlement, status, logs, kill, and terminal publication. External snapshots contain only generic task facts, an owner reference, and generic capabilities.

See `docs/api/eventbus-v1.md` for both versions.

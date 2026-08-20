---
doc_id: reference/shortcuts-and-dock
audience: user
mode: mixed
review_policy: contract
stability: stable
covers_surfaces: ['shortcut:ctrl+alt+c', 'shortcut:ctrl+b', 'shortcut:shift+down']
covers_sources: []
---
# Shortcuts and dock reference

<!-- pi-docs:begin name="shortcut-contracts" generator="scripts/docs/generate.mjs" -->
| Shortcut | Description | Provenance |
| --- | --- | --- |
| `ctrl+alt+c` | Clear finished background task footer notices (terminal-dependent fallback for /bg-clear) | `src/extension.ts:665` |
| `ctrl+b` | Move the most recent active foreground bash command to the background | `src/core/foreground-bash.ts:641` |
| `shift+down` | Open focused background task footer dock | `src/extension.ts:658` |
<!-- pi-docs:end name="shortcut-contracts" -->

## Registered shortcuts

| Shortcut | Behavior |
|---|---|
| `Shift+Down` | Open the focused background task footer dock / task manager. |
| `Ctrl+B` | Move the most recently started active interactive `bash` command into the background-task registry. It works before or after the 2-second hint; with no eligible command it is a no-op. |
| `Ctrl+Alt+C` | Clear finished background task footer notices; this is an optional terminal-dependent fallback for [`/bg-clear`](../commands/bg-clear.md). |

If a terminal does not deliver `Ctrl+Alt+C`, use `/bg-clear`. It is the canonical command path.

`Ctrl+B` is a manual handoff for an already-running foreground command, not an alias for [`bg_run`](../tools/bg_run.md). Handoff preserves the live process and output file, returns a task id, and transfers completion/kill/shutdown ownership to the registry. Commands still running in an interactive TUI after 120 seconds are handed off automatically; non-interactive commands do not use manual or automatic handoff.

## Footer states

Footer counts display only `running` and unseen successful `done` tasks; failed and stopped tasks remain available in the focused dock, task commands, tools, logs, history, RPC data, and notifications, but they never add footer count labels.

Examples:

```text
bg 1 running · Shift↓
bg 1 done · Shift↓ · /bg-clear
bg 1 running · 1 done · Shift↓ · /bg-clear
bg 1 running · Shift↓ · ⬆ v999.0.0 /bg-update
bg 1 running · focused
```

Failed/stopped notices remain clearable unseen finished notices. When a running or done segment is visible, they can still cause the `/bg-clear` hint to appear. If failed/stopped are the only unseen states, the task status is cleared; an independent update segment remains visible by itself.

The `/bg-clear` hint is hidden while the dock is open, where the entry hint becomes `focused`. A finished task's notice is marked seen when its detail view opens; `/bg-clear` or `Ctrl+Alt+C` marks all currently unseen finished tasks seen. Merely opening the list view or closing the dock does not clear notices.

## Dock entry points

- `Shift+Down`
- [`/tasks`](../commands/task-manager.md)
- [`/bg-tasks`](../commands/task-manager.md)

All open the same task manager when an interactive UI is available.

## Dock output detail

The detail view follows a UI-only 128 KiB tail buffer, refreshes once per second while following, and shows 12 output lines. Scrolling up pauses following; reaching the bottom or pressing `r` resumes it. A foreground command adopted through `Ctrl+B` or the runtime threshold appears and behaves like every other task; its detail output continues in the same file across handoff.

## Related docs

- [`/bg-clear`](../commands/bg-clear.md)
- [`/tasks` and `/bg-tasks`](../commands/task-manager.md)
- [`/bg-update`](../commands/bg-update.md)
- [`bg_run`](../tools/bg_run.md)
- [Background task runtime](../subsystems/background-task-runtime.md)
- [Host UI and telemetry](../subsystems/host-ui-and-telemetry.md)

## Source ownership/reference

Shortcut and footer implementation is owned by [host-ui-and-telemetry](../subsystems/host-ui-and-telemetry.md).

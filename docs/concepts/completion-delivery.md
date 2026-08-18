---
doc_id: concepts/completion-delivery
audience: agent
mode: authored
review_policy: contract
stability: stable
covers_surfaces: [renderer:background-task-notification]
covers_sources: []
---
# Completion delivery

Background tasks can finish silently, notify the terminal, or notify and wake the agent. The flags are task-owned.

## Delivery modes

| `notifyOnCompletion` | `triggerOnCompletion` | Actual mode |
|---|---:|---|
| `true` | `true` | Durable terminal notification and automatic follow-up turn. Default for [`bg_run`](../tools/bg_run.md). |
| `true` | `false` | Durable terminal notification only; no provider follow-up. Default for [`/bg`](../commands/bg.md). |
| `false` | `true` | Manual monitoring; `triggerOnCompletion` has no effect without a notification. |
| `false` | `false` | Manual monitoring. |

## Critical behavior

- `/bg` is display-only by default: it sets `notifyOnCompletion:true` and `triggerOnCompletion:false`.
- `bg_run` defaults to durable notification plus follow-up turn: `notifyOnCompletion:true` and `triggerOnCompletion:true`.
- An interactive foreground `bash` command adopted by `Ctrl+B` or its total-runtime threshold enters the registry with `notifyOnCompletion:true` and `triggerOnCompletion:true`.
- `bg_status` and `bg_logs` are point-in-time inspection tools, not polling primitives.
- Tool-launched Fusion tasks default to notification plus follow-up wake and are retrieved once with `bg_result`; `/fusion` uses notification-only.
- A received `<background-task-notification>` is metadata-backed terminal-status truth. The output stream has finished/closed, but ordinary `.output` bytes are not explicitly fsynced. Do not call `bg_status` only to reconfirm status; call `bg_logs` only if output bytes are needed.

## Foreground bash handoff versus completion

Foreground handoff has two distinct deliveries:

1. The `bash` tool returns an early receipt containing bounded output so far, the adopted task id, command, output path, and whether handoff was manual or timed out. A displayed `foreground-bash-backgrounded` message records the ownership change for the next turn.
2. When the adopted process later exits, the registry sends the ordinary `background-task-notification` and triggers one follow-up turn.

The handoff receipt is not terminal truth. After handoff, the registry exclusively owns output, kill, finalization, and shutdown; aborting the old tool call does not stop the task. The foreground controller does not emit another handoff message when the child exits, so completion wake-up remains exactly once under registry ownership.

## Notification payload

When enabled and not during shutdown, terminal completion sends a custom message with:

- `<task-id>`
- `<task-name>`
- `<status>` (`completed`, `failed`, or `killed`)
- optional `<exit-code>`
- optional `<error>`
- `<output-file>`
- `<summary>`
- `<guidance>` that says terminal state and output metadata are durable and not to reconfirm with `bg_status`.

The structured details contain the task snapshot, including delivery flags and `notified` state.

## Agent guidance

After default `bg_run` or a foreground-bash handoff, continue only independent useful work. If there is no such work, briefly acknowledge and end the turn; the follow-up notification will wake the agent. Do not sleep, poll `bg_status`, or repeatedly read `bg_logs` merely to wait.

If either completion flag was intentionally disabled, manual inspection is allowed when deliberate, but still avoid tight polling.

## Failures and suppression

If notification send fails, the task resets `notified:false` and logs the error; it does not silently pretend delivery happened. During Pi session shutdown/reload, notifications are suppressed while running tasks are killed.

## Related docs

- [`bg_run`](../tools/bg_run.md)
- [`bg_status`](../tools/bg_status.md)
- [`bg_logs`](../tools/bg_logs.md)
- [`/bg`](../commands/bg.md)
- [Background task runtime](../subsystems/background-task-runtime.md)
- [Host UI and telemetry](../subsystems/host-ui-and-telemetry.md)

## Source ownership/reference

Delivery receipt text is derived by runtime helpers and sent by extension registration; primary behavioral ownership is split between [background-task-runtime](../subsystems/background-task-runtime.md) and [host-ui-and-telemetry](../subsystems/host-ui-and-telemetry.md).

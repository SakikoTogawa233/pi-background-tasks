# pi-background-tasks

Claude-Code-like explicit background shell task manager for [Pi](https://pi.dev/).

This package adds named, tracked background shell jobs with durable output files, bounded log reads, kill/timeout safety, task-owned context-window telemetry, a focused footer-dock task manager, `/tasks` fallback UI, and completion notifications that can wake the agent when LLM-launched work finishes.

## Install

From npm after publish:

```bash
pi install npm:pi-background-tasks@0.2.0
```

From git after pushing this package to its standalone repository and tagging:

```bash
pi install git:github.com/ismailsaleekh/pi-background-tasks@v0.2.0
```

For project-local install:

```bash
pi install -l npm:pi-background-tasks@0.2.0
```

## Commands

- `/bg [--name "Task name"] <command>` — start a named tracked background shell command.
- `/jobs` — list running and recent completed/failed/killed tasks.
- `/logs <id> [maxBytes]` — show bounded tail output and full output path.
- `/kill <id>` — stop a running task.
- `/tasks` or `/bg-tasks` — fallback command to open the task manager UI.

## Footer dock UX

When tasks are active or unseen completions/failures exist, Pi shows a compact footer status:

```text
bg 2 running · Shift↓
bg 1 running · 1 failed · Shift↓
bg 2 done · Shift↓
```

Press `Shift+Down` to open the focused bottom dock. Arrow keys are captured only while the dock is focused. Each task row shows context-window usage reported by that specific background task, for example `ctx 21.0%/200k`; tasks that do not report their own context show `ctx —` rather than the parent Pi session's usage. Finished-task badges intentionally remain visible until acknowledged; press uppercase `C` (`Shift+C`) from the main UI to clear finished background-task notices without opening the dock.

Dock controls:

| Key | Action |
|---|---|
| `Shift+Down` | Open focused background-task dock |
| `C` / `Shift+C` | Clear finished-task footer notices from the main UI |
| `↑` / `↓` | Select task |
| `PageUp` / `PageDown` | Page task list |
| `Enter` / `→` | Inspect logs/details |
| `←` | Return from details to list |
| `h` | Toggle recent history |
| `k` | Stop selected running task |
| `a` / `K` | Stop all running tasks, with confirmation |
| `r` | Refresh detail tail |
| `R` | Rerun selected command |
| `c` | Show copyable output path |
| `x` / `Esc` / `q` | Close dock |

## LLM tools

- `bg_run` — start named long-running commands without blocking the conversation.
- `bg_status` — inspect one task or all recent tasks.
- `bg_logs` — read bounded task output.
- `bg_kill` — stop a running task.

`bg_run` requires a concise `name` for the footer dock, plus the shell `command`. It defaults to `triggerOnCompletion: true`, so completion notifications trigger a follow-up agent turn. User-launched `/bg` jobs and UI reruns are display-only by default.

## Runtime files

Task output and metadata are written under the current project:

```text
.pi/tasks/<session-id>-<pid>/<task-id>.output
.pi/tasks/<session-id>-<pid>/<task-id>.json
```

These are runtime artifacts and should remain gitignored.

## Safety model

- Commands are spawned and tracked with `child_process.spawn`; the package does not rely on shell `&`.
- stdout/stderr are captured to task output files.
- Model-visible logs are bounded and point to full output files.
- POSIX process groups are used for process-tree kill where possible, with child-process fallback.
- Running tasks are cleaned up on Pi session shutdown/reload.
- Cross-Pi-restart process reattachment and Ctrl+B backgrounding of already-running foreground tools are intentionally out of scope.

## Development and QA

Default QA gate:

```bash
npm run test
```

Smoke and release checks:

```bash
npm run smoke
npm run pack:dry-run
```

Full interactive QA gate:

```bash
npm run test:full
```

The suite includes typecheck, unit, SDK, RPC, component, package, and PTY/TUI coverage for the focused dock and `Shift+Down` shortcut.

Note: the repo QA standard now requires exhaustive coverage of every public behavior and plausible edge case. This package passes the current baseline gates, but `TEST_PLAN.md` tracks remaining exhaustive-coverage work for restart/rerun, all dock keys, command/tool edge cases, lifecycle safety paths, notification follow-up, footer badges, package distribution edge cases, and cross-platform mocks.

This package follows the repo-wide Pi extension QA standard documented in:

- [`../EXTENSION_QA_STANDARD.md`](../EXTENSION_QA_STANDARD.md)
- [`../EXTENSION_TESTING_PLAYBOOK.md`](../EXTENSION_TESTING_PLAYBOOK.md)
- [`TEST_PLAN.md`](TEST_PLAN.md)
- [`TESTING.md`](TESTING.md)

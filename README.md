# pi-background-tasks

Claude-Code-like explicit background shell task manager for [Pi](https://pi.dev/).

This package adds tracked background shell jobs with durable output files, bounded log reads, kill/timeout safety, a `/tasks` manager UI, and completion notifications that can wake the agent when LLM-launched work finishes.

## Install

From npm after publish:

```bash
pi install npm:pi-background-tasks@0.1.0
```

From git after pushing this package to its standalone repository and tagging:

```bash
pi install git:github.com/ismailsaleekh/pi-background-tasks@v0.1.0
```

For project-local install:

```bash
pi install -l npm:pi-background-tasks@0.1.0
```

## Commands

- `/bg <command>` — start a tracked background shell command.
- `/jobs` — list running and recent completed/failed/killed tasks.
- `/logs <id> [maxBytes]` — show bounded tail output and full output path.
- `/kill <id>` — stop a running task.
- `/tasks` or `/bg-tasks` — open the interactive task manager UI.

## LLM tools

- `bg_run` — start long-running commands without blocking the conversation.
- `bg_status` — inspect one task or all recent tasks.
- `bg_logs` — read bounded task output.
- `bg_kill` — stop a running task.

`bg_run` defaults to `triggerOnCompletion: true`, so completion notifications trigger a follow-up agent turn. User-launched `/bg` jobs are display-only by default.

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

## Development smoke

```bash
npm run smoke
npm run pack:dry-run
```

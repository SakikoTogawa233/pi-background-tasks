# pi-background-tasks Testing

This package follows the repo-wide Pi extension QA standard:

- [`../EXTENSION_QA_STANDARD.md`](../EXTENSION_QA_STANDARD.md)
- [`../EXTENSION_TESTING_PLAYBOOK.md`](../EXTENSION_TESTING_PLAYBOOK.md)
- [`TEST_PLAN.md`](TEST_PLAN.md)

## Current commands

Default gate:

```bash
npm run test
```

This runs:

```bash
npm run typecheck
npm run test:unit
npm run test:sdk
npm run test:rpc
npm run test:component
npm run test:package
```

Full interactive gate:

```bash
npm run test:full
```

This runs the default gate plus:

```bash
npm run test:pty
```

Smoke/release checks:

```bash
npm run smoke
npm run pack:dry-run
```

Current smoke:

```bash
pi --no-extensions -e ./extensions/background-tasks.ts --offline --no-tools --no-session -p "/jobs"
```

Smoke proves loadability only; completion requires `npm run test`, `npm run test:full`, and `npm run pack:dry-run`.

## Required isolated environment

Automated tests run with isolated temp project/agent/session directories and should use:

```bash
PI_OFFLINE=1
PI_SKIP_VERSION_CHECK=1
PI_TELEMETRY=0
CI=1
```

Tests must not use the user's real `~/.pi/agent`.

## Coverage summary

Implemented coverage includes:

- tools: `bg_run`, `bg_status`, `bg_logs`, `bg_kill`, including unknown/ambiguous IDs, completed-kill failure, legacy no-name preparation, head/tail truncation, and notification on/off behavior
- commands: `/bg`, `/jobs`, `/logs`, `/kill`, `/tasks`, `/bg-tasks` discovery, happy paths, malformed `/bg`, unknown/ambiguous IDs, completed-task `/kill`, byte-limit normalization, and RPC no-hang fallback behavior
- shortcut/UI: component coverage for focused dock list/detail/key handling, empty/history/unread states, paging, close aliases, stop/stop-all/rerun/path actions, missing output files; SDK coverage for explicit `Shift+C` finished-notice clearing; and PTY coverage for `/tasks`, real `Shift+Down`, detail/back/history/stop/close
- runtime files: output and metadata files under `.pi/tasks/`, task-owned context-window telemetry snapshots, metadata after completion/failure, local tarball install contents
- safety: kill, already-finished kill failure, timeout failure, spawn failure, low output-cap failure, multi-task shutdown cleanup
- package: manifest, docs, `pi.extensions`, peer dependency/import parity, packed runtime files, tarball-install smoke, and artifact exclusion

## PTY notes

`test:pty` uses `/usr/bin/expect` to drive a real pseudo-terminal. It verifies:

- `/tasks` opens the focused dock and closes with `x`.
- A named `/bg` task appears in the dock when opened with xterm `Shift+Down` (`ESC [ 1 ; 2 B`).

## Artifact policy

Use package-local or repo-level artifacts if future snapshot/log persistence is needed:

```text
artifacts/pi-extension-tests/pi-background-tasks/
├── summary.json
├── rpc-events.jsonl
├── tui-ansi.log
├── screen.normalized.txt
└── snapshots/
```

Normalize volatile values before snapshotting: task IDs, session IDs, PIDs, timestamps, durations, temp paths, and `.pi/tasks/<session-pid>/...` run directories.

## Remaining full exhaustive coverage work

The package now has expanded edge-case coverage across the default and full gates. Remaining hardening items tracked in [`TEST_PLAN.md`](TEST_PLAN.md) are narrower: deeper registry extraction/race unit tests, scripted-provider validation of actual follow-up agent turns, exhaustive real-PTY coverage for every secondary dock key (`a`/`K`, `R`, `c`, page keys), process-tree kill fallback mocking, pruning, and Windows-specific shell/path/kill mocks.

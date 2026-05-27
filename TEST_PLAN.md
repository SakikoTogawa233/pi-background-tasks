# pi-background-tasks Test Plan

This package follows:

- [`../EXTENSION_PACKAGE_STANDARD.md`](../EXTENSION_PACKAGE_STANDARD.md)
- [`../EXTENSION_QA_STANDARD.md`](../EXTENSION_QA_STANDARD.md)
- [`../EXTENSION_TESTING_PLAYBOOK.md`](../EXTENSION_TESTING_PLAYBOOK.md)

## Package

| Field | Value |
|---|---|
| Package | `pi-background-tasks` |
| Extension entrypoint | `extensions/background-tasks.ts` |
| Public commands | `/bg`, `/jobs`, `/logs`, `/kill`, `/tasks`, `/bg-tasks` |
| Public tools | `bg_run`, `bg_status`, `bg_logs`, `bg_kill` |
| Shortcuts | `Shift+Down`, `Shift+C` |
| Custom UI | footer status + focused bottom dock overlay |
| Custom provider | no |
| Runtime files/state | `.pi/tasks/<session-id>-<pid>/<task-id>.output`, `.pi/tasks/<session-id>-<pid>/<task-id>.json` |

## Required gates

| Gate | Command | Required in default `npm run test`? | Status |
|---|---|---:|---|
| Typecheck | `npm run typecheck` | yes | implemented |
| Unit | `npm run test:unit` | yes | implemented |
| SDK | `npm run test:sdk` | yes | implemented |
| RPC | `npm run test:rpc` | yes | implemented |
| Component | `npm run test:component` | yes | implemented |
| Package | `npm run test:package` | yes | implemented |
| PTY/TUI | `npm run test:pty` | full gate | implemented |
| Pack dry run | `npm run pack:dry-run` | release gate | implemented |
| Smoke | `npm run smoke` | no | implemented; load-only |

## Feature coverage matrix

| Feature | Public surface | Unit | SDK | RPC | Component | PTY | Package | Scripted provider | Notes |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| Start background command from UI command | `/bg` | yes |  | yes |  | yes |  |  | Unit covers `--name`; RPC/PTY start real processes. |
| List tasks | `/jobs` |  |  | yes |  |  |  |  | RPC asserts running and killed task rows. |
| Show bounded logs | `/logs <id> [maxBytes]` | yes |  | yes |  |  |  |  | Unit covers bounded reads; RPC verifies output/path. |
| Kill running task | `/kill <id>` |  | yes | yes |  |  |  |  | SDK tool and RPC slash command. |
| Open task manager fallback | `/tasks`, `/bg-tasks` |  |  | discovery | yes | yes |  |  | Component covers dock; PTY covers `/tasks`. |
| Start background command from LLM tool | `bg_run` | yes | yes |  |  |  |  | optional | SDK starts named commands. |
| Inspect task status | `bg_status` |  | yes |  |  |  |  |  | SDK polls exact IDs and validates shutdown state. |
| Read task logs | `bg_logs` | yes | yes |  |  |  |  |  | SDK verifies content. |
| Stop task from LLM tool | `bg_kill` |  | yes |  |  |  |  |  | Covers running kill and already-finished loud failure. |
| Completion notification | custom message `background-task-notification` |  | manual/runtime |  | renderer via typecheck |  |  | optional | Live runtime smoke previously verified; scripted-provider follow-up remains optional hardening. |
| Footer status | `ctx.ui.setStatus` |  | load path + clear shortcut |  | render semantics | yes |  |  | SDK verifies `C clear` persistence/clear; PTY verifies Shift+Down dock path after footer-visible task. |
| Per-task context usage | task row/detail + metadata |  | yes |  | yes |  |  |  | SDK verifies task-owned telemetry is captured and parent `ctx.getContextUsage()` is not used; component verifies list/detail rendering plus `ctx —` placeholder. |
| Focused dock list | overlay component |  |  |  | yes | yes |  |  | Selection/actions/history tested. |
| Focused dock detail | overlay component |  |  |  | yes |  |  |  | Tail read, output box, return-to-list tested. |
| Dock stop selected | `k` |  |  |  | yes |  |  |  | Component. |
| Dock stop all | `a`/`K` |  |  |  | yes |  |  |  | Component confirmation. |
| Dock rerun | `R` |  |  |  | yes |  |  |  | Component. |
| Dock close | `x`/`Esc`/`q` |  |  |  | yes | yes |  |  | Component + PTY. |
| Shortcut opens dock | `Shift+Down` |  | registration |  |  | yes |  |  | PTY sends xterm `ESC [ 1 ; 2 B`. |
| Shortcut clears finished notices | `Shift+C` / `C` |  | yes |  |  |  |  |  | SDK invokes registered shortcut and asserts finished notices remain until explicit clear. |
| Runtime output files | `.pi/tasks/...output` | yes | yes |  |  |  |  |  | SDK asserts existence. |
| Runtime metadata files | `.pi/tasks/...json` |  | yes |  |  |  |  |  | SDK asserts shape/status/name/context usage. |
| Timeout kills task | `timeoutSeconds` |  | yes |  |  |  |  |  | SDK. |
| Output cap kills task | `PI_BG_MAX_OUTPUT_BYTES` |  |  | yes |  |  |  |  | RPC runs with a low cap and asserts failed status/log notice. |
| Shutdown cleanup | `session_shutdown` |  | yes |  |  |  |  |  | SDK asserts multiple running tasks become killed. |
| Package manifest | `package.json` |  |  |  |  |  | yes |  | Keywords, `pi.extensions`, files. |
| Pack contents | `npm pack --dry-run` |  |  |  |  |  | yes |  | Runtime files included. |

## Remaining hardening coverage

The expanded suite now covers the major public command/tool/UI/package edge cases. The rows below are the residual hardening items that still require deeper extraction, mocks, or scripted-provider infrastructure before the package can be called exhaustively complete under the strictest interpretation of the repo QA standard.

| Gap | Owner | Date | Reason | Planned fix |
|---|---|---|---|---|
| Process registry still mostly lives in `src/extension.ts` | package maintainer | 2026-05-27 | UI was extracted; deeper registry extraction remains | Move process lifecycle into `src/core/registry.ts` and unit-test state transitions/races directly. |
| Restart/rerun not exhaustively tested in live PTY | package maintainer | 2026-05-27 | Component covers `R` from list/detail; PTY currently covers detail/back/history/stop/close but not real rerun | Add PTY cases for `R` from completed/killed/failed tasks, inherited fields, new ID, and display-only notification defaults. |
| Dock key map not exhaustively covered in PTY | package maintainer | 2026-05-27 | Component covers full key map; PTY covers `/tasks`, `Shift+Down`, `Enter`, `←`, `h`, `k`, `r`, `x` | Add PTY cases for `↑/↓`, page keys, `a`/`K`, `R`, `c`, failed/unseen/done badges, ordering, and multiple running tasks. |
| Process lifecycle/safety edge cases incomplete | package maintainer | 2026-05-27 | Timeout/shutdown/kill/spawn-failure/output-cap covered; lower-level races need extraction/mocks | Add tests for process-tree fallback where mockable, duplicate finalization prevention, duplicate notification prevention under races, metadata-after-notification ordering under write failures, and pruning old tasks. |
| Completion follow-up turn not deterministic | package maintainer | 2026-05-27 | SDK now verifies custom message XML/details and `notifyOnCompletion:false`; live runtime smoke verified wakeups | Add scripted-provider tests for `/bg` display-only default, `bg_run` wakeup default, failed notification error fields, and actual follow-up trigger behavior. |
| Footer/status behavior could be deeper | package maintainer | 2026-05-27 | SDK covers explicit clear and running/done persistence; component covers seen-state behavior and PTY observes dock path; full status protocol assertions are still thin | Add RPC/SDK assertions for failed/stopped count combinations and focused label. |
| Cross-platform behavior not covered | package maintainer | 2026-05-27 | Current tests run on local POSIX/macOS | Add unit/mocked coverage for Windows shell invocation, path separator handling, and kill fallback semantics. |

## Acceptance checklist

- [x] `npm run test` passes offline in isolated temp dirs.
- [x] `npm run test:full` validates baseline real TUI/PTY behavior.
- [x] `npm run pack:dry-run` passes.
- [ ] README claims and all plausible edge cases are exhaustively mapped in this test plan.
- [ ] Every listed edge case has automated coverage at the lowest reliable layer.
- [x] No real LLM/API/network dependency in default tests.
- [x] No dependency on user/global `~/.pi/agent` for SDK/RPC/PTY tests.
- [x] Volatile output is normalized in snapshot-style assertions where applicable.

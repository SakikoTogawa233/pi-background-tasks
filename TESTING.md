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
npm run test:type-safety
npm run test:unit
npm run test:sdk
npm run test:rpc
npm run test:component
npm run test:package
npm run test:hook-contract
```

`npm run test:hook-contract` is the **Pi hook characterisation gate**. It drives a
real Pi agent loop against a deterministic scripted provider and records what Pi's
`context` and `tool_result` hooks actually do, because the `bg_delegate` child-side
guard depends on that behaviour and it must be proven by execution rather than read
from type declarations.

The observed guarantees are written to
`tests/scripted-provider/pi-hook-contract-evidence.json` and shipped as
`src/core/delegate/hook-contract-evidence.json`. A package test asserts the two are
byte-identical, so the runtime gate and the gate that proved it cannot drift apart.
If the evidence file already exists, the gate **compares** against it rather than
rewriting it: a change in Pi's hook behaviour fails loudly and forces a deliberate
re-review of the child guard instead of silently regenerating.

On Pi 0.83 the gate establishes, by execution:

| Question | Observed |
|---|---|
| Does `context` fire before every model call? | yes, once per call, in extension load order |
| Do messages returned from `context` reach the provider? | yes |
| Does **throwing** in `context` prevent the provider call? | **no** — Pi catches it and dispatches anyway |
| Does `ctx.abort()` prevent it? | it does not skip the call site, but the call receives an already-aborted signal and the run terminates |
| Does `tool_result` fire before the transcript entry, and can a handler replace it? | yes, chained in load order; the replacement reaches the provider and the original does not |
| Do tool-call id, role, and `isError` survive replacement? | yes |

Because neither a throw nor an abort is a hard admission gate on its own, the child
guard uses abort as the barrier **and** removes the oversized content from the
outgoing message set. A Pi build that cannot provide the required guarantees causes
`bg_delegate` to refuse to spawn with a typed `delegate_hook_contract_unsupported`.

Full interactive gate:

```bash
npm run test:full
```

This runs the default gate plus:

```bash
npm run test:pty
npm run test:agent-loop
```

Smoke/release checks:

```bash
npm run smoke
npm run smoke:large-context
npm run pack:dry-run
npm run test:compat
```

Current smoke is `tsx scripts/smoke.ts`. It creates a temporary Pi agent/session directory, sets offline/telemetry-suppression environment variables, and runs the package entrypoint with `/jobs`.

`npm run smoke:large-context` is the Fusion context-policy evidence harness. It rebuilds the byte composition of the production failure (696,929 B tool results, 251,508 B tool arguments, 34,959 B user text, 24,733 B assistant text, 10,303 B thinking) as a real `SessionManager` branch, then prints:

- the pre-fix full-transcript canonical input and the fact that it is rejected against the panel's smallest route;
- the post-fix projected canonical input with full omission accounting and a byte-identical rebuild check;
- the measured candidate, evaluator, evaluation-repair, and merger prompt sizes against the allowed input budget, using the largest real candidate answer (45,434 B) and evaluator output (54,829 B) observed in `.pi/fusion`.

It performs no inference and spawns no child, so it is safe to run offline and costs nothing. It exits non-zero if any stage would exceed the budget.

### Fusion byte-immutability gates

Two unit gates protect Fusion's persisted artifact bytes, which are a frozen format:

- `tests/unit/fusion-golden-bytes.test.ts` renders an exhaustive 28-case differential
  corpus (empty conversations, run-boundary and image-coalescing branches, unknown
  blocks, tool-name ordering, `compactCounts` combinations, UTF-8 and lone-surrogate
  content, every budget stage across three route sets) and compares the raw bytes
  against `tests/fixtures/fusion-golden-bytes.json`. The golden file is never
  auto-updated once it exists.
- `tests/unit/fusion-extraction-equivalence.test.ts` compares the current
  implementation against `tests/oracle/fusion-context-pre-extraction.ts`, a verbatim
  copy of the projection engine as it existed before the shared transform was
  extracted. This is an **independent oracle**, so equivalence is proven rather than
  merely self-consistent, including `Object.is` comparison of budget floats and exact
  error-message parity.

### Delegate gates

- `tests/unit/delegate-seed.test.ts` — verbatim visible text, thinking/tool-payload
  exclusion, marker-only images, sibling-batch exclusion, byte-identical construction
  across repeated builds and separate processes, and receive-side seed verification.
- `tests/unit/delegate-budget.test.ts` — reserve arithmetic, boundary accept/reject,
  and the total runtime governor.
- `tests/unit/delegate-result-package.test.ts` — hash verification, strict base64,
  encoding refusal for lone surrogates, route-mismatch and missing-attestation
  detection, and explicitly unavailable usage.
- `tests/unit/delegate-artifacts.test.ts` — spill/receipt coordinates under
  out-of-order completion, aggregate caps, exact bounded range reads, and terminal
  evaluation including a zero-exit child that never committed.
- `tests/unit/delegate-launch.test.ts` — route pinning without substitution, argv-level
  isolation, the hook-contract gate, and the property that a refused launch creates
  **zero** children and **zero** artifacts.
- `tests/scripted-provider/delegate-child-guard.test.ts` — the child guard inside a
  real Pi agent loop: a 2 MB tool result spilled to a hashed artifact with the payload
  kept out of the transcript, a blocked over-budget model call, exact bounded range
  reads, route-drift refusal, and turn-limit enforcement.
- `tests/sdk/delegate-sdk.test.ts` — the full public loop through the shipped
  entrypoint with a fake child `pi`: launch receipt, projected context actually
  reaching the child, child session isolation, not-ready retrieval, corruption
  detection, and oversized answers degrading to an artifact reference without
  truncation.
- `tests/package/delegate-mutation-guard.test.ts` — fails if silent truncation, a
  silent fallback, a route substitution, an unbounded inline answer, a dropped
  preflight, a synthesized zero usage, a fail-open guard hook, or an undelivered
  seed is reintroduced. Verified by actually mutating the source: disabling the
  spill makes two behavioural tests fail.

### Live subscription evidence run

`npx tsx scripts/delegate-live-run.ts` is a release-time evidence harness. It
builds a genuinely large parent session (43 visible text entries plus 120 omitted
tool events withholding ~162 KB of tool-result payload), launches **one** real
child `pi` on the parent's current **subscription OAuth** route with no API-key
argument, and asserts that the child produced a hash-verified answer that used
**both** its read-only file tools and the projected conversation. It also asserts
the omitted payload never appears in the seed or the child prompt.

It is not part of the default gate because it performs real inference. It caught
two defects that no offline gate did: a child that verified its seed file but was
never handed a prompt, and a budget that measured the seed instead of the prompt
actually sent. Both are now pinned by unit and mutation-guard tests.

Smoke proves loadability only; completion requires `npm run test`, `npm run test:full`, `npm run pack:dry-run`, and the release-only compatibility gate when preparing a release.

## Required isolated environment

Automated tests run with isolated temp project/agent/session directories and should use:

```bash
PI_OFFLINE=1
PI_SKIP_VERSION_CHECK=1
PI_TELEMETRY=0
CI=1
```

Tests must not use the user's real `~/.pi/agent`.


Fusion-specific targeted gates:

```bash
npm run typecheck
npm run test:type-safety
npm run test:unit
npm run test:component
npm run test:sdk
npm run test:rpc
npm run test:agent-loop
```

The Fusion SDK/RPC/scripted-provider tests install a deterministic fake child `pi` in a temp `PATH` from `tests/helpers/fusion-fake-pi.ts`. Parent Pi remains the real SDK/RPC runtime; only direct child `pi --mode text` calls with the package-owned private compact metadata extension are intercepted. `PI_CODING_AGENT_DIR` is pointed at the temp agent directory so `fusion-models.json` is never read from the user's real global Pi directory. Fusion v1 public-surface coverage asserts exactly four tools (`fusion_reason`, `fusion_investigate`, `fusion_research`, `fusion_validate`), no public capability argument, stale `fusion_brainstorm` active-tool removal, `/fusion` mapping to reason/no-tool candidates, closed schemas with Google-compatible enum status, targeted URL fetch not search, URL exfiltration warnings, strict validation verification rules, legacy rendering, and actionable migration errors for `fusion_validate({prompt})`. Fusion context coverage is conversation-projection coverage. `tests/unit/fusion-context-prompts.test.ts` verifies that a synthetic session carrying more than 1 MB of tool arguments/results still yields a small canonical input, that user and assistant text survive verbatim, that thinking and tool payloads never appear (including no head/tail/preview sentinel), that omission counts, byte totals, and hashes are exact and stable, that repeated construction is byte-identical, that the active Fusion tool leaf and sibling calls stay scope-excluded, that images remain marker-only or ledger-only with no raw base64 in child prompts, and that every retained source block receives exactly one disposition. `tests/unit/fusion-high-cardinality.test.ts` covers the receipt-cardinality regression: a session of many short interleaved tool events (rather than a few enormous results) pins per-receipt cost, proves the compact `omitted_activity` fields are the only model-facing ones, reconciles every receipt against the ledger through `projection_map`, and proves the whole workflow fits a real route budget. `tests/unit/fusion-budget.test.ts` covers stage budgets: the limiting model is the smallest configured route (including when it is the evaluator rather than a candidate), unknown or too-small capacities fail before spawn, boundary prompts pass at exactly the limit and fail one byte past it, the child system prompt counts as input, dense multi-byte UTF-8 cannot bypass byte accounting, and candidate, evaluator, evaluation-repair, and merger expansions are each rejected before their child is spawned with zero partial launches. `tests/package/typebox-compat.test.ts` pins the TypeBox posture and compiles nullable-array schemas. The release-only `npm run test:compat` packs the package, installs exact supported Pi versions, runs `/jobs`, runs `/fusion` through the installed package entrypoint with the fake child Pi, verifies five child invocations, verifies `/fusion-models` rejects non-TUI mode, asserts the resolved `typebox` is Pi's bundled peer rather than a private or nested copy, and scans the installed package bytes for TypeBox APIs removed in the 1.3.x line. It then drives the current host Pi through a real RPC `fusion_reason` parent-agent loop, checks the persisted tool result carries the complete Pi `Usage.cost` object, invokes `get_session_stats` (the same aggregation boundary used by the TUI footer), reopens the durable session, and verifies identical token/cost totals. All parent and child inference remains deterministic and local.

## Coverage summary

Implemented coverage includes:

- tools: `bg_run`, `bg_run_pi_attested`, `bg_status`, `bg_logs`, `bg_kill`, `fusion_reason`, `fusion_investigate`, `fusion_research`, `fusion_validate`, including required `isAgent` schema/runtime validation, the event-driven no-sleep/no-poll system-prompt contract, truthful launch receipts for all four notification/wake combinations, non-terminating `bg_run` compatibility, point-in-time status/log guidance, durable terminal-notification authority, attested direct Pi spawn validation, Fusion exact merged tool result delivery/progress/details/context exclusion, versioned conversation projection with explicit hash-accounted tool/thinking omissions, pre-spawn stage budget rejection for all four expansion stages, image omission markers with raw image data excluded from child prompts, unknown/ambiguous IDs, completed-kill failure, legacy no-name preparation, head/tail truncation, and notification on/off behavior
- commands: `/bg`, `/jobs`, `/logs`, `/kill`, `/tasks`, `/bg-tasks`, `/bg-clear`, `/bg-update`, `/fusion`, `/fusion-models` discovery, happy paths, `/fusion` direct custom-message delivery, `/fusion` editor/cancel flow, `/fusion-models` TUI save and non-TUI rejection, `/bg --agent` parsing, finished-notice clearing, malformed `/bg`, unknown/ambiguous IDs, completed-task `/kill`, byte-limit normalization, and RPC no-hang fallback behavior
- update-available notice: semver parse/compare/precedence, `formatUpdateSegment`, npm/`package.json` payload narrowing, and injected-fetch success/404/throw/timeout (unit); localhost-registry footer segment (idle + appended to an active footer), `/bg-update` non-installing instructions, and opt-out/offline/already-current/registry-failure no-segment-and-no-throw paths (SDK); `/bg-update` discovery and offline instructions (RPC). The check is one-shot on `session_start`, time-boxed, offline-safe, gated by `PI_OFFLINE`/`PI_BG_DISABLE_UPDATE_CHECK`, and `PI_BG_REGISTRY_URL` overrides the registry endpoint
- shortcut/UI: component coverage for focused dock list/detail/key handling, detail output-tail scrolling (arrow/page scroll, follow-pause-on-scroll, `lines X–Y of N` position indicator, resume-follow-at-bottom, and no-scroll when output fits), empty/history/unread states, paging, close aliases, stop/stop-all/rerun/path actions, missing output files; SDK coverage for explicit `/bg-clear` finished-notice clearing, `/bg-clear` footer hinting, optional `Ctrl+Alt+C` fallback shortcut registration, and mixed failed/stopped/done/focused footer status; RPC coverage that `/bg-clear` works as a terminal-independent clear path; and PTY coverage for `/tasks`, `/bg-tasks`, real `Shift+Down`, arrows, page keys, detail/back/history/stop/stop-all/rerun/path/close, failed unread badges, and running/completed/failed/killed rerun paths
- runtime files: output and metadata files under `.pi/tasks/`, Fusion private `.pi/fusion/<session-id>-<pid>/<run-id>/` artifacts plus global `fusion-models.json`, persisted `isAgent` classification, task-owned context-window telemetry snapshots, cumulative background Pi-agent token usage, tool-use counts, agent model identifier (preferring the fully-qualified `provider/model` form), explicit `isAgent:true` telemetry wrapping for background `pi` agents, `isAgent:false` non-wrapping for scripts, attested Pi flat siblings (`.pi-events.jsonl`, `.stderr`, `.pi-telemetry-wrapper.cjs`, `.attestation.json`), real child `pi --mode json` tool-event parsing for background-agent telemetry, split/large telemetry ingestion, metadata after completion/failure, Fusion v2 compact final-only metadata and explicitly marked partial-response artifacts, and Fusion manifest token plus complete cost-component aggregates equal to the sum of successful and observed failed/cancelled attempts
- extension EventBus API: unit coverage for `pi-background-tasks:request:v1`/`response:v1` closed-frame validation, exact capability handshake, malformed payload rejection, unknown keys, unknown operations, duplicate request IDs, missing `session_start`, shutdown refusal, unsubscribe, strict terminal frame shape, and response-barrier ordering; registry coverage for exactly-one terminal publication after durable metadata plus loud/retriable terminal delivery failure; SDK coverage with a shared real `createEventBus()` loading the actual extension, starting `printf api-ok`, reading bounded logs, observing exactly one terminal event after the run response, and killing a real sleep task without model/provider calls
- attested Pi producer: unit/SDK coverage for 128-bit attested task ids, exact direct argv/cwd, ModelRegistry OAuth observation without secrets, raw Pi session/message events, separate stderr, prompt/report/source hashes, authority start/finish commit/tree/clean checks, atomic metadata serialization, completion visibility only after the sidecar is durable, malformed event rejection, and no attestation sidecar for ordinary tasks
- agent activity transcript: pure `parseAgentActivity`/`formatAgentActivityLine` coverage (assistant text, reasoning, tool start with arg summary, silent successful tool end, `✗ tool failed` errors, truncation, invalid/non-activity narrowing); registry-unit coverage that wrapped-agent stdout is reconstructed across split chunks into the human-readable transcript while telemetry/activity control JSON is stripped from the output file (telemetry fields still updated), stderr passes through, and the trailing partial line is flushed on finalize; SDK coverage that fake and real child `pi --mode json` runs surface `→ tool`/`✗ tool failed`/assistant text in `bg_logs` with no control JSON leaking into the visible output
- durability: `tests/unit/durable-fs.test.ts` covers the shared `src/core/durable-fs.ts` primitive through an injectable operations seam plus real-filesystem integration — single-open write/sync/close ordering, exclusive `wx` temp creation at `0o600`, direct `w` writes with inherited mode, the rule that a pathname is never reopened to flush it, temp ownership (a colliding temp created by another writer is never deleted), primary-versus-cleanup error precedence for write/sync/close/rename/remove failures, `renameCompleted` after a post-rename directory failure, the Windows directory-sync skip, atomic concurrent replacement, and fatal (never tolerated) `fsync` failures. `tests/package/package.test.ts` adds a mutation guard that fails if a read/read-write handle is used for `.sync()`, a path-based `fsyncFile` helper returns, or a sync failure is silently swallowed
- safety: kill, already-finished kill failure, timeout failure, spawn failure, low output-cap failure, multi-task shutdown cleanup, POSIX process-group kill fallback, Windows `taskkill /T` then `/T /F` tree termination with shared soft attempts, soft-abort-on-force, exit-128 race tolerance, loud force failures, no root-only fallback, SIGKILL escalation that terminates instead of re-arming (a SIGKILL never schedules a further escalation, and concurrent stop requests share exactly one escalation timer that is cleared on finalize), duplicate finalization/notification races, metadata/notification failure handling, and pruning
- agent loop: deterministic scripted-provider coverage against `extensions/background-tasks.ts` for actual event-driven `bg_run` behavior. The provider observes the effective system prompt, public tool descriptions, and real launch receipt and deliberately emits the pre-fix `bg_status` poll if any contract layer is absent; the passing path proves one launch, no sleep/status/log polling, one durable terminal notification, and exactly one follow-up turn. It also covers notification-only `triggerOnCompletion:false`, `/bg` display-only behavior, `notifyOnCompletion:false`, failed-task notification error fields, and parent-model `fusion_reason` tool use followed by normal parent response
- package: manifest, docs, `pi.extensions`, exported `src/core/extension-api.ts`, peer dependency/import parity, packed runtime files, tarball-install smoke, direct-completion import bans, test/helper/script/artifact exclusion, isolated offline npm installation, exact-version compatibility, and current-host persisted/replayed tool-usage safety

## PTY notes

`test:pty` uses `/usr/bin/expect` to drive a real pseudo-terminal. It verifies:

- `/tasks` and `/bg-tasks` open the focused dock and close with `x`.
- A named `/bg` task appears in the dock when opened with xterm `Shift+Down` (`ESC [ 1 ; 2 B`).
- Secondary dock keys work in a real TUI: arrows, page keys, detail/back, history, stop selected, stop-all confirmation, rerun, output path, and failed/unread history surfacing.
- Detail output-tail scrolling works with real arrow/page keys: opening a 60-line task's detail and pressing `↑` shows the `lines X–Y of N` position indicator and pauses the live tail.
- Fusion TUI surfaces work end to end: `/fusion <prompt>` renders the exact fake merged answer directly in the real TUI, and `/fusion-models` opens the five-slot selector.

The detail-view `Model:` line and the compact `model <id>` dock row are also exercised deterministically by the component layer (`tests/component/background-tasks-manager.test.ts`), which is the lowest reliable layer for dock rendering.

### Terminal keyboard-protocol negotiation

`pi` enables the Kitty keyboard protocol at startup by emitting `ESC[>7u ESC[?u ESC[c` and briefly intercepts stdin until that negotiation completes. The expect harness therefore must not key on a bare `>` (which matches the `ESC[>7u` push instantly and fires input before pi is listening); instead it waits for the steady-state status marker `(auto)`, answers the keyboard-protocol query (`ESC[?0u`, i.e. legacy keyboard) and the device-attributes query (`ESC[?1;2c`), and settles briefly before sending keys. This makes legacy keystrokes reach pi deterministically rather than racing the 150 ms negotiation fallback.

### Interactive-stdin capability probe

`test:pty` begins with a one-shot probe (`ptyInputSupported()`) that spawns a minimal raw-mode Node stdin reader under the same `/usr/bin/expect` driver and checks that a sent byte is received. Some hosts cannot deliver stdin to a raw-mode Node TUI through expect (a plain `cat` receives input but Node `process.stdin` does not). On such hosts every PTY case is skipped with a loud reason instead of failing; where stdin is deliverable the full interactive dock scenarios run for real. The deterministic SDK/RPC/component layers remain the authoritative gates in `npm run test` either way.

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

The Lane A residual hardening items, Fusion repair hardening, and the explicit `isAgent` agent-vs-script classification are covered by default unit/SDK/RPC/component/package gates plus full PTY and scripted-provider gates. `TEST_PLAN.md` remains the source of truth for future edge-case additions, especially any new telemetry surfaces added after this baseline.

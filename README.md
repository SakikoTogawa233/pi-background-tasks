# pi-background-tasks

Claude-Code-like explicit background shell task manager for [Pi](https://pi.dev/).

This package adds named, tracked background shell jobs with durable output files, bounded log reads, kill/timeout safety, task-owned context-window/token/tool-use/model telemetry, explicit Pi-agent telemetry wrapping for tasks marked as agents, a focused footer-dock task manager, `/tasks` fallback UI, and completion notifications that can wake the agent when LLM-launched work finishes. It also ships Fusion: a direct child-Pi five-call synthesis workflow exposed as `/fusion`, `/fusion-models`, and the always-active `fusion_brainstorm` tool. A terminal task status is published only after trailing wrapped-agent telemetry is consumed and final output plus terminal metadata have completed their durability writes.

## Install

From npm after publish:

```bash
pi install npm:pi-background-tasks@0.7.4
```

From git after pushing this package to its standalone repository and tagging:

```bash
pi install git:github.com/ismailsaleekh/pi-background-tasks@v0.7.4
```

For project-local install:

```bash
pi install -l npm:pi-background-tasks@0.7.4
```

## Commands

- `/bg [--agent] [--name "Task name"] <command>` — start a named tracked background shell command. Use `--agent` only when the command launches an LLM/agent.
- `/jobs` — list running and recent completed/failed/killed tasks.
- `/logs <id> [maxBytes]` — show bounded tail output and full output path.
- `/kill <id>` — stop a running task.
- `/tasks` or `/bg-tasks` — fallback command to open the task manager UI.
- `/bg-clear` — clear finished background-task footer notices.
- `/bg-update` — print update instructions when a newer published version exists (instruct-only; never self-installs).
- `/fusion <prompt>` — run three candidate child Pi final-text calls, one blind evaluator, and one merger, then append the merged answer directly as a visible `fusion-result` custom message without asking the parent model to rewrite it. Running `/fusion` without arguments opens a multiline editor in UI-capable modes; cancelling the editor does not spawn children.
- `/fusion-models` — TUI-only five-slot global model selector (`Candidate 1`, `Candidate 2`, `Candidate 3`, `Evaluator`, `Merger`). It supports duplicate selections, `$current` defaults, slash-containing model ids, atomic saves to `fusion-models.json`, and rejects non-TUI modes immediately.

## Footer dock UX

When tasks are active or unseen completions/failures exist, Pi shows a compact footer status:

```text
bg 2 running · Shift↓
bg 1 running · 1 failed · Shift↓ · /bg-clear
bg 2 done · Shift↓ · /bg-clear
```

Press `Shift+Down` to open the focused bottom dock. Arrow keys are captured only while the dock is focused. Each task row shows the latest context-window usage reported by that specific background task, for example `ctx 21.0%/200k`; tasks that do not report their own context show `ctx —` rather than the parent Pi session's usage. Background Pi-agent tasks also surface the LLM model they ran (`model gpt-5.5` in the compact row, fully-qualified such as `openai-codex/gpt-5.5` in the detail view), cumulative token usage (`tok 1.6k`), and tool-use counts (`tools 2/1 failed`) in the dock and detail view; missing model/token/tool telemetry is omitted in rows and shown as “not reported by this background task” in details. When a background command is explicitly marked as an agent and invokes a print/json child agent such as `pi -p ...` through the normal shell command name, the extension wraps that child Pi process with `--mode json`, parses real assistant usage/tool execution events, and emits task-owned telemetry automatically — including the model reported by the child assistant turns.

### Agent activity transcript

For those wrapped background Pi agents, the task output file and the dock's detail **Output tail** show a live, human-readable transcript of what the agent is actually doing — assistant messages, `→ tool args` calls, `… reasoning`, and `✗ tool failed` errors — as the agent loop runs. The machine telemetry (context/token/tool/model) is parsed out of the child stream and surfaced only as the metrics above and in `bg_status`/metadata, so the focused window reflects the agent's real activity rather than its raw instrumentation JSON. Child stderr is passed through to the transcript verbatim. Non-agent tasks and agent commands that cannot be wrapped (for example a path-qualified `pi`) keep streaming their raw stdout/stderr unchanged.

Finished-task badges intentionally remain visible until acknowledged. The reliable clear path is `/bg-clear`, which works in every terminal and clears finished background-task footer notices without opening the dock. `Ctrl+Alt+C` is still registered as an optional terminal-dependent fallback shortcut, but the footer advertises `/bg-clear` because some macOS terminals do not transmit `Ctrl+Alt+C` distinctly.

Dock controls:

| Key | Action |
|---|---|
| `Shift+Down` | Open focused background-task dock |
| `/bg-clear` | Clear finished-task footer notices from the main UI |
| `Ctrl+Alt+C` | Optional terminal-dependent shortcut for `/bg-clear` |
| `↑` / `↓` | Select task (list) · scroll the output tail (detail) |
| `PageUp` / `PageDown` | Page the task list (list) · page the output tail (detail) |
| `Enter` / `→` | Inspect logs/details |
| `←` | Return from details to list |
| `h` | Toggle recent history |
| `k` | Stop selected running task |
| `a` / `K` | Stop all running tasks, with confirmation |
| `r` | Refresh detail tail |
| `R` | Rerun selected command |
| `c` | Show copyable output path |
| `x` / `Esc` / `q` | Close dock |
| `/bg-update` | Print update instructions when a newer version is published |

In the detail view the **Output tail** is scrollable: `↑`/`↓` and `PageUp`/`PageDown` move through the loaded output (a generous bounded window, not just the last lines). Scrolling up pauses the live tail and freezes the view so it stays stable as new output arrives; the status line shows your position (e.g. `lines 46–57 of 60`). Scrolling back to the bottom (or pressing `r`) resumes live tailing.

### Update-available notice

When a newer version of `pi-background-tasks` has been published to npm, the footer appends a compact, instruct-only segment after the entry hint:

```text
bg 1 running · 1 failed · Shift↓ · /bg-clear · ⬆ v0.7.0 /bg-update
```

When no tasks are active, the notice still appears on its own (`bg ⬆ v0.7.0 /bg-update`) so the update hint is visible. The segment is rendered only when a strictly newer published version exists; `/bg-update` prints the npm and git update commands and never installs or self-updates.

The lookup runs at most once per session on `session_start`, is time-boxed, and is fully offline-safe: it never blocks or errors the footer/session, and on an offline or failed lookup it simply renders no segment (it never pins a misleading version). The check is skipped entirely when `PI_OFFLINE=1`, and can be disabled explicitly with `PI_BG_DISABLE_UPDATE_CHECK=1`. Set `PI_BG_REGISTRY_URL` to point the check at a registry mirror instead of `https://registry.npmjs.org`.

## LLM tools

- `bg_run` — start named long-running commands without blocking the conversation.
- `bg_run_pi_attested` — opt-in structured direct-spawn Pi agent task that emits a strict local attestation sidecar after successful completion.
- `bg_status` — inspect one task or all recent tasks.
- `bg_logs` — read bounded task output.
- `bg_kill` — stop a running task.
- `fusion_brainstorm({prompt})` — always-active tool that runs the Fusion workflow and returns the exact merged text as the tool result for the parent agent to consume, with the exact Pi `Usage` shape attached when the host supports tool-result usage: token fields plus complete `cost.input`, `cost.output`, `cost.cacheRead`, `cost.cacheWrite`, and `cost.total`. Its closed public schema has exactly one required parameter, `prompt`; extra keys are rejected. It has no eligibility, quota, routine, or justification gate. Tool context capture excludes the current assistant tool-call leaf when Pi is executing that `fusion_brainstorm` call, so the nested children do not see the in-progress tool call or sibling calls. Children receive the documented conversation projection described under [Conversation context policy](#conversation-context-policy): visible user/assistant text verbatim, with thinking and tool payloads replaced by explicit hash-accounted omission receipts. Because the prompt is composed by the parent agent, it is treated as authoritative and self-contained.

`bg_run` requires a concise `name` for the footer dock, the shell `command`, and required `isAgent: boolean`. Set `isAgent: true` only when the background task launches an LLM/agent process (for example `pi -p ...` or `pi --mode json ...`); set `isAgent: false` for scripts, tests, dev servers, sleeps, and ordinary shell commands. It defaults both `notifyOnCompletion` and `triggerOnCompletion` to `true`. With those defaults, `bg_run` returns immediately, the agent continues only independent useful work or ends its current turn instead of sleeping or polling, and a durable `background-task-notification` for completed, failed, or killed state automatically starts a follow-up turn. The launch receipt states the effective notification/wake behavior explicitly. `bg_status` and `bg_logs` remain available for user-requested inspection, deliberately disabled completion delivery, concrete hang diagnosis, or reading output after the terminal event; they are not waiting primitives, and the terminal notification does not need status reconfirmation. Setting `triggerOnCompletion: false` keeps the notification but prevents it from starting an agent turn. Setting `notifyOnCompletion: false` suppresses both notification and wake-up even if `triggerOnCompletion` is true.

Tasks marked with `isAgent: true` that launch print/json child Pi agents through the normal shell command name are telemetry-wrapped; set `PI_BG_DISABLE_PI_TELEMETRY=1` only when raw Pi stdout is required. The task snapshot and metadata expose `isAgent`, `contextUsage` (latest reported child assistant turn), cumulative `tokenUsage` (`input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`), cumulative `toolUsage` (`total`, `failed`, `byName`), and `model` (the LLM identifier reported by the child assistant turns, preferring the fully-qualified `provider/model` form) when reported by the child task. User-launched `/bg` jobs are display-only by default unless `--agent` is provided; UI reruns preserve the original task's `isAgent` value.

`bg_run_pi_attested` is separate from `bg_run` and never accepts a shell command. It takes structured `provider`, `model`, `prompt`, optional literal extra Pi argv, and a relative `reportPath`; launches exactly one direct `pi --mode json` child; records raw Pi JSON events, separate stderr, exact argv/cwd, prompt/report hashes, observed Pi session/provider/model, and `ModelRegistry.isUsingOAuth` credential class. It forbids direct API-key/auth-file launch arguments and emits no partial attestation: failures remain ordinary failed tasks with no sidecar.


## Fusion workflow

Fusion runs direct child `pi --mode text` processes only; it never calls `pi-ai` completion APIs. Each child is launched with `--no-session`, `--no-tools`, `--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-themes`, and `--no-context-files`, plus the resolved provider/model/thinking level and the package-owned private `extensions/fusion-child.ts` metadata extension. The prompt travels over stdin, not a shell or positional argument.

Pi text mode writes the final full answer exactly once instead of serializing cumulative reasoning/partial-message events on every token delta. The private child extension emits one compact, reasoning-free metadata record per finalized assistant message for provider/model, stop reason, the complete Pi token/cost `Usage` object, and response byte/hash validation. Fusion persists those compact records in `*.events.jsonl`; the complete answer remains in the stage response artifact. The 32 MiB child stdout cap therefore applies to one final response, not amplified JSON telemetry. Failed attempts keep the authoritative response artifact empty and, when any stdout was captured, persist it separately as an explicitly incomplete `*.response.partial.*` artifact.

Model configuration is global under the Pi agent directory:

```text
fusion-models.json
```

Missing config means all five slots are `$current`. Malformed config, stale explicit models, unavailable current models, and concurrent selector write conflicts fail loudly before child inference. Selector saves use an inter-process lock plus revision re-read before rename so simultaneous dialogs cannot silently overwrite each other. Candidate identities are anonymized before evaluation; provider/model metadata stays in local artifacts, not in evaluator prompts.

Progress is surfaced through `fusion` status updates, TUI cancellable loader UI for `/fusion`, and partial `fusion_brainstorm` tool updates. Session shutdown or reload tracks the whole invocation from entry, aborts live or initializing Fusion runs, and waits for cleanup.

### Conversation context policy

Fusion children receive a **versioned conversation projection**, not a raw execution transcript. The canonical input schema is `pi-background-tasks.fusion-input.v2` and every run states exactly what was included and what was omitted.

The projection transform (`visible-conversation-ledger-v1`) is shared by both entry points:

| Content | Disposition |
|---|---|
| User text | included verbatim, never clipped |
| Assistant text | included verbatim, never clipped |
| User image blocks | `[Image omitted from fusion text transcript: <mime-type>]` marker |
| Assistant thinking | excluded; recorded as an omission receipt |
| Tool-call arguments | excluded; recorded as an omission receipt |
| Tool-result payloads | excluded; recorded as an omission receipt |
| Tool-result images | excluded; recorded as an omission receipt (never raw bytes) |
| Active `fusion_brainstorm` call and its sibling calls | scope-excluded from the branch |

Omissions are **explicit, deterministic, and auditable** — never silent. Each omitted event produces a ledger row with its kind, exact byte count, and SHA-256 of the omitted bytes; contiguous omissions collapse into source-ordered `omitted_activity` receipts carrying counts, byte totals, and a run hash. The complete ledger is persisted as `context-omission-ledger.json`. **No head, tail, or preview of an omitted payload is ever forwarded** (`tool_payload_preview_bytes` is `0`), because an arbitrary prefix is usually irrelevant and can leak secrets or carry tool-output prompt injection. Repeated construction is byte-identical, so hashes are stable.

Two entry points share the transform but differ in request authority:

| Entry point | Policy id | `request.authority` |
|---|---|---|
| `fusion_brainstorm({prompt})` | `fusion-tool-explicit-v1` | `explicit_text` — the prompt is authoritative and self-contained |
| `/fusion [prompt]` | `fusion-command-conversation-v1` | `directive_over_projected_conversation` |

**Documented limitation:** facts that exist only inside omitted tool output are not available to Fusion children. Restate any required finding as visible conversation text, or include it in the `fusion_brainstorm` prompt. Children are instructed to say so plainly rather than guess. No model-generated summarization is used as hidden preprocessing.

### Stage budgets

Every prompt-expansion stage — candidate, evaluator, evaluation repair, and merger — is size-checked **before any child process is created**. Safety is based on the **smallest** configured model's context window, never the largest, so adding one small-context slot cannot be masked by large-context siblings.

The input token bound is `ceil(utf8Bytes / 2)`. This is a ceiling, not an estimate: across 159 real large Fusion prompts the densest observed ratio was 3.552 bytes per input token, so the divisor keeps roughly a 1.7x margin and also bounds dense non-ASCII input.

Downstream growth is guaranteed by two cooperating layers rather than by an assumption:

1. **Enforced output contracts.** Each stage has a maximum response size measured in *JSON-rendered transfer bytes* — the bytes the response actually costs once a later stage embeds it, escaping included (candidate 48 KiB, evaluator 64 KiB, merger 64 KiB, repair diagnostics 8 KiB). Measuring the rendered form removes any escaping guess: quotes, backslashes, and newlines expand 2x and control characters up to 6x, so a raw-byte contract would not bound the embedded size. A response over its contract is a loud `child_output_cap` failure; it is preserved in the run artifacts and is never sliced, truncated, or forwarded.
2. **An exact reserve.** The canonical input must leave room for the widest stage — the evaluation repair, which embeds three candidate answers, the invalid evaluator output, and diagnostics — plus fixed wrapper overhead. Because the contracts above are already rendered-byte bounds, this is an exact sum, not a raw size inflated by an estimated factor. The reserve is converted to tokens with the *same* `ceil(bytes / 2)` function used to measure prompts; reserving output *tokens* directly would understate the cost of re-embedding those bytes.

Each route additionally reserves its output contract, 4,096 framing, and 4,096 safety tokens. Because every step is uniformly conservative, the policy requires roughly a **168,000-token context window per configured slot**. Smaller routes are rejected at configuration time with an actionable error naming the requirement, rather than being accepted and failing later at the provider. Route capacities and the pre-candidate feasibility decision are persisted as `budget-plan.json`.

If an input still exceeds the safe budget, Fusion fails with a typed `prompt_budget_exceeded` error naming the stage, measured bytes, measured token upper bound, allowed tokens, the limiting configured model and its context window, and concrete remediation. **Zero children are launched** when preflight rejects. Provider context-window failures remain loud child failures; there is no hidden local truncation and no silent fallback anywhere in this path.

## Extension EventBus API

Version `0.7.0` exposes a real extension-to-extension service over Pi's documented `pi.events` bus. This is not a `ctx` method and it does not call a second task manager: requests route to the same `BackgroundTaskRegistry` used by `bg_run`, `bg_status`, `bg_logs`, and `bg_kill`.

Public constants are exported from `src/core/extension-api.ts`:

| Purpose | Value |
|---|---|
| Request channel | `pi-background-tasks:request:v1` |
| Response channel | `pi-background-tasks:response:v1` |
| Terminal channel | `pi-background-tasks:terminal:v1` |
| Request schema | `pi-background-tasks.extension-request.v1` |
| Response schema | `pi-background-tasks.extension-response.v1` |
| Terminal schema | `pi-background-tasks.extension-terminal.v1` |

Requests are closed frames: `{ schema_version, request_id, operation, payload }`, where `operation` is one of `capabilities`, `run`, `status`, `logs`, or `kill`. Responses echo the same `request_id` and `operation`, set `ok`, and contain exactly one of `result` or bounded `error`. Malformed frames, unknown keys, duplicate request IDs, requests before `session_start`, and requests during shutdown receive `ok: false`; they are not silently dropped or rerouted to shell fallback behavior.

`capabilities` returns exactly:

```json
{"api_version":1,"run":true,"run_is_agent":true,"run_completion_trigger":true,"status":true,"logs":true,"logs_bounded":true,"kill":true}
```

`run.payload` is the strict `bg_run` launch object: `name`, `command`, `isAgent`, `notifyOnCompletion`, `triggerOnCompletion`, plus optional positive-integer `timeoutSeconds`. The result is a `BgTaskSnapshot`. `status` returns `{ tasks }`; `logs` returns the existing bounded log detail fields plus bounded `text`; `kill` returns `{ task, message }`. Task status vocabulary is exactly `running`, `completed`, `failed`, or `killed`.

Terminal events keep the strict paired-consumer frame `{ schema_version: "pi-background-tasks.extension-terminal.v1", task }`. They are correlated by `task.id`, published exactly once per task after final output and terminal metadata durability, and for EventBus `run`/`kill` requests they are held behind a response barrier so even an immediately exiting or immediately killed child cannot emit its terminal event until the correlated response has been delivered and one microtask turn has allowed consumers to bind the returned task id. Terminal EventBus delivery exceptions are logged loudly and retried; a task is marked terminal-published only after the EventBus emit returns successfully.

## Runtime files

Task output and metadata are written under the current project:

```text
.pi/tasks/<session-id>-<pid>/<task-id>.output
.pi/tasks/<session-id>-<pid>/<task-id>.json
```

Fusion writes private debugging artifacts under:

```text
.pi/fusion/<session-id>-<pid>/<run-id>/
```

Each run contains `manifest.json`, `canonical-input.json`, `context-omission-ledger.json`, `budget-plan.json`, candidate/evaluation/merge prompts, raw child JSONL events, stderr, responses, `blind-candidates.json`, `evaluation.json`, `merged.md`, and `error.json` for failed/cancelled runs. Persisted stage prompts are byte-identical to the exact bytes written to that child's stdin. `context-omission-ledger.json` carries the complete source-ordered omission ledger, and `budget-plan.json` records every configured route's capacity plus the pre-candidate feasibility decision, so a rejected run is as auditable as a successful one. Artifact files are written by private temp-file/fsync/rename, and v2 manifests persist cumulative child usage plus per-attempt observed usage/model data for successful, failed, and cancelled child attempts. Every usage record preserves the complete Pi cost breakdown; the same exact shape is cloned into `fusion_brainstorm` tool results so newer Pi hosts can calculate and replay footer/session statistics safely. These artifacts are local evidence only; they are not shown in `/jobs` or the background-task dock.

For attested Pi tasks only, the task id is `b` plus 32 random hex characters (128 bits) and additional flat siblings are written in the same directory:

```text
.pi/tasks/<session-id>-<pid>/<task-id>.pi-events.jsonl
.pi/tasks/<session-id>-<pid>/<task-id>.stderr
.pi/tasks/<session-id>-<pid>/<task-id>.pi-telemetry-wrapper.cjs
.pi/tasks/<session-id>-<pid>/<task-id>.attestation.json
```

The attestation sidecar uses `schema_version: "phase2.pi_task_attestation.v1"` and is written last, after metadata/output/events/stderr/wrapper/report bytes are closed and hashed. An attested task does not become externally visible as `completed` until final metadata and the sidecar are durable. These are local runtime artifacts and should remain gitignored.

## Durability model

All task metadata, task output/events/stderr, attestation sidecars, Fusion artifacts, and the global `fusion-models.json` are written through one shared primitive in `src/core/durable-fs.ts`.

The invariant is: **open the file once with write intent, write and `fsync` through that same writable handle, then close.** A pathname is never reopened merely to flush it. This is required for Windows correctness — `FlushFileBuffers` needs a handle with write access, so flushing through a reopened read-only handle fails with `EPERM: operation not permitted, fsync` and previously broke every background task on Windows.

Two write modes are provided:

| Mode | Flags | Used for |
|---|---|---|
| Direct durable write | `w`, inherited mode | task output, events, stderr |
| Atomic replacement | private `0o600` temp with `wx`, then rename | task metadata, attestations, Fusion artifacts/manifests, model config |

Failure handling is loud and typed. Every open, write, `fsync`, rename, close, and temp-cleanup failure raises `DurableFileError` carrying the failing operation, path, native error code, and original cause. **A failed `fsync` is never tolerated or downgraded**, so the package cannot report durable state it did not actually achieve. A close or cleanup failure is attached as a secondary `cleanupFailures` entry and never replaces the primary error, and a temporary file is only removed when that same call created it.

**Platform limitation.** After the rename, the parent directory is itself `fsync`ed on POSIX so the new directory entry is crash-durable. Node exposes no portable equivalent on Windows, so that step is skipped there: file contents are still explicitly flushed before the rename and rename failures remain fatal, but the package cannot offer the same crash-durability guarantee for the directory entry on Windows. When a failure occurs after a successful rename, `DurableFileError.renameCompleted` is `true`, meaning the replacement may already be visible even though the operation reported an error.

## Safety model

- Commands are spawned and tracked with `child_process.spawn`; the package does not rely on shell `&`.
- Fusion inference is isolated to direct child `pi --mode text` invocations with tools/skills/session/context files disabled and only the package-owned compact metadata extension explicitly loaded; no direct completion API, API-key argument, or model fallback is used.
- Attested Pi tasks are a local, unsigned, same-user-writable attestation path for downstream gates. They bind source bytes and observed Pi/ModelRegistry facts; they are not cryptographic proof against a malicious local user, compromised Pi binary, or compromised provider.
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
npm run test:compat
```

Full interactive QA gate:

```bash
npm run test:full
```

The suite includes typecheck, unit, SDK, RPC, component, package, PTY/TUI, and scripted-provider coverage for the focused dock, lifecycle safety, and completion follow-up behavior.

Note: the repo QA standard requires exhaustive coverage of every public behavior and plausible edge case. `TEST_PLAN.md` tracks the current coverage matrix and any future edge-case additions.

This package follows the repo-wide Pi extension QA standard documented in:

- [`../EXTENSION_QA_STANDARD.md`](../EXTENSION_QA_STANDARD.md)
- [`../EXTENSION_TESTING_PLAYBOOK.md`](../EXTENSION_TESTING_PLAYBOOK.md)
- [`TEST_PLAN.md`](TEST_PLAN.md)
- [`TESTING.md`](TESTING.md)

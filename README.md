# pi-background-tasks

Claude-Code-like explicit background shell task manager for [Pi](https://pi.dev/).

This package adds named, tracked background shell jobs with durable output files, bounded log reads, kill/timeout safety, task-owned context-window/token/tool-use/model telemetry, explicit Pi-agent telemetry wrapping for tasks marked as agents, a focused footer-dock task manager, `/tasks` fallback UI, and completion notifications that can wake the agent when LLM-launched work finishes. It also ships Fusion: a direct child-Pi five-call synthesis workflow exposed as `/fusion`, `/fusion-models`, and the always-active `fusion_brainstorm` tool. A terminal task status is published only after trailing wrapped-agent telemetry is consumed and final output plus terminal metadata have completed their durability writes.

## Install

From npm after publish:

```bash
pi install npm:pi-background-tasks@0.7.7
```

From git after pushing this package to its standalone repository and tagging:

```bash
pi install git:github.com/ismailsaleekh/pi-background-tasks@v0.7.7
```

For project-local install:

```bash
pi install -l npm:pi-background-tasks@0.7.7
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
- `bg_delegate` — launch one background Pi agent seeded with a frozen projection of the current conversation, then return a launch receipt immediately. See [Delegated background agents](#delegated-background-agents).
- `bg_result` — retrieve a `bg_delegate` answer, hash-verified before it is returned.
- `bg_run_pi_attested` — opt-in structured direct-spawn Pi agent task that emits a strict local attestation sidecar after successful completion.
- `bg_status` — inspect one task or all recent tasks.
- `bg_logs` — read bounded task output.
- `bg_kill` — stop a running task.
- `fusion_brainstorm({prompt})` — always-active tool that runs the Fusion workflow and returns the exact merged text as the tool result for the parent agent to consume, with the exact Pi `Usage` shape attached when the host supports tool-result usage: token fields plus complete `cost.input`, `cost.output`, `cost.cacheRead`, `cost.cacheWrite`, and `cost.total`. Its closed public schema has exactly one required parameter, `prompt`; extra keys are rejected. It has no eligibility, quota, routine, or justification gate. Tool context capture excludes the current assistant tool-call leaf when Pi is executing that `fusion_brainstorm` call, so the nested children do not see the in-progress tool call or sibling calls. Children receive the documented conversation projection described under [Conversation context policy](#conversation-context-policy): visible user/assistant text verbatim, with thinking and tool payloads replaced by explicit hash-accounted omission receipts. Because the prompt is composed by the parent agent, it is treated as authoritative and self-contained.

`bg_run` requires a concise `name` for the footer dock, the shell `command`, and required `isAgent: boolean`. Set `isAgent: true` only when the background task launches an LLM/agent process (for example `pi -p ...` or `pi --mode json ...`); set `isAgent: false` for scripts, tests, dev servers, sleeps, and ordinary shell commands. It defaults both `notifyOnCompletion` and `triggerOnCompletion` to `true`. With those defaults, `bg_run` returns immediately, the agent continues only independent useful work or ends its current turn instead of sleeping or polling, and a durable `background-task-notification` for completed, failed, or killed state automatically starts a follow-up turn. The launch receipt states the effective notification/wake behavior explicitly. `bg_status` and `bg_logs` remain available for user-requested inspection, deliberately disabled completion delivery, concrete hang diagnosis, or reading output after the terminal event; they are not waiting primitives, and the terminal notification does not need status reconfirmation. Setting `triggerOnCompletion: false` keeps the notification but prevents it from starting an agent turn. Setting `notifyOnCompletion: false` suppresses both notification and wake-up even if `triggerOnCompletion` is true.

Tasks marked with `isAgent: true` that launch print/json child Pi agents through the normal shell command name are telemetry-wrapped; set `PI_BG_DISABLE_PI_TELEMETRY=1` only when raw Pi stdout is required. The task snapshot and metadata expose `isAgent`, `contextUsage` (latest reported child assistant turn), cumulative `tokenUsage` (`input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`), cumulative `toolUsage` (`total`, `failed`, `byName`), and `model` (the LLM identifier reported by the child assistant turns, preferring the fully-qualified `provider/model` form) when reported by the child task. User-launched `/bg` jobs are display-only by default unless `--agent` is provided; UI reruns preserve the original task's `isAgent` value.

`bg_run_pi_attested` is separate from `bg_run` and never accepts a shell command. It takes structured `provider`, `model`, `prompt`, optional literal extra Pi argv, and a relative `reportPath`; launches exactly one direct `pi --mode json` child; records raw Pi JSON events, separate stderr, exact argv/cwd, prompt/report hashes, observed Pi session/provider/model, and `ModelRegistry.isUsingOAuth` credential class. It forbids direct API-key/auth-file launch arguments and emits no partial attestation: failures remain ordinary failed tasks with no sidecar.


## Delegated background agents

`bg_delegate` fills the gap between `bg_run` (a background agent with a **fresh,
empty** context) and `fusion_brainstorm` (your current context, but synchronous
and five-model). It is one agent, one prompt, seeded with the current session's
context, non-blocking. `bg_result` retrieves its answer safely. They ship
together: a delegate without a safe retrieval path could not return its work.

```text
bg_delegate({ name, prompt })              → launch receipt, immediately
  … the parent keeps working; the terminal notification wakes it …
bg_result({ taskId })                      → hash-verified answer
```

### Context seeding

The child does **not** share the parent's live session. The parent conversation
is projected with the same frozen `visible-conversation-ledger-v2` transform
Fusion uses (see [Conversation context policy](#conversation-context-policy)),
frozen as an immutable seed, and the child is given its **own** `--session-id`
and a task-owned `--session-dir`. Conceptually it has your context; physically it
can never open or mutate the parent session.

| Content | Disposition |
|---|---|
| User text | included verbatim, never clipped |
| Assistant text | included verbatim, never clipped |
| User image blocks | marker only, never raw bytes |
| Assistant thinking | excluded; recorded as a hash-accounted omission receipt |
| Tool-call arguments | excluded; recorded as a hash-accounted omission receipt |
| Tool-result payloads | excluded; recorded as a hash-accounted omission receipt |
| The in-flight `bg_delegate` call and its sibling calls | scope-excluded from the branch |

The assistant message carrying the in-flight call is excluded as a whole, so when
several `bg_delegate` calls share one assistant message **every** sibling call is
excluded for **every** child: two delegates launched together receive identical
projected history and neither can observe the other's arguments.

The seed is canonical-JSON, SHA-256'd, and persisted. The persisted bytes are the
exact bytes the child reads, and the child re-verifies that hash **before its
first model call**. Repeated construction from the same session is
byte-identical.

**Documented limitation:** facts that exist only inside omitted parent tool
output are **not** available to the child. The child is told this explicitly and
instructed to say so plainly rather than guess. Restate any such finding in the
`prompt`.

### Route pinning

The route is pinned at launch — by default the parent's current effective
provider/model, or an explicit `route {provider, model}`. It is **never**
substituted, never falls back, and is never retried on a different route. An
unavailable route or one with no declared context window is a typed refusal
before anything is created. The child additionally asserts that every assistant
message it produced came from the pinned route; a mismatch prevents the run from
committing an answer at all.

### Inspect-only capability boundary

v1 supports exactly one capability, `inspect`. The child is launched with
`--tools read,grep,find,ls,delegate_read_artifact`, `--no-builtin-tools`, an
explicit `--exclude-tools` denylist, and no ambient extensions, skills, prompt
templates, themes, or context files. **The boundary is enforced by argv and the
child's tool registry, not by prompt text.** There is no shell, no network, no
edit/write, no recursive delegation, and no Fusion from the child. Writable
profiles are deliberately out of scope.

### Budgets, spilling, and limits

Admission is checked **before** the child process, the child session, or the
artifact directory exists, so a refusal leaves **zero** children and **zero**
artifacts. Inside the child, every model call is measured before dispatch; a call
that would exceed the pinned route's allowance is refused and the run terminates
with a typed `provider_context_budget_exhausted`.

A tool result larger than the per-result transcript cap is written **in full** to
a hashed artifact and replaced in the transcript by an explicit receipt naming
the artifact, its exact byte count, its SHA-256, and how to read a bounded range.
The raw payload never enters the transcript and **nothing is truncated**. The
bounded `delegate_read_artifact` tool returns exactly the requested range or
fails; a request past end-of-file is refused rather than silently shortened.
Turn, tool-call, aggregate-output, and wall-clock limits are enforced and
reported.

### Retrieving the answer

The child commits exactly one self-contained result package by temp-write,
`fsync`, rename, directory `fsync`. **The rename is the commit point**: a package
present under its final name is complete, and its absence means no answer was
accepted — whatever the process exit code was. A child that exits `0` without
committing is a typed `child_exited_without_commit`, never a silent empty
success. A run that degraded anything latches terminal state and **cannot**
commit a success package, so a hash-valid answer can never be built on silently
mutilated context.

`bg_result` verifies the package identity, seed hash, route, every per-block
SHA-256, and the aggregate SHA-256 before returning a single byte, and returns
bytes from the buffer it verified. A running task returns a typed *not ready*
result and **never blocks or polls**. An answer over the inline cap degrades to
an artifact reference **explicitly**; requesting `delivery:"inline"` for it is a
typed `result_too_large_for_inline` failure naming the artifact. It is **never**
truncated to fit. `autoDeliver` (`never` | `when_small` | `always`) defaults to
`never`: completion notifications carry metadata, and the answer is fetched
deliberately with `bg_result`.

### Failure taxonomy

Every delegate failure is typed and states what happened, what was preserved, and
what the operator can do. Admission codes
(`delegate_hook_contract_unsupported`, `delegate_isolation_unsupported`,
`route_unresolved`, `route_capacity_unknown`, `seed_projection_failed`,
`seed_budget_exceeded`, `seed_persist_failed`, `invalid_arguments`) always report
`childCreated: false`. Execution and integrity codes include `child_spawn_failed`,
`child_timeout`, `child_cancelled`, `child_turn_limit`, `child_tool_call_limit`,
`child_exited_without_commit`, `provider_context_budget_exhausted`,
`aggregate_tool_output_cap`, `child_result_invalid`,
`child_result_encoding_invalid`, `route_attestation_missing`, `route_mismatch`,
`seed_hash_mismatch`, `answer_hash_mismatch`, `artifact_spill_failed`, and
`artifact_read_failed`. Retrieval states are `result_not_ready`,
`result_unavailable`, `result_too_large_for_inline`, and `task_unknown`.

Usage that the provider did not report is recorded as explicitly `unavailable`,
never as zero.

### Proven Pi hook contract

The child-side guard depends on runtime Pi behaviour, which is **proven by
execution** rather than read from type declarations. The
`npm run test:hook-contract` gate drives a real Pi agent loop and records what it
observed. On Pi 0.83 it establishes that `context` fires once before every model
call in extension load order and that returned messages reach the provider; that
**throwing** from a `context` handler does **not** block the call (Pi catches it
and dispatches anyway); that `ctx.abort()` does not skip the provider call site
but hands it an already-aborted signal and terminates the run; and that
`tool_result` fires before the result enters the transcript, chains in load order,
and preserves tool-call id, role, and error flag across replacement.

Because neither a throw nor an abort is a hard admission gate on its own, the
guard uses abort as the barrier **and** removes the oversized content from the
outgoing message set, so the request cannot carry it even if a provider ignored
the aborted signal. If a Pi build cannot provide the required guarantees,
`bg_delegate` refuses to spawn with a typed
`delegate_hook_contract_unsupported`; the guard is never weakened to fit.

Delegate artifacts are written under:

```text
.pi/delegate/<session-id>-<pid>/<task-id>/
```

Each run contains `seed.json`, `child-prompt.txt` (the exact bytes handed to the
child over stdin, never a shell or positional argument),
`context-omission-ledger.json`, `budget-plan.json`, `manifest.json`, the
task-owned `child-session/`, any `spill/` artifacts, `result.json` once the child
commits, and `outcome.json` once the parent adjudicates the run.

`result.json` is written by the **child** and `outcome.json` by the **parent**, so
neither writer can claim a state it did not observe. `manifest.state` records only
what the parent knew at launch and is never used to decide success.

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

Fusion children receive a **versioned conversation projection**, not a raw execution transcript. The canonical input schema is `pi-background-tasks.fusion-input.v4` and every run states exactly what was included and what was omitted.

The projection transform (`visible-conversation-ledger-v2`) is shared by both entry points:

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

Omissions are **explicit, deterministic, and auditable** — never silent. Each omitted event produces a ledger row with its kind, exact byte count, and SHA-256 of the omitted bytes. Fusion v4 encodes child-facing projection entries as positional tuples to remove repeated object keys while preserving every role, ordinal, span, byte total, count, and text byte:

```json
["t","u",0,0,"hello"]
["o",[1,9],29019,[0,5,5]]
```

Text tuples are `["t", role, sourceOrdinal, blockOrdinal, text]`, where `role` is `"u"` for user or `"a"` for assistant. Omission tuples are `["o", [firstSourceOrdinal, lastSourceOrdinal], bytes, [assistantThinking, toolCalls, toolResultTexts]]`. The span is inclusive, `bytes` is the total omitted non-image payload for that run, and the count tuple order is fixed. Per-event hashes, ledger indices, and per-event byte details live in `context-omission-ledger.json`, not in the prompt: a child cannot verify a hash of payload it does not hold, so forwarding one only consumed context. That ledger also carries a `projection_map` proving every ledger row is represented by exactly one receipt or ledger-only image marker, and `accounting.omission_receipt_utf8_bytes` records the exact compact tuple receipt cost. The complete ledger is persisted as `context-omission-ledger.json`, and its row shape and root hash are unchanged by the compact encoding. **No head, tail, or preview of an omitted payload is ever forwarded** (`tool_payload_preview_bytes` is `0`), because an arbitrary prefix is usually irrelevant and can leak secrets or carry tool-output prompt injection. Repeated construction is byte-identical via canonical JSON, so prompt bytes and hashes are stable.

Two entry points share the transform but differ in request authority:

| Entry point | Policy id | `request.authority` |
|---|---|---|
| `fusion_brainstorm({prompt})` | `fusion-tool-explicit-v2` | `explicit_text` — the prompt is authoritative and self-contained |
| `/fusion [prompt]` | `fusion-command-conversation-v2` | `directive_over_projected_conversation` |

**Documented limitation:** facts that exist only inside omitted tool output are not available to Fusion children. Restate any required finding as visible conversation text, or include it in the `fusion_brainstorm` prompt. Children are instructed to say so plainly rather than guess. No model-generated summarization is used as hidden preprocessing.

### Stage budgets

Every prompt-expansion stage — candidate, evaluator, evaluation repair, and merger — is size-checked **before any child process is created**, and each stage is checked against **its own configured route**, so a large-context slot cannot hide a small-context sibling and a small slot cannot veto stages it never serves.

Input forecasting uses the shared affine estimator `estimateInputTokens({family, segments})`: additive integer byte-class accounting plus a 512-token affine intercept. Calibrated normal-ASCII rates are used only for backed exact model IDs, measured prompts at or above 50 KiB, and prompts that pass the low-whitespace dense-ASCII gate. That gate records the measured whitespace fraction in `budget-plan.json` and falls back conservatively for out-of-distribution near-zero-whitespace payloads; it is a heuristic token-density proxy, not a bound. Multibyte UTF-8 uses the conservative 2.0 B/tok fatal rate while persisting the provable 1.00 B/tok ceiling as advisory. The calibration basis is 882 real large Fusion prompts: Anthropic observed floor 2.047 B/tok (shipped `r=1.73`) and Codex observed floor 3.400 B/tok (shipped `r=2.89`); unknown providers and unbacked model IDs use the unbacked 1.00 B/tok floor and are surfaced in artifacts and result details.

Each stage is forecast with its **real prompt builder**, rendered with empty embedded-output slots, plus the enforced output contracts for whatever that stage will embed:

| Stage | Embeds | Mandatory |
|---|---|---|
| `candidate` | canonical input only | yes, once per slot |
| `evaluation` | + 3 candidate answers | yes |
| `evaluation_repair` | + 3 candidates, invalid evaluator output, diagnostics | conditional, still budgeted |
| `merge` | + 3 candidates, validated evaluation | yes |

`evaluation_repair` only runs when the evaluator returns schema-invalid JSON, but it is budgeted unconditionally: "uncommon" is not a reliability contract.

Output sizes are guaranteed by **enforced contracts**, not assumptions. Each stage has a maximum response size measured in *JSON-rendered transfer bytes* — the bytes the response actually costs once a later stage embeds it, escaping included (candidate 48 KiB, evaluator 64 KiB, merger 64 KiB, repair diagnostics 8 KiB). Measuring the rendered form removes any escaping guess: quotes, backslashes, and newlines expand 2x and control characters up to 6x. A response over its contract is a loud `child_output_cap` failure; it is preserved in the run artifacts and is never sliced, truncated, or forwarded.

When a workflow cannot fit, the error names the **first failing mandatory stage** in deterministic order (candidate slots, then evaluation, then merge), lists every other blocking stage, and labels conditional ones. It never blames a stage that would have succeeded.

Remediation is derived, not guessed: Fusion re-plans the entire workflow **with the request removed**. If it still fails, the error says plainly that shortening the request cannot help and points at starting a fresh conversation or raising the route's context window. If it then fits, the request is what determines feasibility, and the error states the exact minimum byte reduction and the maximum safe request size.

Preflight is two-tiered: input-only forecasts are fatal (`prompt_budget_exceeded_forecast`), while worst-case downstream output reservations are warning-only and recorded in `budget-plan.json`. Exact rendered per-stage checks remain fatal (`prompt_budget_exceeded_measured`). Runs that fit still emit advisory warnings for tight utilization or reservation overage. The warning never alters behaviour.

Every configured route must also satisfy a documented minimum capacity; smaller routes are rejected at configuration time with an actionable error naming the requirement, rather than being accepted and failing later at the provider. All route capacities, per-stage forecasts, headroom, utilization, the byte composition of the blocking stage, and the blockers list are persisted as `budget-plan.json`.

If an input still exceeds the safe budget, Fusion fails with `prompt_budget_exceeded_forecast` for input-only preflight or `prompt_budget_exceeded_measured` for exact rendered prompts. The error names the stage, measured bytes, measured token upper bound, allowed tokens, the limiting configured model and its context window, estimator source, and concrete remediation. **Zero children are launched** when preflight rejects. Provider context-window failures remain loud child failures; there is no hidden local truncation and no silent fallback anywhere in this path.

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
- On Windows, process-tree termination uses `%SystemRoot%\\System32\\taskkill.exe` directly (never `PATH`) with a two-stage `/T` then `/T /F` flow. Stage one is a logical Windows termination request, not SIGTERM and not a guaranteed graceful shutdown: console processes may ignore it, and re-parented descendants can escape the tree. Strong containment would require Windows Job Objects via a native component, which is out of scope.
- Running tasks are cleaned up on Pi session shutdown/reload.
- Child Pi processes are never launched through a shell. On Windows the npm `pi.cmd` shim is deliberately not executed, because a batch shim cannot preserve argument bytes safely; the package resolves the Pi package's own CLI entry and launches it with `process.execPath` instead. Batch, PowerShell, and extensionless launch targets are rejected loudly rather than executed, and a launch target resolving outside the Pi package root is rejected.
- Cross-Pi-restart process reattachment and Ctrl+B backgrounding of already-running foreground tools are intentionally out of scope.

### Windows shell and telemetry

`cmd.exe` remains the default Windows shell, so existing commands written for `cmd` keep working unchanged. The generic `SHELL` variable is deliberately ignored on Windows, because honouring it would silently change the command language for `%VAR%`, `set`, `dir`, backslash paths, and quoting.

A POSIX shell is available as an explicit opt-in via `PI_BG_SHELL=bash`, with an optional absolute `PI_BG_SHELL_PATH`. Invalid values fail loudly rather than falling back. Bash is invoked with `-c` and never `-lc`, because a login shell runs profile scripts whose banner output would be captured into task output.

**Documented limitation:** `isAgent: true` Pi-agent telemetry wrapping works by installing a POSIX shell function that intercepts `pi`. That mechanism has no safe `cmd.exe` equivalent, so under the Windows `cmd` dialect the command is left byte-for-byte unchanged and telemetry is reported as unavailable with the reason `win32-cmd-cannot-safely-intercept-pi-argv`. Zero usage is never synthesized, and no warning text is injected into captured command output. Use `PI_BG_SHELL=bash` on Windows when agent telemetry is required.

On Windows, argument lists are checked against the 32,767-code-unit command-line limit before a child is created, so an oversized invocation fails loudly with the measured length rather than producing a confusing native spawn error. Argument contents are never included in that error.

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

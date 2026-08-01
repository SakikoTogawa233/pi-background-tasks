# Implementation brief: `bg_delegate` + `bg_result`

You are the sole implementation owner for two new public tools in the
`pi-background-tasks` Pi extension package.

**PERFECT QUALITY IS MANDATORY.** A partial workaround, silent truncation, silent
fallback, model substitution, weakened test, undocumented behaviour change, or
cosmetic green result is unacceptable. Diagnose and implement the
architecturally correct solution. If any requirement cannot be satisfied
honestly, halt and report the exact blocker instead of weakening the solution.

Repository: `/Users/lizavasilyeva/work/ai-pipeline/packages/pi-background-tasks`

---

## 0. Operating rules

- Preserve all existing work. Inspect `git status` first. Do **not** run
  `git reset`, `restore`, `stash`, `clean`, `commit`, or `push` unless the
  operator explicitly asks.
- **Subscription routes only.** Never use metered OpenAI, Anthropic, OpenRouter,
  or any other paid API credential. Claude-class work goes through the Pi
  subscription harness, GPT-class through the Codex subscription.
- Use `fusion_brainstorm` at the critical decision and validation points marked
  **[FUSION]** below. Run the first one early, while your transcript is still
  small. Preserve its conclusions as design evidence in your report.
- Do not blindly follow Fusion. If you disagree, say so and justify. Record the
  final reasoning either way.
- Separate implementation from verification. Verify claims yourself; do not
  trust a summary, including your own.
- Run focused tests during implementation; run the full suite once focused gates
  are green.
- Never weaken an existing test to make something pass. If an assertion becomes
  genuinely wrong because of an intended change, replace it with a **stronger**
  one and say why.

---

## 1. Onboarding — read completely before designing

Package docs and conventions:

- `README.md` — public surface, conversation context policy, stage budgets
- `TESTING.md`, `TEST_PLAN.md` — gates and the coverage matrix you must extend
- `PUBLISHING.md`, `package.json`

Existing implementation you will reuse or extend:

- `src/extension.ts` — how `bg_run`, `bg_status`, `bg_logs`, `bg_kill`,
  `bg_run_pi_attested` are registered; `prepareArguments`, `renderCall`,
  `renderResult`, progress updates
- `src/core/registry.ts` — background task lifecycle, telemetry parsing,
  terminal notification, process-tree kill
- `src/core/common.ts` — `BgTaskSnapshot`, shared task types
- `src/core/pi-launch.ts` — how a child `pi` is located and launched
- `src/core/attested-pi-run.ts` — structured direct spawn + attestation sidecar
- `src/core/durable-fs.ts` — atomic write / fsync / hashing helpers
- `src/core/fusion/context.ts` — `projectFusionConversation()`, the omission
  ledger, `projection_map`, canonical input builder
- `src/core/fusion/budget.ts` — route capacities, `fusionTokenUpperBound`,
  per-stage forecasts, output contracts, typed refusal
- `src/core/fusion/pi-child.ts` — child `pi` spawn, JSON/text event parsing,
  cancellation, process-tree termination
- `src/core/fusion/artifacts.ts` — durable run artifacts and manifests
- `src/fusion-child-extension.ts` + `extensions/fusion-child.ts` — the existing
  **package-owned child extension** pattern you will follow
- `src/core/fusion/types.ts` — schema-version and typed-error conventions
- Tests: `tests/unit/fusion-*.test.ts`, `tests/sdk/fusion-sdk.test.ts`,
  `tests/rpc/fusion-rpc.test.ts`, `tests/package/package.test.ts`,
  `tests/helpers/fusion-canonical.ts`, `tests/helpers/fusion-fake-pi.ts`

Pi 0.83 documentation and type definitions (read the real files, do not assume):

- `/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/docs/extensions.md`
- `.../docs/packages.md`, `.../docs/sdk.md`
- `.../dist/core/extensions/types.d.ts` — especially `ContextEvent`,
  `ContextEventResult`, `BeforeProviderRequestEvent`, `ToolCallEvent`,
  `ToolCallEventResult`, `ToolResultEvent`, and the `on(...)` overloads
- `pi --help` — `--tools`, `--exclude-tools`, `--no-tools`,
  `--append-system-prompt`, `--system-prompt`, `--session-id`, `--session-dir`,
  `--mode json`, `--print`, `--extension`

---

## 2. What we are building, and why

The package already has two spawn shapes:

- `bg_run` with `isAgent:true` — a background agent with a **fresh, empty**
  context. Non-blocking; wakes the parent on completion.
- `fusion_brainstorm` — takes the **current session context**, but is
  synchronous, and fans out to five model calls for one synthesised answer.

**The gap:** "go investigate this in the background — you already know
everything I know." One agent, one prompt, seeded with the current session's
context, non-blocking.

That is `bg_delegate`. `bg_result` retrieves its answer safely.

Both ship in the same release. `bg_delegate` is incomplete without `bg_result`.

### Decided design (do not relitigate)

- **Do not share the parent's live session.** Project the parent conversation,
  freeze it as an immutable seed, and give the child its **own** `--session-id`
  and task-owned `--session-dir`. Conceptually it has your context; physically
  it can never open or mutate the parent session.
- **Route is pinned at launch.** Default is the parent's current effective
  provider/model. Optional explicit `route`. **Never** substitute, fall back, or
  retry on a different route — fail loudly.
- **v1 is inspect-only.** Read/list/search style tools only. No shell, no
  network, no edit/write, no recursive delegation, no Fusion from the child.
  Writable profiles are explicitly out of scope.
- **No silent truncation anywhere**, consistent with the package's existing
  doctrine. Oversized content becomes an explicit, hash-accounted receipt.

---

## 3. Investigation phase — do this before writing code

### 3.1 Pi hook characterisation (highest risk — do it first)

The child-side safety design depends on Pi behaviour that has been read from
type definitions but **not executed**. Prove it empirically with a small
harness (a fake/scripted provider, in the spirit of
`tests/scripted-provider/`), for the Pi version(s) this package supports:

1. Does `pi.on("context", ...)` fire before **every** model call?
2. Does returning `{messages}` from a `context` handler actually change what is
   sent to the provider?
3. Does **throwing** inside a `context` handler prevent the provider call from
   being dispatched at all?
4. Does `tool_result` fire before the result enters the transcript, and can a
   handler replace that content?
5. After replacement, do tool-call IDs, roles, and `isError` remain valid?
6. What is the handler ordering guarantee when several extensions register?

Record the answers as durable evidence. If any of 1–5 does not hold, the
child-side guard must be redesigned — **report that rather than assuming**.
Gate spawning behind a typed `delegate_hook_contract_unsupported` failure when
the running Pi cannot provide the guarantees.

### 3.2 Reuse seam

Fusion owns an expensive, well-tested projection + budget engine. `bg_delegate`
must reuse it **without destabilising Fusion**.

- Before extracting anything, freeze golden fixtures for Fusion's canonical
  input bytes, ledger root hashes, and budget plans. **If any Fusion byte
  changes as a result of extraction, the extraction is wrong.**
- `bg_delegate` must **not** import `buildFusionCanonicalInput()` and must not
  emit `fusion-input.v3`. It gets its own versioned seed schema
  (e.g. `pi-background-tasks.delegate-seed.v1`) wrapping the shared projection.
- Decide what genuinely needs extracting versus what can be called as-is.
  Prefer the smallest seam that works.

**[FUSION #1 — run this early]** Ask `fusion_brainstorm` to review your
extraction plan: which modules to share, what stays private to Fusion, how to
guarantee byte-identity, and the risks of the seam you chose.

---

## 4. Required design properties

1. The parent conversation is projected with the **existing** policy: visible
   user/assistant text verbatim; assistant thinking and tool payloads replaced
   by deterministic hash-accounted omission receipts; images marker-only, never
   raw bytes.
2. The in-flight `bg_delegate` tool call and its sibling calls are excluded from
   the projection, exactly as Fusion excludes its own call.
3. The `prompt` argument is authoritative; projected history is supporting,
   untrusted context. The child must be told this explicitly.
4. Repeated construction of the seed is **byte-identical**; hashes are stable.
5. The seed, budget plan, ledger, child events, stderr, and final answer are all
   persisted as durable, hashed artifacts. Persisted prompt bytes must equal the
   exact bytes sent to the child.
6. Budget preflight runs **before** the child process, session, or artifacts are
   created. On refusal, zero child processes exist.
7. Inside the child, every model call is measured before dispatch. Oversized
   tool results are spilled to hashed artifacts and represented by an explicit
   receipt (with a bounded artifact-read tool), never silently trimmed.
8. Turn, tool-call, timeout, and output limits are enforced and reported.
9. Failure is a typed, actionable taxonomy — not an opaque crash. Every failure
   states what happened, what was preserved, and what the operator can do.
10. Cancellation, process-tree termination (POSIX **and** Windows), usage
    accounting, progress events, and the existing durable
    `background-task-notification` semantics are preserved.
11. `bg_result` verifies the answer against its recorded SHA-256 before
    returning it, and never returns a silent prefix.

**[FUSION #2]** Before implementing, ask `fusion_brainstorm` to pressure-test
your full design: the seed schema, the child guard state machine, the artifact
spill protocol, the failure taxonomy, and the result contract. Ask specifically
what breaks under: a 2 MB tool result, thousands of small results, concurrent
tool calls, cancellation mid-write, disk-full, and a Pi version whose hooks
behave differently.

---

## 5. Tool contracts (starting point — refine and justify any change)

### `bg_delegate`

Parameters: `name`, `prompt`, optional `route {provider, model}`, `cwd`,
`capability` (`inspect` default), `maxTurns`, `maxToolCalls`, `timeoutSeconds`,
`notifyOnCompletion`, `triggerOnCompletion`.

Returns a launch receipt immediately (task id, pinned route, child session id,
artifact root, effective notification/wake behaviour), after successful
preflight and spawn. Pre-spawn failures are typed tool errors, not receipts.

Consider an explicit `autoDeliver` policy (`never` | `when_small` | `always`)
controlling whether the completion notification carries the full answer or only
metadata plus an artifact reference. Small answers are delivered inline; over
the cap it degrades to a receipt **explicitly**, never a silent prefix. Decide
the default and justify it.

### `bg_result`

Parameters: `taskId`, optional `delivery` (`inline` | `artifact`).

- Task still running → typed "not ready"; never block or poll.
- Completed → hash-verified answer plus route, usage, turns, artifact refs.
- Failed/cancelled → the typed terminal result and forensic artifacts.
- `inline` when the answer does not fit safely → typed failure naming the
  artifact reference. **Never** truncate to fit.

---

## 6. Required tests

Extend the existing gates; follow the existing test layering (unit → sdk → rpc →
package, plus scripted-provider where a real agent loop matters).

**Context seeding**
- Visible user/assistant text preserved verbatim; thinking and tool payloads
  excluded; images marker-only with no raw bytes anywhere in child stdin.
- The in-flight `bg_delegate` call and siblings are excluded.
- Byte-identical seed across repeated construction and across separate processes.
- The prompt is authoritative and preserved exactly.

**Budget and guard**
- Preflight rejection creates zero child processes.
- Child-side guard blocks a model call that would exceed the route window, and
  surfaces a typed, parseable failure to the parent.
- A large tool result is spilled to a hashed artifact and represented by a
  receipt; the raw payload never reaches the transcript.
- Bounded artifact read returns exactly the requested range or fails; it never
  silently shortens.

**Lifecycle**
- Launch receipt shape and truthful notification/wake behaviour.
- Completion wakes the parent exactly once, as `bg_run` does today.
- Cancellation and timeout terminate the whole process tree on POSIX and
  Windows; artifacts remain valid.
- Usage/telemetry aggregation is correct.

**`bg_result`**
- Not-ready, completed, failed, cancelled paths.
- Hash verification; corruption is detected and reported.
- Inline-vs-artifact delivery; oversized answers never truncate.

**Mutation resistance** (the package already does this — extend it)
- Tests must fail if someone reintroduces silent truncation, a silent fallback,
  a route substitution, an unbounded inline answer, or a dropped preflight.

**Compatibility**
- The packed package still loads; `bg_delegate`/`bg_result` are registered.
- No existing Fusion artifact bytes changed.

---

## 7. Verification order

1. `npm run typecheck`
2. `npm run test:type-safety`
3. Focused new unit tests
4. Focused SDK / RPC / scripted-provider tests
5. `npm run test:package`
6. `npm test` (full) — once, after focused gates are green
7. `npm run pack:dry-run` and inspect packed contents
8. A **real subscription-only** `bg_delegate` run from a genuinely large session,
   proving the child completed with projected context, produced a verified
   answer, and that `bg_result` returned it

Note: `npm run test:type-safety` bans the bare word `an`+`y` anywhere in package
TypeScript **including comments and test names**, plus `@ts-ignore`, double
assertions, and production non-null assertions. Word your comments accordingly.

**[FUSION #3]** After implementation and before finalising, ask
`fusion_brainstorm` to review the delivered design and tests for gaps —
especially anything that could silently lose or truncate content, misreport
success, or leave an orphaned process.

---

## 8. Documentation

Update `README.md` (public surface, both tools, the context-seeding policy, the
inspect-only capability boundary, and the honest limitation that facts existing
only inside omitted parent tool output are unavailable to the child),
`TESTING.md`, and the `TEST_PLAN.md` coverage matrix. The package's docs gate
asserts these — an undocumented behaviour change is a failure, not a nit.

---

## 9. Deliverable

A complete implementation report containing: the hook-characterisation results
(with evidence), the Fusion analysis and where you agreed or disagreed, the
chosen design and why, schema/API additions, exact files changed, the failure
taxonomy, tests and mutation coverage, commands with exit statuses, live
subscription evidence, and any remaining limitations stated honestly.

Final acceptance requires:

- the Pi hook contract is **proven**, not assumed;
- projected context reaches the child and is byte-identical across runs;
- no silent truncation or fallback exists anywhere in the path;
- oversized content is explicit and hash-accounted;
- preflight rejection creates zero children;
- `bg_result` never returns an unverified or silently shortened answer;
- Fusion's existing artifact bytes are unchanged;
- all package tests and packing checks are green;
- a real subscription-only run demonstrates the whole loop.

**PERFECT QUALITY IS MANDATORY.**

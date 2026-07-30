# Fusion large-context reliability + Pi 0.83 compatibility — implementation report

## 1. Root cause

`buildFusionCanonicalInput()` serialized the entire effective conversation branch through
`serializeFusionConversation()`, which forwarded complete tool-call arguments and complete
tool-result payloads. In a long agentic session, tool traffic dominates the transcript.

Measured from the durable evidence at
`.pi/fusion/019fafe3-c192-7810-8358-9e13af5f5d34-86847/fc6dc6289e75d431c52257ecfa6096aae/`:

| Component | Bytes | Share of transcript |
|---|---:|---:|
| Tool results | 696,929 | 67.4% |
| Tool-call arguments | 251,508 | 24.3% |
| User text | 34,959 | 3.4% |
| Assistant text | 24,733 | 2.4% |
| Assistant thinking | 10,303 | 1.0% |
| **conversation_transcript** | **1,034,045** | 100% |
| system_prompt | 13,368 | |
| request | 726 | |
| **canonical-input.json** | **1,074,041** | |

All three candidate prompts were byte-identical at 1,074,041 B (verified by `wc -c`). Slot 3
(`openai-codex/gpt-5.5`, 272,000-token window) rejected it:

```text
Codex error: Your input exceeds the context window of this model.
```

**Arithmetic confirmation.** Across 159 real large Fusion prompts recorded in `.pi/fusion`, the
densest observed ratio was 3.552 bytes per reported input token. At that rate:

```text
1,074,041 B / 3.552 B/tok = 302,376 tokens  vs  272,000-token window
=> 30,376 tokens over (1.11x)
```

The provider rejection is fully explained by input size alone. The orchestrator then correctly
cancelled slots 1 and 2 and failed fast, exactly as designed. This was exposed after Pi 0.83.0 but
is **not** caused by the TypeBox API removal — no removed API is referenced anywhere in the package.

91.7% of the payload was tool traffic that the package had promised to forward in full. That promise
was the defect: an unbounded execution log was being treated as conversation.

## 2. Fusion analysis

`fusion_brainstorm` was consulted twice from a fresh session, and its conclusions changed the design
materially in both cases.

**First consultation** (design). Recommended replacing full transcript forwarding with a versioned,
loss-accounted *visible-conversation projection*, on the reasoning that tool traffic is execution
provenance rather than conversational context. Specific recommendations adopted:

- Zero payload-preview bytes, rejecting even a "declared" 200-character head: an arbitrary prefix is
  usually irrelevant, can leak secrets, can carry tool-output prompt injection, and scales with tool
  count. Adopted; enforced by a sentinel test at bytes 0, 199, 200, middle, and end.
- Compact receipts for maximal contiguous omitted runs in the prompt, with the complete per-event
  ledger in a separate artifact. Adopted.
- One-tier transform with two authority profiles rather than two different transforms for
  tool vs. command entry. Adopted.
- Whole-DAG feasibility proof before any candidate spawns, plus exact re-measurement before each
  later spawn. Adopted.
- Fail fast rather than auto-eliding oldest messages, since oldest-first elision is explicit but
  still semantically arbitrary and may discard the governing requirement. Adopted.

**Second consultation** (review of the implemented design). Found a **real bug in my own budget**:

> "The core problem is unit mismatch: provider output tokens are not equivalent to later input-token
> bounds after UTF-8 transfer, JSON escaping, wrappers, schemas, and retokenization."

It also noted that reserving output tokens "does not enforce that limit." Both were correct, and my
own harness data proved it. See §7 for the arithmetic and the fix. Two further points were adopted:
stating the "absent means zero" wire rule explicitly, and including the canonical-input
interpretation guide in evaluator/repair/merger prompts rather than only candidate prompts.

Points **not** adopted, with reasons:

- *Pinned per-route tokenizers.* Pi exposes no per-route tokenizer; `estimateTokens` in
  `@earendil-works/pi-coding-agent` is itself a `chars/4` heuristic. A `ceil(bytes/2)` ceiling is
  strictly more conservative than anything the host offers, and is re-validated by exact
  pre-spawn measurement. Recorded as a limitation in §11 rather than papered over.
- *Stable session-entry IDs in ledger rows.* `convertToLlm` output does not carry entry IDs. Adding
  them would require reaching around the documented API. Recorded as a limitation.

## 3. Chosen context policy and why

Canonical input is now `pi-background-tasks.fusion-input.v2`, carrying an explicit, versioned policy
descriptor. The transform `visible-conversation-ledger-v1` is shared by both entry points:

| Content | Disposition |
|---|---|
| User text | included verbatim, never clipped |
| Assistant text | included verbatim, never clipped |
| User images | `[Image omitted from fusion text transcript: <mime>]` marker |
| Assistant thinking | excluded → ledger row |
| Tool-call arguments | excluded → ledger row |
| Tool-result text | excluded → ledger row |
| Tool-result images | excluded → ledger row (never raw bytes) |
| Active `fusion_brainstorm` call + siblings | scope-excluded before projection |
| Unknown block type | typed `context_policy_unsupported_block` error |

Every retained source block receives **exactly one** disposition — included, or represented as an
omission. This is asserted as a property test, so a block cannot silently disappear.

Two authority profiles over one transform:

| Entry point | Policy id | `request.authority` |
|---|---|---|
| `fusion_brainstorm({prompt})` | `fusion-tool-explicit-v1` | `explicit_text` |
| `/fusion [prompt]` | `fusion-command-conversation-v1` | `directive_over_projected_conversation` |

`/fusion` keeps the same payload exclusion even though the transcript is more central to the request,
because retaining full tool payloads there would preserve the exact failure mode and widen secret /
prompt-injection exposure. Both receive identical stage-budget safety.

**Why not the alternatives.** Model-generated summarization was rejected outright: it adds hidden
calls, hidden cost, and nondeterminism, and would break byte-identical reproducibility. Raising a
byte limit was rejected because it cannot be safe for every configured model. Removing GPT-5.5 or
selecting only large-context models was rejected as forbidden and as not addressing the defect.

**Documented limitation.** Facts existing *only* inside omitted tool output are unavailable to
children. Children are instructed to say so plainly rather than guess. This is stated in the README,
in the child system prompts, and in §11.

## 4. Schema / API changes

New and changed types in `src/core/fusion/types.ts`:

- `FUSION_INPUT_SCHEMA_VERSION` → `pi-background-tasks.fusion-input.v2` (was `.v1`)
- `FusionCanonicalInputV2` replaces `FusionCanonicalInputV1`; `conversation_transcript: string` is
  replaced by structured `conversation_projection`, and `request: string` by `FusionCanonicalRequestV2`
  (`source`, `authority`, verbatim `text`, `sha256`)
- `FusionConversationProjectionV2` = policy descriptor + branch filter + ordered entries + accounting
- `FusionProjectionEntry` = `FusionProjectionTextEntry | FusionProjectionOmissionEntry`
- `FusionContextOmissionLedgerV1` (`pi-background-tasks.fusion-context-ledger.v1`)
- `FusionBudgetPlanV1` (`pi-background-tasks.fusion-budget-plan.v1`), `FusionRouteCapacity`,
  `FusionBudgetPolicyDescriptor`
- `FusionBudgetStage` = `candidate | evaluation | evaluation_repair | merge`
- New error codes: `context_policy_unsupported_block`, `prompt_budget_exceeded`,
  `model_capacity_unknown`
- `FusionError.budget?: FusionBudgetErrorDetail` carrying stage, measured bytes, measured token
  upper bound, allowed tokens, limiting model, policy id, and remediation

New module `src/core/fusion/budget.ts` exports `FusionBudget`, `fusionTokenUpperBound`,
`fusionRouteCapacities`, `fusionLimitingRoute`, `fusionOutputContractBytes`, and
`assertChildOutputWithinContract`.

`FusionWorkflowInput` gains a required `contextLedger` field.

**Hashing.** Domain-separated and length-prefixed so concatenated fields cannot collide:

```text
leaf[i]  = SHA256("pi-fusion-ledger-leaf-v1\0" || u64be(i) || u64be(len) || canonicalJson(row))
run      = SHA256("pi-fusion-ledger-run-v1\0"  || u64be(first) || u64be(n) || leaf[first..])
root     = SHA256("pi-fusion-ledger-root-v1\0" || u64be(n) || leaf[0..n))
```

**Wire rule.** In omission receipts, a zero-valued count/byte key is absent; absent means exactly
zero, by the policy version. Applied unconditionally, never adaptively.

## 5. Files changed

| File | Change |
|---|---|
| `src/core/fusion/context.ts` | rewritten: projection, ledger, hashing, one-disposition guarantee |
| `src/core/fusion/budget.ts` | **new**: route capacities, token bound, output contracts, preflight |
| `src/core/fusion/types.ts` | v2 canonical input, ledger/budget types, 3 new error codes, `budget` detail |
| `src/core/fusion/prompts.ts` | v2 types; shared `FUSION_CANONICAL_INPUT_GUIDE` in all stage prompts |
| `src/core/fusion/orchestrator.ts` | budget construction, 4 stage preflights, 3 output-contract checks, ledger/plan persistence, `budget` detail preserved on rethrow |
| `src/core/fusion/artifacts.ts` | `writeContextLedger()`, `writeBudgetPlan()` |
| `src/fusion-extension.ts` | passes `contextLedger`; budget stage surfaced in tool failure message |
| `package.json` | peers `^0.83.0` + `typebox: "*"`; devDeps → 0.83.0 / TypeBox 1.3.7; `smoke:large-context` |
| `scripts/test-compat.ts` | Pi 0.83.0; peer-posture check; bundled-TypeBox check; removed-API scan of installed bytes |
| `scripts/large-context-smoke.ts` | **new**: pre/post-fix evidence harness |
| `tests/unit/fusion-context-prompts.test.ts` | rewritten: 16 projection tests |
| `tests/unit/fusion-budget.test.ts` | **new**: 15 stage-budget tests |
| `tests/package/typebox-compat.test.ts` | **new**: 6 TypeBox/peer tests |
| `tests/helpers/fusion-canonical.ts` | **new**: shared projection fixtures |
| `tests/unit/fusion-orchestrator.test.ts` | v2 fixtures + `contextLedger` |
| `tests/package/package.test.ts` | mutation-resistance test; new files/artifacts in pack expectations |
| `tests/sdk/fusion-sdk.test.ts`, `tests/rpc/fusion-rpc.test.ts` | v2 request shape; projection-scoped assertions |
| `tests/sdk/sdk.test.ts`, `tests/scripted-provider/*.ts` | Pi 0.83 `ModelRuntime` migration |
| `README.md`, `TESTING.md`, `TEST_PLAN.md`, `PUBLISHING.md` | retired "full transcript" promise; documented policy, budgets, limitation |

## 6. Prompt-size arithmetic — all stages

Reproduced failure shape (120 tool calls, observed byte composition), panel = the reported failing
panel, limiting route allows 231,040 input tokens:

| | Pre-fix | Post-fix |
|---|---:|---:|
| Transcript / projection | 1,035,258 B | — |
| Canonical input | **1,051,289 B** | **173,489 B** |
| Candidate token bound | 526,430 | 87,530 |
| Verdict | **REJECTED** | fits |

Post-fix stage envelope, measured with every embedded output at its **enforced contract maximum**
(not merely the largest observed answer):

| Stage | Prompt bytes | Token bound | Allowed | Verdict |
|---|---:|---:|---:|---|
| candidate | 175,060 | 87,530 | 231,040 | OK |
| evaluation | 323,018 | 161,509 | 231,040 | OK |
| evaluation_repair | 389,096 | 194,548 | 231,040 | OK |
| merge | 322,355 | 161,178 | 231,040 | OK |

Re-verified after the rendered-byte contract change; `npm run smoke:large-context` recomputes this
table on every run and exits non-zero if any stage would exceed the budget.

Projection accounting for that run: 36,490 B user text and 26,890 B assistant text retained; 10,200 B
thinking, 253,080 B tool arguments, and 696,840 B tool results omitted across 360 events in 22 runs.
Byte-identical rebuild: yes.

**Independent check against a real session.** Applied to a genuine 58 MB / 14,668-entry session
(`~/.pi/agent/sessions/--Users-lizavasilyeva-work-ai-pipeline--/2026-07-17T…jsonl`), 594 effective
messages:

| Measure | Value |
|---|---:|
| Legacy payload that would have been forwarded | 22,043,031 B |
| Projected canonical input | **106,945 B** |
| User + assistant text retained | 79,813 B |
| Omitted events / runs | 871 / 22 |
| Candidate token bound vs. allowance | 54,258 / 177,792 |
| Projection time | 7 ms |
| Verdict | fits |

## 7. The unit-mismatch bug Fusion caught

My first budget reserved a fraction of the input budget, then a reserve derived from output
*tokens*. Fusion flagged the second as unsound; my own harness output proved it:

```text
candidate stage        87,530 tok
evaluation_repair     183,618 tok
actual growth          96,088 tok
my reserve             69,632 tok
SHORTFALL              26,456 tok   (reserve was 27.5% short)
```

Cause: a 16,384-token output is ~57,344 bytes, which my own conservative `ceil(bytes/2)` rule
re-measures as 28,672 tokens. Reserving output *tokens* understates re-embedded *bytes* by ~1.75x.

Fixed with two cooperating layers:

1. **Enforced rendered-byte contracts** — candidate 48 KiB, evaluator 64 KiB, merger 64 KiB,
   diagnostics 8 KiB, measured as `JSON.stringify(text)` bytes, i.e. what the response actually
   costs once embedded. `assertChildOutputWithinContract` rejects an oversized response with
   `child_output_cap` *after* the response is durable, so it is preserved as evidence and never
   sliced or forwarded.
2. **Exact reserve** — the sum of those rendered-byte contracts plus fixed wrapper overhead,
   converted to tokens with the *same* `ceil(bytes/2)` function used to measure prompts.

A third review round caught a further hole here: my first fix used a 9/8 escaping allowance, which
Fusion correctly identified as not a worst-case bound (quotes/backslashes/newlines expand 2x,
control characters up to 6x). Measuring contracts in rendered bytes eliminates the guess entirely
and is pinned by an adversarial test using control characters, quotes, backslashes, and newlines.

**Honest consequence.** Uniform conservatism means a configured route needs ≥167,936 tokens. A
128k-token route can no longer be configured. Rather than weaken the accounting, this is surfaced at
configuration time as a typed `model_capacity_unknown` error naming the requirement and pointing at
`/fusion-models`, and is pinned by a test at exactly the boundary. All models in the reported panel
(272,000) qualify. This is recorded as a limitation in §11, not hidden.

## 8. Tests and mutation coverage

**Context projection (16).** >1 MB tool-heavy session stays small; user/assistant text verbatim;
thinking excluded; head/tail/middle sentinels absent; zero preview bytes; omission counts, byte
totals, and payload hashes exact; payload-hash matches exact omitted bytes; contiguous runs collapse
with dense ordered ledger indices; byte-identical rebuild; hash changes on omitted-payload mutation
*without* exposing the payload; active leaf + sibling exclusion (and no ledger rows from the excluded
subtree); user images marker-only, tool-result images ledger-only, no base64 anywhere; per-entry-point
policy id and authority; blank request rejected pre-projection; exactly-one-disposition property.

**Stage budgets (15).** Conservative divisor pinned (`<= 2`); smallest route limits, including when
it is the evaluator; unknown/zero/negative/too-small windows rejected; derived reserve equals the
byte→token conversion *and* exceeds the measured 96,088-token growth; boundary accept at exactly the
limit and reject one byte past; system prompt counted as input; dense CJK cannot bypass byte
accounting; candidate preflight launches zero children; output contract stops a run before any
downstream child and preserves the oversized response; evaluator/repair/merge rendered-prompt
rejection; safe prompts complete all five calls; plan persisted with negative slack on rejection;
minimum-viable-capacity boundary; reproduced 1 MB shape fits.

**Mutation resistance** (`tests/package/package.test.ts`). Fails if anyone reintroduces `.slice(`/
`.substring(` in the context or budget path (comment-stripped so prose about truncation does not
mask code), adds `catch {}`, changes `tool_payload_preview_bytes` from 0, drops
`assertChildOutputWithinContract`, clamps with `Math.min(...allowed)`, selects with
`Math.max(...allowed_input_tokens)`, drifts the divisor from 2, reserves output tokens directly
instead of converting bytes, or removes any of the four `assertStagePrompt` guards.

**Workflow preservation.** All 7 pre-existing orchestrator tests pass unchanged: three parallel
candidates, blind anonymization, strict evaluator schema + repair, final merge, sibling cancellation
on first failure, fail-fast without degrading to evaluation, usage/cost aggregation exactly once for
successful/failed/cancelled attempts, transient-spawn retry, concurrent workflows, manifest
correctness.

## 9. Pi 0.83 / TypeBox findings

- **No removed TypeBox API is referenced** — verified in source and in installed packed bytes for
  `Type.Base`, `Type.Awaited`, `Type.Promise`, `Type.AsyncIterator`, `Type.Iterator`, `Type.Options`,
  `Value.Mutate`. Confirms these were not the crash cause.
- Peers → `^0.75.5 || ^0.81.1 || ^0.82.1 || ^0.83.0`; `typebox: "*"` per `docs/packages.md`. TypeBox
  is neither a runtime nor a bundled dependency, and no local pin masks Pi's copy — asserted by test.
- Dev environment upgraded to Pi/TUI/AI 0.83.0 and TypeBox 1.3.8 (satisfying the bundled 1.3.7 line).
- Compiled nullable-array and nullable-string schemas matching real projection shapes verified under
  TypeBox 1.3, plus the exact shipped `fusion_brainstorm` schema and optional-field tool schemas.
- Older supported Pi lines retained; `test:compat` installs the correct TypeBox line per version
  (1.1.x for ≤0.82.1, 1.3.7 for 0.83.0).

**Pre-existing 0.83 breakage found and fixed** (unrelated to Fusion). `AuthStorage` and
`ModelRegistry.inMemory` were removed in favour of `ModelRuntime`; `setUIContext` gained a mode
argument defaulting to `"print"`; `Theme` gained `thinkingMax`; `MessageRenderOptions` gained
`outputPad`; `AgentSession.modelRegistry` was removed. I verified this was pre-existing by stashing
my work — the untouched baseline scored **0 pass** on the SDK suite against 0.83. Test harnesses were
migrated rather than pinning Pi back.

## 10. Commands and exits

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm run test:type-safety` | 2/2 |
| `tests/unit/fusion-context-prompts.test.ts` | 16/16 |
| `tests/unit/fusion-budget.test.ts` | 15/15 |
| `tests/unit/fusion-orchestrator.test.ts` | 7/7 |
| `tests/unit/fusion-artifacts.test.ts` | 3/3 |
| `tests/sdk/fusion-sdk.test.ts` | 6/6 |
| `tests/sdk/sdk.test.ts` | 18/18 |
| `tests/rpc/fusion-rpc.test.ts` | 3/3 |
| `tests/package/package.test.ts` | 6/6 |
| `tests/package/typebox-compat.test.ts` | 6/6 |
| `npm run smoke:large-context` | exit 0; pre-fix rejected, post-fix all four stages fit |
| live `/fusion` on a real 58 MB session (working tree, subscription models) | 5/5 calls completed — see §11 |
| `npm test` (full) | **166/166, exit 0** (type-safety 2, unit 105, sdk 24, rpc 10, component 11, package 14) |
| `npm run test:agent-loop` | 6/6 |
| `npm run pack:dry-run` | exit 0; 28 files, 114.1 kB |

Baseline before any edit: typecheck clean, 80/80 unit — so no pre-existing failure was inherited into
the Fusion layer.

## 11. Live subscription acceptance evidence

The decisive test: the **working-tree** extension, a **real 58 MB / 14,668-entry session**, and
**real subscription models** (Codex + `$current`), driven by

```bash
pi --no-extensions -e packages/pi-background-tasks/extensions/background-tasks.ts \
   --session 019f6fa2-9ca2-7f21-a397-6c1beed4b9b7 --model openai-codex/gpt-5.5 \
   -p "/fusion In one sentence, what is the single most important property of an auditable context projection?"
```

Artifacts: `.pi/fusion/019f6fa2-9ca2-7f21-a397-6c1beed4b9b7-48316/fc26a0c66411719720be6d3387fa4c4e5/`

| Fact | Value |
|---|---|
| State | `completed` |
| Attempts | 5 — candidate 1/2/3, evaluation, merge, all `completed` |
| Candidate models | `gpt-5.6-sol`, `gpt-5.6-terra`, **`gpt-5.5`** (the model that failed before) |
| Canonical input schema | `pi-background-tasks.fusion-input.v2` |
| Canonical input size | **105,862 B** (was 1,074,041 B for the same class of session) |
| Retained text | 56,443 B user + 23,370 B assistant |
| Omitted | 38,939 B thinking, 247,640 B tool args, 812,006 B tool results |
| Omission accounting | 871 events in 22 runs; ledger root `24d291bccbef335a…` |
| Ledger + plan artifacts | `context-omission-ledger.json`, `budget-plan.json` both present |
| Limiting route / slack | `gpt-5.6-sol`, 58,539 tokens slack |
| Stage prompts sent | candidate 105,862 B ×3, evaluator 106,472 B, merger 110,024 B |
| Artifact fidelity | `canonical-input.json` is byte-identical to `candidate-3.attempt-1.prompt.txt` |
| Leakage check | no `conversation_transcript` in any prompt; `conversation_projection` in all |
| Usage | 157,012 tokens, $0.7362 |

**A correction worth stating plainly.** My first attempt at this evidence used the `fusion_brainstorm`
tool from this session, which resolves to the **installed git package**, not the working tree. That
run emitted `fusion-input.v1` with a 923,001-byte transcript and no ledger — it exercised the *old*
code and only succeeded because its slot 3 happened to be a 1M-context model. It is not evidence for
this fix, and the run above replaces it. Determinism was separately verified as byte-identical across
three distinct processes on content containing unicode, emoji, quotes, backslashes, and control
characters.

## 12. Remaining limitations

1. **No exact tokenizer.** Pi exposes none per route (`estimateTokens` is itself `chars/4`), so the
   budget uses a `ceil(bytes/2)` ceiling — strictly more conservative than the 3.552 B/tok floor
   measured across 159 real prompts, and re-validated by exact pre-spawn measurement. A provider
   context rejection after accepted preflight would remain a loud child failure; it is not retried
   and no model is substituted.
2. **Minimum route capacity ≥167,936 tokens.** A consequence of uniform conservatism, surfaced as an
   actionable configuration error. Routes such as a 128k `gpt-5.3-codex-spark` cannot be configured.
3. **Tool-only facts are unavailable** to children under both policies. Stated in the README, in the
   child prompts, and instructed to be admitted rather than guessed.
4. **Ledger rows key on post-filter `source_ordinal`**, not stable session-entry IDs, because
   `convertToLlm` output does not carry them. Rows are replay-stable for a fixed branch, not across
   arbitrary re-filtering.
5. **Hashes provide integrity, not confidentiality.** Low-entropy omitted values could be guessed
   from their hash. Artifacts remain `0600` in `0700` directories.
6. **Receipt fanout is unbounded in principle** — one receipt per contiguous omitted run. Real
   sessions collapse well (871 events → 22 runs), and the budget catches any pathological case before
   spawn, but no fixed checkpoint rule is implemented.
7. **Whole-DAG feasibility is proven before candidates, but a downstream rejection still costs the
   candidate wave.** Preflight guarantees no oversized prompt reaches a provider; it does not
   guarantee zero spend, since candidates run before the evaluator prompt exists. The pre-candidate
   base-context check plus enforced output contracts make this path unreachable in practice.
8. **`npm run test:compat` and `test:pty` are release-only** and were not run in this session:
   `test:compat` performs network installs of four exact Pi versions, and `test:pty` requires a TTY.
   Their new assertions (Pi 0.83.0 matrix, bundled-TypeBox check, removed-API scan of installed
   bytes) are therefore implemented and typechecked but not executed here. The equivalent checks run
   in the default gate via `tests/package/typebox-compat.test.ts`.
9. **The `fusion_brainstorm` tool resolves to the installed package**, not the working tree. Live
   verification of working-tree changes must load the extension explicitly with `-e`, as in §11.

# Fusion budget + projection fix — implementation specification

Authoritative spec for two changes. Derived from measured artifact data, a Fusion
design review, and independent verification. Every number here was computed from
real run artifacts under `.pi/fusion/`, not estimated.

**Perfect quality is mandatory.** No silent fallback, no truncation, no weakening
of a safety bound to make something fit, no cosmetic green tests.

---

## 0. The failure being fixed

A real run was refused at preflight:

```
merge stage: forecast 251,546 tokens vs 231,040 allowed -> REFUSED, no child spawned
```

The identical payload was then executed live and billed **123,690** input tokens.
It fit with 46% to spare. The forecast overstated by **2.03x**. This is a false
positive that blocks legitimate work, and it worsens monotonically as a session grows.

---

## 1. Measured evidence

Rate = `prompt_file_bytes / (usage.input + usage.cacheRead + usage.cacheWrite)`.

**The `cacheWrite` term is mandatory.** Anthropic reports first-use input almost
entirely under `cacheWrite` (observed: `input=2, cacheWrite=653275`). Summing only
`input` yields absurd ratios such as 153,069 B/tok and will silently corrupt any
recalibration.

Large prompts (>= 50 KB), which is the only regime budget forecasting guards:

| provider | n | worst | median | max |
|---|---:|---:|---:|---:|
| anthropic (claude-opus-5, claude-fable-5) | 85 | **2.047** | 2.217 | 2.481 |
| openai-codex (gpt-5.6-sol/terra, gpt-5.5) | 797 | **3.400** | 3.721 | 4.526 |

The observed ranges are **disjoint**. A single constant is therefore provably
dominated: any value safe for Anthropic wastes >= 40% of Codex's headroom.

The shipped global divisor is `2`. It sits **below** Anthropic's worst observed
2.047 — a 2.4% margin at n=85, which is not a margin — while leaving 70% slack on
Codex. So the current constant is simultaneously too tight for Anthropic and far
too loose-fitting for Codex.

### Verified numerator scope

`*.prompt.txt` contains **only the user prompt**. The child system prompt is passed
via `--system-prompt` argv (`src/core/fusion/pi-child.ts:212`) and is billed but not
in the artifact. Sizes: candidate 419 B, evaluator 1,862 B, merger 470 B, repair 398 B.

Including them changes worst rates from 2.047 -> 2.048 (anthropic) and 3.400 -> 3.429
(codex). **The omission understates rates, so calibrating on the lower published
numbers is the conservative direction.** Use the uncorrected worst values.

---

## 2. Non-negotiable constraints

1. No provider may become less safe than today.
2. No silent fallback. An unknown provider must be visible in artifacts and errors.
3. Determinism: identical input -> byte-identical canonical input and stable hashes.
   Integer/rational arithmetic only in any artifact path. No floats.
4. Never shrink producer output contracts to fit a consumer's window. The producer's
   own route governs its contract. Inverting this reintroduces a fixed production
   overflow bug.
5. Lossless only for the projection. No truncation, no summarization, no dropped text.
6. Existing mutation-resistance guards must be **rewritten stronger**, never deleted.

---

## 3. OPTION 1 — Per-family affine token forecasting

### 3.1 Replace the pure ratio with an affine model

A pure ratio is a linear fit forced through the origin. The `>= 50 KB` filter
currently compensates for that, which is why a 2,055 B prompt billing 984 tokens
(2.088 B/tok) looked like an outlier — it is evidence of a constant additive
overhead (system prompt, tool schemas, chat framing).

```
forecast_tokens(bytes, family) = ceil(bytes / r_family) + F_family
```

Fit `r` and `F` jointly by least squares across **all** sample sizes per family.
Conservatism directions differ: **lower `r` is safer, higher `F` is safer.**
Haircut `r` downward; round `F` up.

### 3.2 Calibration table

```
r_family = floor_2dp( min_observed(family) * 0.85 )
```

The 15% haircut is derived: min->median spread is 8.3% (anthropic 2.047->2.217) and
9.4% (codex 3.400->3.721). Fifteen percent is ~1.6-1.8 spreads below the worst
observation ever recorded.

| family key | n | observed min | `r` | `F` (provisional) | backed |
|---|---:|---:|---:|---:|---|
| `anthropic` | 85 | 2.047 | **1.73** | 512 | yes |
| `openai-codex` | 797 | 3.400 | **2.89** | 512 | yes |
| `unknown` | 0 | — | **1.00** | 512 | **no** |

**Anthropic goes 2.0 -> 1.73, i.e. more conservative.** This change is a safety fix
on Anthropic and an efficiency fix on Codex, simultaneously.

Rule, enforced by test: **the unknown default must be `<=` the minimum `r` of every
calibrated entry.** Adding a family can then never make unknown routes less safe.

**Unknown is 1.00 — the only provable value.** The first draft used 1.70, which the
adversarial review correctly rejected: an unbacked family has no evidence for any
rate above the byte-level BPE floor. Mark it `backed: false`, render it as
`unknown provider "X" — no calibration, using provable floor` in errors and result
details (not only in artifacts), and arm the breach detector unconditionally on first
use.

This is deliberately strict: an unknown provider is admitted only for prompts it can
provably hold. Configuring such a route for large work fails loudly and actionably,
which is correct — the alternative is admitting prompts on an unevidenced guess.

### 3.3 Family resolution, most-specific first

```
family(route) =
    MODEL_OVERRIDES[`${provider}/${model}`]   // explicit pins win
 ?? PROVIDER_DEFAULT[provider]                // anthropic | openai-codex
 ?? 'unknown'
```

Provider is a proxy for tokenizer, not the thing itself. The override map lets a
future model with a different tokenizer be pinned without silently inheriting a
wrong rate.

Every entry stores `{n, sessions, days, observedMin, median, max, corpusSha256,
corpusDate, haircut, backed}`. If provenance and value can drift apart, they will.

### 3.3a Scope guard — the relaxed rate MUST NOT reach delegate small windows

**Validated defect in the first draft of this spec.** `token-budget.ts` is shared, and
`DELEGATE_MIN_USABLE_INPUT_TOKENS = 8_192` (`src/core/delegate/budget.ts:37`). A relaxed
Codex rate applied there is demonstrably unsafe:

| rate | admits up to |
|---|---:|
| current global 2.0 | 16,384 B |
| proposed codex 2.89 | **23,674 B** |

A 23,674 B high-entropy prompt (base64 / minified) really costs ~15,783 tokens at
~1.5 B/tok and **exceeds the 8,192-token window**, yet forecasts as exactly 8,192 at
2.89 and is admitted.

The `>= 50 KB` calibration exclusion is legitimate **only** where a sub-50 KB prompt
cannot threaten the window. That holds for Fusion's 231,040-token routes. It does
**not** hold for delegate's 8,192-token floor.

**Rule:** the calibrated family rate applies only when
`allowed_input_tokens * r_family >= 50 KB`. Below that threshold, or for any
delegate admission/governor path, use the conservative rate (<= 2.0) until
content-class accounting (step 6) lands. Enforce with a test per consumer.

### 3.4 Provable content caps

The most important finding of this research: **the worst case is pathological ASCII,
not multibyte text.**

| content | B/tok |
|---|---:|
| CJK ideograph (3 B, 1 tok) | 3.000 |
| Emoji astral (4 B, 1 tok) | 4.000 |
| Emoji -> 3 tokens | 1.333 |
| Combining accent sequences | 1.750 |
| **base64 / random hex / minified / punctuation runs** | **~1.000** |

A non-ASCII-fraction heuristic is therefore **inverted**: it penalizes CJK (which at
3.0 is *safer* than the Codex `r` of 2.89) and is blind to every dangerous case.
**Do not implement a non-ASCII blend.**

Use class decomposition instead. For byte-level BPE, at most one token can begin at
any byte, so `tokens_beginning_in_class <= bytes_in_class` is a **proof**, not a
calibration:

```
forecast = ceil( normal_bytes  / r_family
               + multibyte_bytes / 1.0
               + dense_bytes     / 1.0 ) + F_family
```

**Accounting must be additive per byte class, never a blended divisor.** A blended
scalar is arithmetic mean; the safe combination is harmonic, and arithmetic is always
the larger (less conservative) value:

| non-ASCII fraction | arithmetic blend | harmonic (safe) | arithmetic verdict |
|---:|---:|---:|---|
| 25% | 2.795 | 2.702 | less safe |
| 50% | 2.530 | 2.419 | less safe |
| 75% | 2.265 | 2.190 | less safe |

Sum tokens per segment directly. Do not compute one effective divisor.

**Non-ASCII floor is 1.0, not 2.0.** Byte-level BPE can split astral characters, ZWJ
sequences, and variation selectors into 3-4 tokens per 4 UTF-8 bytes (1.33 and 1.00
B/tok). Only 1.0 is provable without an exact tokenizer.

**Future output contracts are an unknown-content segment.** `upstream_output_contract_bytes`
(`src/core/fusion/budget.ts:257-264`, `:466-484`) describes bytes that do not exist
yet, so no class fraction can be computed for them. Charge them as a distinct
`unknown_output_contract` segment at a conservative rate, never at the calibrated one.

Dense-region detectors, single pass, tuned for near-zero false positives:

```
[A-Za-z0-9+/=]{4096,} with no whitespace   -> base64-like
any line >= 8 KB with no whitespace        -> minified
punctuation fraction > 0.40 over any 4 KB  -> symbol-dense
```

**Critical scoping rule.** Never run detectors over package-emitted structural bytes.
The corpus rates were measured *with* projection JSON, omission receipts, and SHA-256
hashes already present, so classifying them double-counts conservatism. A window
landing inside the omission ledger (whitespace-free, hash-dense) would fire the
symbol-dense detector and add roughly **+33,000 spurious tokens** on the reported run.

Implement by recording `regions[] = {offset, len, kind}` during assembly, classifying
only `kind === 'conversation_text'`, and asserting
`sum(len) === Buffer.byteLength(rendered)` as a hard invariant with its own test.

Content adjustment may only **lower** the effective rate. Assert monotonicity
explicitly — the assertion is free and the failure is silent.

Disclosed limitation: genuine CJK is ~3.0 B/tok and will be charged at 1.0, a **3x
over-forecast on CJK-dominant prompts**. Accept in v1; there is zero corpus evidence
(max observed non-ASCII density is 5.91%). Record per-class byte counts in every
budget plan, and calibrate a `MULTIBYTE` class once >= 50 real prompts exceed 30%
multibyte.

### 3.5 Two-tier preflight — largest single win

The pre-candidate check reserves 212,992 B for candidate outputs that do not exist
yet, while the median real candidate is ~2.7 KB against a 48 KiB contract (18x
over-reservation). Making that reservation **fatal** composes two worst cases
multiplicatively.

```
inputOnly = forecast(measured input bytes)
withMax   = forecast(measured input bytes + worst-case output contracts)

if inputOnly > allowed: FATAL   // hopeless, nothing downstream helps
if withMax   > allowed: WARN    // record in budget-plan.json, surface, PROCEED
else:                   PASS
```

**On the reported run:** input-only bytes = `503,091 - 212,992 = 290,099`.
At the *current* divisor 2.0 that is **145,050 tokens < 231,040**.
**The tier split alone would have allowed this run with no calibration change.**
Under the new table it is 100,893 — a 2.3x margin.

Per-stage `assertStagePrompt` checks stay **fatal** on exact rendered bytes.

Rejected alternative: a hard block at the provable rate (`tokens = bytes`) on
worst-case reservations blocks anything over ~235 KB on a 272k route — including
runs empirically proven to fit. Do not do this.

### 3.6 Byte-capacity route selection — latent bug

"Smallest configured route" must switch from token capacity to
**byte capacity = `allowed_tokens * r_family`**:

| route | allowed tokens | `r` | byte capacity |
|---|---:|---:|---:|
| Anthropic 400k | 363,136 | 1.73 | **628,225** |
| Codex 272k | 235,136 | 2.89 | 679,543 |

Token-wise Codex looks limiting; byte-wise Anthropic is. **The ordering flips.**
The derived minimum-capacity contract must be re-expressed per family in bytes and
will differ by ~1.66x between them.

### 3.7 Breach detector — implement FIRST

`assertStagePrompt` re-measures bytes but applies the *same* conversion, so it cannot
catch a miscalibrated rate. **The rate currently has no independent check anywhere.**

After every child completes, compare `forecast_tokens` against `billed_input_tokens`.
On violation write `calibration-violation.json` (route, family, rate in force, bytes,
tokens, content fingerprint) and surface a warning. This is the only mechanism that
can falsify the calibration, and without it the honest documentation in §3.9 is not
actually honest.

Add a **downward-only runtime ratchet**: an observation below the configured rate is
evidence the constant is wrong in the dangerous direction and may tighten immediately.
Loosening requires human review.

**Never auto-loosen from production data.** The sample is censored: only prompts that
*passed* the forecast are ever billed, so observed rates are biased upward and the
bias compounds. Offline recalibration emits a reviewable diff; it is never applied
automatically.

### 3.8 Error payload

Split the code: `prompt_budget_exceeded_forecast` (speculative, pre-candidate) vs
`prompt_budget_exceeded_measured` (definitive, pre-spawn). These demand opposite user
responses.

Keep existing fields; add `check_kind`, `rate_source` (family, n, min, haircut, r, F,
backed), `component_breakdown` (bytes **and** tokens), `byte_class_breakdown`,
`dense_regions` (offset/len/detector), `bytes_over`, `tokens_over`,
`required_allowed_tokens`, `route_table` ranked by **byte capacity**,
`counterfactuals` (empty request / without reservation / at median rate),
`stage_upstream_actuals` when known, `policy_id`, `calibration_version`.

Remediation must be **ranked by dominant component**:
reservation dominant -> re-route this stage; visible text dominant -> fresh session;
dense regions present -> remove the named byte ranges; request dominant -> shorten
the prompt (the only case where today's message is correct).

### 3.9 Honest characterization

Rename `BYTES_PER_TOKEN_DIVISOR` -> `CALIBRATED_BYTES_PER_TOKEN`. Reserve the word
*bound* exclusively for the 1 token/byte terms, where it is literally true. Never use
*guarantee*, *safe*, or *upper limit* for calibrated rates.

Correct the stale claim of "159 prompts / 3.552 B/tok" in `src/core/context/token-budget.ts:12-14`,
`README.md:324`, and `FUSION_CONTEXT_FIX_REPORT.md`. The real basis is 882 large
prompts with a **2.047** Anthropic floor — a number that *invalidates* the shipped
constant. Stale provenance documenting a margin that does not exist is worse than none.

---

## 4. OPTION 2 — Lossless compact projection encoding

Verified: schema is already `pi-background-tasks.fusion-input.v3`
(`src/core/fusion/types.ts:6`); projection lives in
`src/core/context/visible-conversation-v2.ts`.

### 4.1 Measured overhead (1,484-message session)

| item | value |
|---|---:|
| canonical input | 292,778 B, embedded in **all five** calls (~1.46 MB/run) |
| retained text | 213,029 B across 365 entries |
| serialized text array | 246,422 B -> **~91 B/entry** structural |
| omission receipts | 31,288 B across 291 runs -> **~108 B/run** |
| overhead share | ~15% under 200 messages, **~58% over 1000** |

### 4.2 Tuple encoding

```
{"kind":"text","source_ordinal":0,"block_ordinal":0,"role":"user","text":"hello"}   81 B
["t","u",0,0,"hello"]                                                              21 B

{"at":[1,4],"bytes":4370,"counts":{"assistant_thinking":1,"tool_calls":2,"tool_result_texts":2},"kind":"omitted_activity"}  122 B
["o",[1,4],4370,[1,2,2]]                                                                                                    24 B
```

```ts
type CompactProjectionEntry =
  | ['t', 'u' | 'a', sourceOrdinal: number, blockOrdinal: number, text: string]
  | ['o', [first: number, last: number], bytes: number,
     [thinking: number, toolCalls: number, toolResults: number]];
```

Expected: **292,778 B -> ~246-248 KB**, i.e. ~45 KB per copy and **~230 KB per run**.

### 4.3 Rejected alternatives, with reasons

- **Dropping `source_ordinal`/`block_ordinal`:** not reconstructible from array index,
  because omitted runs collapse events, empty blocks are skipped, and tool-result
  images can be ledger-only. Keep them; they are cheap in tuple form.
- **Merging consecutive same-role entries:** blurs turn boundaries. Defer.
- **Short keys instead of tuples:** still repeats object syntax per entry; strictly worse.

### 4.4 Invariants that must survive

Serialize with `canonicalJson` (`src/core/attested-pi-run.ts:409-419`); arrays preserve
order deterministically. **Do not change ledger row shape** — `ledgerLeafHash` /
`ledgerRootHash` must produce identical roots, so prompt bytes may change without
touching ledger hashes. Omission tuples retain span, byte total, and counts;
per-event `payload_sha256` stays in the ledger. Entry array order remains source
order. No previews, no truncation. Unknown block types still raise typed errors.

### 4.5 Artifact identity

Keep `canonical-input.json` byte-identical to the child-facing compact input, keep
`context-omission-ledger.json` as the full audit artifact, keep `*.prompt.txt` as the
exact rendered prompt per child, and record byte length + SHA-256 for both in
`manifest.json`. The guarantee "every prompt sent is byte-identical to a durable
artifact" is preserved.

### 4.6 Schema version

**Bump to `pi-background-tasks.fusion-input.v4`.** The child-facing wire format
changes and the prompt guide (`src/core/fusion/prompts.ts:13-18`) describing object
fields must be rewritten to a tuple legend.

### 4.7 Consumers that must be updated with the encoding

The guide currently tells children the entry shape explicitly:

> "Entries of kind \"text\" are verbatim user and assistant messages. Entries of kind
> \"omitted_activity\" ... each receipt has kind, at, bytes, and counts fields"

That text becomes false the moment tuples land, and a child reading it would
misinterpret the payload. It must be replaced with a precise tuple legend in the same
place, e.g. positional meanings for `["t", role, sourceOrdinal, blockOrdinal, text]`
and `["o", [first, last], bytes, [thinking, toolCalls, toolResults]]`.

Test helpers also narrow on the object shape and must become tuple-aware:

| location | current |
|---|---|
| `tests/helpers/fusion-canonical.ts:87` | `entry.kind === 'text'` |
| `tests/helpers/fusion-canonical.ts:95` | `entry.kind === 'omitted_activity'` |
| `tests/helpers/fusion-canonical.ts:101` | `entry.text` |

Update the helpers rather than each test, so the ~16 tests in
`tests/unit/fusion-context-prompts.test.ts` keep asserting the same behaviour. No test
intent changes; only expected values and accessors do.

---

## 4a. Estimator API shape

`tokenUpperBound(utf8Bytes)` accepts only a byte total, which cannot support class
accounting. Delegate's runtime governor stores only `retainedInputBytes`
(`src/core/delegate/budget.ts:192-214`) and `src/delegate-child-extension.ts:229-233`
computes bytes then discards the content — so byte-class counts must be captured at
that point or they are unrecoverable.

Target shape:

```ts
estimateInputTokens({
  family,                    // resolved most-specific-first
  segments: ReadonlyArray<{
    kind: 'known_text' | 'known_json' | 'unknown_output_contract';
    bytes: number;
    multibyteBytes?: number; // required for known_* kinds
    denseBytes?: number;     // step 6; 0 until then
  }>,
}): { tokens: number; perSegment: ...; rateSource: ... }
```

Keep the estimator pure and shared; Fusion and delegate keep their own policies and
artifacts. Steps 1-4 may pass a single `known_text` segment with real
`multibyteBytes`, so step 6 adds detectors without another signature change.

## 5. Blast radius

`src/core/context/token-budget.ts` is shared by `src/core/fusion/budget.ts` **and**
`src/core/delegate/budget.ts`. Both must be updated and tested. `bg_delegate` already
carries `provider` on its pinned route, so family resolution threads cleanly.

Guards that will fight this — **rewrite stronger, do not delete**:

| location | current |
|---|---|
| `tests/package/package.test.ts:538` | `BYTES_PER_TOKEN_DIVISOR = 2` literal |
| `tests/package/package.test.ts:542` | fails if value is not 2 |
| `tests/package/package.test.ts:547` | pins `Math.ceil(utf8Bytes / BYTES_PER_TOKEN_DIVISOR)` |
| `tests/unit/fusion-budget.test.ts:285` | asserts `<= 2` |

Replacement invariants: every entry `n >= 50`, `sessions >= 3`, `days >= 3`,
`r <= observedMin * 0.85`; unknown default `<=` min of all calibrated `r` and marked
unbacked; content adjustment can only lower the effective rate; `forecast(b) <= b + F`
for all inputs including adversarial; region lengths sum exactly to rendered length;
byte-identical across separate processes; every route in **both** Fusion and delegate
resolves to a family entry or fails typed; fixture corpus
`{base64, random hex, CJK, ZWJ emoji, minified JS, punctuation runs}` asserting
`forecast >= actual` with recorded margins.

---

## 6. Additional risks to handle

1. **`framing_reserve = 4,096` is double-counted.** `static_stage_framing_bytes`
   (1,183 B ~ 409 tok) is in the payload *and* 4,096 tokens are subtracted from the
   window. With an explicit `F`, delete `framing_reserve` — recovers 4,096 tokens per
   stage. Derive `F` as `max(billed - forecast(payload))` per family.
2. **Evaluation-repair is the likeliest under-forecast site.** It appends
   schema-invalid model JSON — often malformed and escape-heavy, i.e. exactly the
   pathological-ASCII case, and not drawn from the corpus distribution. Give repair
   its own conservative rate or run detectors on the appended blob.
3. **JSON escaping mode changes class mix.** `JSON.stringify` emits raw UTF-8, so CJK
   stays multibyte. Any switch to `\uXXXX` turns one 3-byte ideograph into 6 ASCII
   bytes at ~1.5-2.0 B/tok, defeating the multibyte cap. Pin escaping; add a CJK
   round-trip test asserting byte count and class histogram.
4. **`reserved_output_tokens` may also double-count** if the enforced per-stage
   `maxOutputTokens` is smaller than the global 32,768 reservation. Reconcile.
5. **Retried attempts corrupt calibration.** Re-sent prompts re-reading cache can make
   `input + cacheRead + cacheWrite` exceed true prompt tokens. Record attempt number;
   exclude attempt > 1 from the corpus.
6. **Model aliases can rotate tokenizers invisibly.** Wire accumulated breach-detector
   violations into a release-time calibration test.
7. **Anthropic's n=85 may have low effective sample size.** Report distinct sessions
   and days; when session count is low, take the minimum over per-session minima.
8. **`tokens <= bytes` assumes byte-level BPE.** True for both current families.
   Record as an explicit precondition on the family table so a future SentencePiece
   provider cannot silently inherit the provable caps.
9. **The 5.91% non-ASCII ceiling is itself censoring.** The corpus is one deployment's
   English + TypeScript + JSON traffic. Scope the table's claim accordingly.

---

## 7. Implementation order

| # | change | closes |
|---|---|---|
| 1 | Breach detector (forecast vs billed, typed violation artifact) | makes everything downstream falsifiable |
| 2 | Verify numerator/denominator scope; joint `(r, F)` fit; audit cache/retry accounting | the assumption everything rests on |
| 3 | Per-family affine table + byte-capacity route selection + delete `framing_reserve` + error payload + test rewrites | the false rejection **and** the Anthropic under-forecast |
| 4 | Tier split (input-only fatal, plan advisory) | speculative rejection of runs that would succeed |
| 5 | Producer-side output contract enforcement | makes the 212,992 B reservation a real invariant |
| 6 | Content hardening (region scoping, multibyte cap, dense detectors), gated on corpus replay | CJK, emoji, base64, minified |
| 7 | Compact tuple projection (Option 2) + schema v4 | ~230 KB per run |
| 8 | Offline recalibration script + downward-only ratchet + docs | drift, provenance |

Steps 1-4 are a small diff and resolve the reported failure. **Step 4 alone would
have resolved it even at the current divisor.**

### Corrections applied after adversarial review

The first draft of this spec was reviewed and found **unsafe as stated**. Four defects
were confirmed with arithmetic and are now corrected above:

1. `NONASCII_FLOOR = 2.0` was not provable. ZWJ sequences, variation selectors, and
   astral splits reach 1.33 and 1.00 B/tok. **Floor is now 1.0.**
2. The arithmetic blend was less conservative than the harmonic combination at every
   mixture. **Replaced by additive per-segment accounting.**
3. Token-dense ASCII (base64, minified, punctuation runs) is invisible to any
   non-ASCII signal. **Handled by dense-region detectors in step 6, and by refusing to
   relax rates on small-window paths until then.**
4. The relaxed rate could reach delegate's 8,192-token floor, where a 23,674 B
   high-entropy prompt forecasts as exactly 8,192 but really costs ~15,783 tokens.
   **Scope guard added in 3.3a.**

Unknown-provider default moved 1.70 -> 1.00 for the same reason: no evidence exists
above the provable floor for an unbacked family.

---

## 8. Verification required

- `npm run typecheck`
- `npm run test:type-safety`
- focused: `tests/unit/fusion-budget.test.ts`, `tests/unit/delegate-budget.test.ts`,
  `tests/unit/fusion-context-prompts.test.ts`
- `npm test` full suite, once focused gates are green
- `npm run test:agent-loop`
- `npm run pack:dry-run`
- corpus replay proving: dense detectors flag ~0 bytes on real traffic; no Codex
  forecast increases vs today; Anthropic forecasts increase (the safety fix) and are
  bounded
- byte-identical determinism across separate processes

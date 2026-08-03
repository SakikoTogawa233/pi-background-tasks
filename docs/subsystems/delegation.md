---
doc_id: subsystems/delegation
audience: maintainer
mode: authored
review_policy: behavioral
stability: evolving
covers_surfaces: []
covers_sources: [extensions/delegate-child.ts, src/core/delegate/artifacts.ts, src/core/delegate/budget.ts, src/core/delegate/hook-contract-evidence.json, src/core/delegate/hook-contract.ts, src/core/delegate/launch.ts, src/core/delegate/result-package.ts, src/core/delegate/runner.ts, src/core/delegate/seed.ts, src/core/delegate/types.ts, src/delegate-child-extension.ts, src/delegate-extension.ts]
---
# Delegation subsystem

This document is the primary behavioral owner for delegation runtime code:

- `src/delegate-extension.ts`
- `src/delegate-child-extension.ts`
- `extensions/delegate-child.ts`
- every current file under `src/core/delegate/**`, including `hook-contract-evidence.json`

It does **not** claim ownership of shared `common`, `registry`, `pi-launch`, or `durable-fs`; delegation consumes those integration points.

## Behavioral contract

Delegation provides one background child Pi agent, one directive, one pinned route, and read-only inspection tools. The parent gets a launch receipt immediately and later retrieves a verified answer through `bg_result`.

The design deliberately separates:

- launch admission (no side effects on refusal),
- child isolation and runtime guards,
- child answer commit (`result.json`),
- parent adjudication (`outcome.json`),
- user retrieval (`bg_result`).

## Seed and context policy

The seed schema is `pi-background-tasks.delegate-seed.v1`. It wraps the frozen `visible-conversation-ledger-v2` projection under delegate policy id `delegate-inspect-v1`; it never emits Fusion input schemas or claims Fusion provenance.

Projection behavior:

| Source content | Delegate seed behavior |
|---|---|
| user text | included verbatim |
| assistant text | included verbatim |
| user images | marker text only |
| assistant thinking | omitted; ledger row with bytes/hash/count |
| tool-call arguments | omitted; ledger row with bytes/hash/tool name/call id |
| tool-result text | omitted; ledger row with bytes/hash/tool name/call id |
| tool-result images | ledger-only omission with bytes/hash/mime |
| unknown blocks | projection failure; no child |

The assistant message containing the active `bg_delegate` call is excluded as a whole. Therefore sibling tool calls in the same assistant message are not visible to any child launched by that batch.

`directive.text` is stored exactly, hashed, and marked `authority: "explicit_text"`. The child prompt and system prompt state that the directive is authoritative and projected history is untrusted supporting context. Omitted parent tool output cannot be recovered by the child; the child is instructed to say so rather than guess.

## Launch and isolation

Public admission first loads hook evidence and resolves the requested/current route; launch preparation then resolves the package-owned child guard extension. Inside `preflightDelegateLaunch()`, the hook-contract gate runs before capability/tool policy, limit checks, seed construction, and launch budget admission. All of these checks complete before child process, child session directory, or artifact root creation. Route, guard-extension, hook-contract, or later admission refusal therefore leaves zero child processes and zero delegate artifacts; do not rely on one absolute error-precedence order across those pre-preflight resolutions.

The child launch:

- direct Pi spawn through the registry, not a shell;
- prompt bytes over stdin, not a positional/shell argument;
- separate random `--session-id`;
- task-owned `--session-dir` under the artifact directory;
- parent session/provider/model/reasoning env keys stripped;
- only package-owned child guard extension explicitly loaded;
- ambient extension/skill/template/theme/context discovery disabled.

The only v1 capability is `inspect`. Allowed tools are exactly `read`, `grep`, `find`, `ls`, and `delegate_read_artifact`; forbidden tools deny shell, writes, background task controls, recursive delegation, attested Pi launch, and Fusion. The boundary is argv/tool-registry enforced.

## Route and budget

Routes are pinned once:

- omitted route → parent current model;
- explicit route → exact registry entry;
- unavailable/unknown-capacity routes fail;
- no substitution, fallback, or retry on a different route.

Budgets use a delegate-specific conservative estimator. Constants currently documented by source/tests:

- reserved output: `16,384` tokens;
- framing reserve: `8,192` tokens;
- safety reserve: `4,096` tokens;
- minimum usable input: `8,192` tokens;
- default turns/tools/timeout: `24` / `120` / `1200s`;
- per-result transcript cap: `64 KiB`;
- aggregate tool-output cap: `64 MiB`;
- answer capture cap value carried in the seed: `4 MiB`; current child code does not separately enforce this before packaging;
- inline answer cap: `48 KiB`.

Launch admission measures the child system prompt plus the actual child prompt carrying the seed. Runtime guard measures retained input before every model call. An over-budget runtime call latches `provider_context_budget_exhausted`, aborts the run, and suppresses outgoing content.

## Child guard and commit discipline

The child verifies seed hash, task id, and launch nonce at extension load before the first model call. It then enforces:

- context budget before every provider call;
- per-result spill receipts before tool output enters the transcript;
- aggregate tool-output cap;
- turn and tool-call limits;
- route attestation for assistant messages;
- complete usage records only (missing/partial usage is `unavailable`, never zero);
- accepted final stop reason `stop` only, so provider `length` stops become `child_model_output_limit` rather than partial success;
- non-empty, non-whitespace answer text;
- well-formed UTF-8 answer blocks.

A terminal latch prevents later success commit after any degraded/refused condition. This avoids a hash-valid result built on silently modified context.

`result.json` is the single answer data plane. It is child-written by temp file, file fsync, and rename; POSIX then fsyncs the parent directory, while Windows skips directory fsync because Node does not provide the same portable guarantee there. Final-name presence is the child commit point. No final `result.json` means no accepted answer, regardless of process exit code. `child-terminal.json` records child-side terminal failures when no success package is committed.

After adjudication, the parent makes a best-effort durable write of `outcome.json`. This is separate from `result.json` so child and parent cannot race over one state field. An `outcome.json` write failure is currently ignored and does not change the returned adjudication, so the artifact may be absent even though evaluation completed. Child stdout/stderr are currently captured in the background task output file; although delegate artifact constants name `child.stdout.txt` and `child.stderr.txt`, current registry finalization does not populate those files in the delegate artifact directory.

## Spill artifacts and `delegate_read_artifact`

Oversized tool results are durably written in full under `spill/` and replaced with receipts. A failed spill withholds the original payload and latches a terminal failure; no uncommitted artifact is claimed by receipt.

`delegate_read_artifact` requires:

- `artifact: string` relative to the delegate artifact root;
- `offset: non-negative safe integer`;
- `length: positive safe integer`.

It reads the whole artifact file, verifies the requested range is in bounds, and returns exactly that UTF-8-decoded range. Path escape and short reads fail loudly.

## Retrieval contract

`bg_result` verifies committed packages before returning bytes. It checks identity, seed hash, route and route attestations, schema, usage shape, strict base64, per-block hashes, aggregate hash, byte lengths, and UTF-8 round trip. Running tasks return a not-ready view (`state:"running"`, `delivery:"none"`) without blocking.

Default delivery inlines answers up to `48 KiB`; larger answers return artifact metadata. Explicit oversized inline requests fail with `result_too_large_for_inline`. Answers are never truncated.

Current `autoDeliver` status: `bg_delegate` accepts and records `never | when_small | always` and includes it in launch facts/details. The registry's generic terminal notification currently does not evaluate delegate results or include answer text, so `bg_result` remains the retrieval path.

## User-oriented failure taxonomy

Admission / no child:

- `delegate_hook_contract_unsupported`
- `delegate_isolation_unsupported`
- `route_unresolved`
- `route_capacity_unknown`
- `seed_projection_failed`
- `seed_budget_exceeded`
- `seed_persist_failed`
- `invalid_arguments`

Launch / execution:

- `child_spawn_failed`
- `child_startup_failed`
- `child_timeout`
- `child_cancelled`
- `child_turn_limit`
- `child_tool_call_limit`
- `child_exited_without_commit`

Budget / limits:

- `provider_context_budget_exhausted`
- `aggregate_tool_output_cap`
- `child_model_output_limit`
- `child_capture_limit`

Integrity / artifacts:

- `child_result_invalid`
- `child_result_encoding_invalid`
- `route_attestation_missing`
- `route_mismatch`
- `seed_hash_mismatch`
- `answer_hash_mismatch`
- `artifact_spill_failed`
- `artifact_read_failed`
- `artifact_error`

Retrieval:

- `result_not_ready`
- `result_unavailable`
- `result_too_large_for_inline`
- `task_unknown`

Each `DelegateError` renders code, message, child-created flag, artifact location when known, preserved evidence, and remediation.

## Hook-contract compatibility gate

The child guard relies on Pi hook behavior proven by `tests/scripted-provider/pi-hook-contract.test.ts`; shipped evidence is byte-identical to `src/core/delegate/hook-contract-evidence.json`.

Required guarantees include context hook ordering, returned context messages reaching the provider, abort blocking the provider request by handing an aborted signal, abort terminating the run, context throw isolation, tool-result replacement before transcript entry, replacement identity preservation, and extension load order.

Pi 0.83 evidence explicitly shows two guarantees are false and therefore not required: context throws do not block provider calls, and abort does not skip the provider call site. The guard is built fail-closed anyway: it aborts and returns a suppressed message set, so the original oversized content is not dispatched even if a provider ignored the aborted signal. Missing/malformed/unsupported evidence fails with `delegate_hook_contract_unsupported`; the guard is not weakened at runtime.

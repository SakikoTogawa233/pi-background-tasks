---
doc_id: subsystems/fusion
audience: maintainer
mode: mixed
review_policy: behavioral
stability: stable
covers_surfaces: [renderer:fusion-result, workflow:investigate, workflow:reason, workflow:research, workflow:validate]
covers_sources: [extensions/fusion-child.ts, src/core/fusion/artifacts.ts, src/core/fusion/budget.ts, src/core/fusion/child-protocol.ts, src/core/fusion/clean-context.ts, src/core/fusion/config.ts, src/core/fusion/context.ts, src/core/fusion/evaluation.ts, src/core/fusion/orchestrator.ts, src/core/fusion/pi-child.ts, src/core/fusion/prompts.ts, src/core/fusion/source-policy.ts, src/core/fusion/types.ts, src/core/fusion/web-fetch.ts, src/core/fusion/workflows.ts, src/fusion-child-extension.ts, src/fusion-extension.ts, src/ui/fusion-model-selector.ts]
---

# Fusion subsystem

<!-- pi-docs:begin name="fusion-workflows" generator="scripts/docs/generate.mjs" -->
| Workflow | Tool | Context | Candidate capability | Candidate tools | Evaluator/merger tools | Provenance |
| --- | --- | --- | --- | --- | --- | --- |
| `investigate` | `fusion_investigate` | `clean_task` | `inspect` | `read`, `grep`, `find`, `ls` | none | `src/core/fusion/workflows.ts:80` |
| `reason` | `fusion_reason` | `session_projection` | `reason` | none | none | `src/core/fusion/workflows.ts:61` |
| `research` | `fusion_research` | `clean_task` | `research` | `read`, `grep`, `find`, `ls`, `fusion_web_fetch` | none | `src/core/fusion/workflows.ts:99` |
| `validate` | `fusion_validate` | `clean_task` | `inspect` | `read`, `grep`, `find`, `ls` | none | `src/core/fusion/workflows.ts:118` |
<!-- pi-docs:end name="fusion-workflows" -->

This document is the primary behavioral owner for Fusion's package-owned source files listed in frontmatter. Shared parent-context and token-budget modules are referenced here only as dependencies; their behavior is not owned by this document.

## Public v1 surface

Fusion v1 exposes exactly two commands and exactly four public tools:

- `/fusion` — command shorthand for fixed-purpose `reason`.
- `/fusion-models` — TUI-only global five-slot model selector.
- `fusion_reason({prompt})`.
- `fusion_investigate({objective, background, deliverable, scope?, constraints?})`.
- `fusion_research({objective, background, deliverable, scope?, constraints?, sources})`.
- `fusion_validate({objective, background, changeSummary, scope, acceptanceCriteria, verification, knownLimitations?, exclusions?})`.

Every public tool schema is closed and has no public capability/mode switch. The retired `fusion_brainstorm` surface is never registered; session start removes it from active tools while preserving rendering of historical completed v4 result messages.

## Commands

`/fusion <prompt>` trims the command text and runs the reason workflow. `/fusion` with no arguments opens the multiline editor when UI is available; editor cancellation or blank edited text returns without child spawn. TUI mode wraps the run in a cancellable loader. Success sends a hidden `fusion-request` custom message and a visible `fusion-result` custom message containing the merger's exact text; the parent model is not asked to rewrite the result.

`/fusion-models` requires TUI mode. It edits five slots (`Candidate 1`, `Candidate 2`, `Candidate 3`, `Evaluator`, `Merger`), allows duplicates, supports `$current`, shows unavailable configured choices, and persists `fusion-models.json` with schema `pi-background-tasks.fusion-models.v1`. Saves are lock-protected, atomic, and revision-safe: if the file changed after load, the selector reports a config conflict instead of overwriting concurrent work.

## Context contracts

Reason runs (`/fusion` and `fusion_reason`) receive session-projection canonical input (`pi-background-tasks.fusion-input.v5`). Visible user/assistant text is retained verbatim. Assistant thinking, tool calls, tool-result text, and tool-result images are not forwarded; they become deterministic omission receipts plus a local `context-omission-ledger.json`. User image blocks become marker text, and ledger-only image payloads never enter child prompts. Tool calls exclude the active Fusion leaf and sibling calls from the projected branch.

Investigate, research, and validate receive clean-task canonical input: exactly `schema_version`, `workflow`, `cwd`, `request`, and `context`. Clean tasks carry no parent system prompt, no conversation projection, no parent transcript, and no omission ledger. Their request text is the canonical JSON serialization of the structured public arguments and is fully authoritative.

## Workflow and stage policy

All workflows use the same orchestrator shape:

1. plan budget and write artifacts before any child exists;
2. run three candidate children in parallel;
3. anonymize candidate identities as A/B/C before evaluation;
4. run a blind no-tool evaluator;
5. run one no-tool evaluator-repair child only if the first evaluator JSON is invalid or schema-invalid;
6. run a no-tool merger.

Do not describe Fusion as unconditionally exactly five model calls. A completed run may use five or six child invocations, while preflight failures use zero; candidate failures, cancellation, spawn retry, output caps, or invalid repair alter observed attempts.

Candidate tool policies are fixed by workflow:

| Workflow    | Candidate capability | Candidate tools                                  |
| ----------- | -------------------: | ------------------------------------------------ |
| reason      |             `reason` | none (`--no-tools`)                              |
| investigate |            `inspect` | `read`, `grep`, `find`, `ls`                     |
| research    |           `research` | `read`, `grep`, `find`, `ls`, `fusion_web_fetch` |
| validate    |            `inspect` | `read`, `grep`, `find`, `ls`                     |

Evaluator, evaluator-repair, and merger always use capability `reason` and empty tool lists. Tool-enabled children run with built-in tools disabled and an explicit allowlist plus a denylist that includes shell/write/edit, Fusion recursion, and background/delegate tools.

## Validation specifics

`fusion_validate` enforces a strict public verification contract: `provided` requires non-empty evidence and no reason; `not_run` requires a reason and empty/omitted evidence. Reviewers return closed candidate-report JSON. The host assigns stable finding ids after anonymization, the evaluator must account for every source finding exactly once, and the host renders the final report from validated accounting after the merger. Validation is advisory and read-only: it never edits files, runs tests, gates a release, or replaces builds, linters, scanners, or human review.

## Research specifics

Research is targeted fetch, not search. The public caller declares exact non-duplicate public `http(s)` URLs and purposes. There is no browser, PDF reader, cache, search provider, page-recrawl loop, or domain allowlist.

`fusion_web_fetch` is private to research children and has a closed `{url, extract?}` schema. It rejects credentials, non-http schemes, localhost/known-metadata names, and enumerated private/reserved address classes; vets all DNS answers against that classifier; pins the request to a vetted address; checks the response socket address; follows at most five re-vetted redirects; accepts only HTML/XHTML/plain text/Markdown; caps response bytes at 2 MiB and extracted output at 32 KiB; uses a 60 second deadline; strips script/style/noscript; and extracts text or Markdown. Source-policy admission also rejects literal Azure service address `168.63.129.16`, but the transport classifier does not currently special-case a public DNS/redirect target resolving to that address.

Research intentionally combines read-only file tools and network fetch in one child. This supports source-backed synthesis but is security-sensitive: operators must not supply secret-bearing URLs or ask children to put private data in URL strings. The package blocks common SSRF targets and credential URLs, but its deny rules are not an exhaustive network sandbox; fetched content remains untrusted and caller-declared public URLs can still disclose access through remote logs/timing.

Inspect/research candidates write sealed tool-call audit logs. The log contains schema version, ordinal, tool name, argument/result byte counts and SHA-256 digests, status, duration, and fetch provenance. Raw arguments, raw results, page content, and rejected raw URLs are not persisted. The parent requires the log and seal, verifies hashes/counts/ordinals/status, enforces the 8 MiB aggregate result-byte cap, and rejects non-allowlisted tools. A child may attempt at most 192 tool calls; crossing that limit aborts the run, emits structured refusal evidence, and prevents a complete audit seal.

## Child process isolation

Fusion never calls direct completion APIs. It launches direct child `pi --mode text` processes and writes the prompt over stdin. Child argv includes `--no-session`, `--no-extensions`, `--no-skills`, `--no-prompt-templates`, `--no-themes`, and `--no-context-files`; explicit extensions still load, so the package-owned compact metadata extension is always supplied. Anthropic children additionally receive the `@ravshansbox/pi-anthropic-sps` sanitizer extension because discovery is disabled and Claude routes need Pi system-prompt sanitization.

Child text mode writes the final full answer to stdout. The private child extension emits compact reasoning-free metadata frames to stderr for finalized assistant messages: provider/model, stop reason, text block byte counts and hashes, aggregate text hash, and the complete Pi `Usage` object. It also governs every final `before_provider_request` payload after earlier extensions have transformed it. Claude's sanitizer therefore loads before the package governor. The governor serializes and hashes the exact payload, applies the shared conservative estimator, reserves the model's declared maximum output plus 4,096 safety tokens, and aborts before transport if the payload cannot fit or if the child exceeds 128 provider requests. Pi's provider-hook behavior is characterized through the same `openai-codex-responses` transport adapter used by subscription Codex routes in a real local HTTP agent loop: transforms chain in extension load order and `ctx.abort()` prevents network transport. At terminal `agent_settled`, the extension emits exactly one `pi-background-tasks.fusion-child-settlement.v1` frame binding the complete ordered metadata stream by count and SHA-256, the final record/hash, and any recovered retry-marker ordinals. The parent reconstructs and validates stdout against the final metadata, requires final stop reason `stop`, verifies model identity, and preserves usage/cost exactly. Non-final `toolUse` records remain normal. A non-final `error` is accepted only when it is a zero-content, empty-hash, zero-usage retry marker, a later final `stop` exists, and the terminal settlement hash/accounts for that exact ordinal. `length`, `aborted`, `pending`, final `error`, error records carrying text or usage, missing/duplicate/tampered settlement, and settlement before terminal idleness all fail loudly.

Fusion child environments strip session/model/provider variables plus metered credential/base-url variables for OpenRouter, OpenAI, Anthropic, Azure OpenAI, and generic Pi API credentials before launch. Frontier model routes are admitted only when the registry reports subscription OAuth for trusted `anthropic` or `openai-codex` endpoints. There is no fallback, model substitution, endpoint override, or metered API-key route.

## Budgets and output contracts

Budget planning is per route and per stage. Every configured candidate, evaluator, and merger route must have a usable context window. The affine estimator from the shared token-budget layer accounts for byte classes plus a 512-token intercept; backed model-family calibrations are used only where applicable, unknown/unbacked providers are reported in artifacts/result details, and multibyte/dense ASCII diagnostics are preserved.

`budget-plan.json` uses `pi-background-tasks.fusion-budget-plan.v4` and records route capacities, stage forecasts for candidate/evaluation/evaluation-repair/merge, conditional repair reservation, warnings, blockers, empty-request counterfactuals, and remediation. Each route reserves the larger of Fusion's 32,768-token output contract reserve and the resolved model's declared maximum output; a model advertising a 128,000-token maximum therefore receives the full 128,000-token reserve. Fatal preflight blockers launch zero children. High utilization or worst-case reservation pressure is a warning when input still fits. Exact rendered prompt checks happen again immediately before candidate, evaluation, repair, and merge launches.

Output contracts are checked after durable attempt recording: candidate responses up to 48 KiB JSON-rendered bytes, evaluator up to 64 KiB, merger/final report up to 64 KiB, diagnostics contract 8 KiB, child stdout cap 32 MiB, child stderr cap 4 MiB. Oversized child output fails loudly and preserves evidence; Fusion never clips or silently forwards truncated content.

## Artifacts, usage, and lifecycle

Run artifacts are private local evidence under `.pi/fusion/<session-id>-<pid>/<run-id>/`. They include `manifest.json`, `canonical-input.json`, `budget-plan.json`, per-attempt prompts/events/stderr/responses, optional partial responses for failed attempts, optional tool-call logs/seals, `blind-candidates.json`, `evaluation.json`, `merged.md`, `error.json`, and workflow-specific context/source-policy artifacts.

Artifact writes use durable private temp-file/fsync/rename. Manifests enforce legal state transitions and record config, resolved models, fixed capabilities, context policy, tool policy, anonymous map, attempts, artifact refs, cumulative usage, and errors. Successful, failed, and cancelled observed attempts preserve complete Pi usage/cost components; public tool results clone the same `Usage` shape.

For tool-enabled children, the private audit journal remains open across every low-level `agent_end`, because Pi may still retry, compact and retry, or process a queued continuation. Only terminal `agent_settled` can exclusively publish the complete hash/count/byte seal. Runtime-guard refusal latches process failure, makes that seal incomplete, and forces the result settlement to failed. The child emits one closed `pi-background-tasks.fusion-runtime-guard.v1` stderr frame containing the refusal code, route capacities, request/tool ordinals, exact payload byte count and SHA-256, conservative token estimate, and a bounded message; it never emits the payload itself. The parent validates this frame and reports typed `child_runtime_budget_exceeded` instead of accepting a later clean-looking result or reducing it to an unexplained exit code. Tool activity after finalization, duplicate settlement, pre-settlement shutdown, extension diagnostics, malformed/duplicate runtime-guard frames, and missing/failed/stale seals are fatal. This lifecycle requires Pi 0.81.1 or newer; older Pi lines do not expose the required terminal event and are not claimed as compatible.

Cancellation and shutdown are loud and durable when a run store exists. The extension tracks active runs, links external abort signals, aborts on session shutdown/reload, and waits for settlement. Child processes have a 30 minute wall timeout, 20 minute idle watchdog, SIGTERM grace, SIGKILL wait, process-group kill on POSIX, bounded stdout/stderr, and cleanup-error propagation.

## Troubleshooting

- `/fusion-models requires Pi TUI mode`: run from the TUI, not RPC/print/JSON.
- `$current` unavailable or model unavailable: choose explicit available subscription routes with `/fusion-models`.
- Frontier/API route rejected: use Pi Anthropic or Codex subscription OAuth, not OpenAI/OpenRouter/Azure/API-key routes.
- `prompt_budget_exceeded_forecast`: inspect `budget-plan.json`; the error says whether shortening the request can help or whether session history/scope/model context window is the blocker.
- `prompt_budget_exceeded_measured`: an exact rendered prompt exceeded capacity after upstream output was known; split the workflow or choose a larger-context subscription route.
- `child_runtime_budget_exceeded`: a later provider payload, provider-request loop, or tool-call loop crossed a child runtime guard after launch. Inspect the attempt stderr guard frame and failed tool seal; narrow the task or select a subscription route with more safe input headroom. Do not ignore intermediate provider errors or weaken the guard.
- `evaluation schema repair failed`: both evaluator attempts failed the closed JSON contract; inspect `evaluation.attempt-*.response.txt` and errors.
- `tool-call log invalid`: inspect the candidate `*.tool-calls.jsonl` and `*.seal.json`; missing/partial/unsealed logs, non-allowlisted tools, hash/count mismatches, and over-budget tool output fail by design.
- Research fetch failures are typed and do not retry via other URLs or extraction modes; verify the declared URL is public, reachable, supported content, and within caps.

Related user docs: [`../commands/fusion.md`](../commands/fusion.md), [`../commands/fusion-models.md`](../commands/fusion-models.md), [`../tools/fusion_reason.md`](../tools/fusion_reason.md), [`../tools/fusion_investigate.md`](../tools/fusion_investigate.md), [`../tools/fusion_research.md`](../tools/fusion_research.md), [`../tools/fusion_validate.md`](../tools/fusion_validate.md).

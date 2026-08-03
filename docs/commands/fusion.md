---
doc_id: commands/fusion
audience: user
mode: mixed
review_policy: contract
stability: stable
covers_surfaces: [command:fusion]
covers_sources: []
---
# `/fusion`

<!-- pi-docs:begin name="command-contract-fusion" generator="scripts/docs/generate.mjs" -->
| Command | Description | Provenance |
| --- | --- | --- |
| `/fusion` | Run fixed-purpose Fusion reason (no candidate tools) and append the merged result directly. | `src/fusion-extension.ts:891` |
<!-- pi-docs:end name="command-contract-fusion" -->

Run the fixed-purpose Fusion **reason** workflow from the command line.

## Synopsis

`/fusion <prompt>`

`/fusion` with no arguments opens Pi's multiline editor in UI-capable modes. If the editor is cancelled or the edited text is blank after trimming, Fusion returns without spawning children.

## Current v1 behavior

`/fusion` is shorthand for `fusion_reason({prompt})`:

- the public workflow is always `reason`;
- there is no capability or mode argument;
- candidate children run without tools;
- evaluator, conditional evaluator-repair, and merger children also run without tools;
- the request is captured as a versioned visible-conversation projection, not as a raw transcript.

The retired `fusion_brainstorm` public tool is not registered and is removed from active tools on session start. Historical completed v4 result messages can still render, but `/fusion` never reactivates the retired surface.

## Conversation input

Reason/session-projection input uses schema `pi-background-tasks.fusion-input.v5`. The child-facing input contains:

- `request.text` with the exact command prompt;
- request authority `directive_over_projected_conversation` for the command path;
- the parent system prompt inside the versioned session-projection context;
- visible user/assistant text entries preserved verbatim;
- deterministic omission receipts for assistant thinking, tool calls, and text/image tool results.

Omitted payload bytes are not summarized or previewed for the children. If a fact exists only inside omitted tool output, restate it in the prompt.

## Result delivery

After a successful run, `/fusion` appends two custom messages without asking the parent model to rewrite the answer:

1. a hidden `fusion-request` record for the command request/run id;
2. a visible `fusion-result` record whose content is the merger's exact text and whose details include run id, artifact directory, model summary, usage/cost, evaluator-attempt count, and budget metadata.

In TUI mode `/fusion` uses a cancellable loader. Cancelling aborts the active child process tree and records a cancelled run when a run directory exists.

## Calls and failure shape

A successful run uses three candidate children, one blind evaluator, and one merger. If the first evaluator response is invalid JSON or violates the closed evaluation schema, Fusion performs exactly one evaluator-repair attempt before failing or continuing. Therefore a successful run may have five or six child invocations; preflight failures launch zero children, and candidate/evaluator/merge failures stop the workflow rather than substituting another model.

Failures are reported as `Fusion failed: ...`; tool/stage errors include the artifact directory when one exists. Prompt-budget forecast failures happen before child creation. Child cancellation, timeout, output caps, model-route admission failures, invalid evaluator JSON after repair, invalid compact child metadata, and invalid tool-call audits are loud failures.

## Related

- Tool equivalent: [`../tools/fusion_reason.md`](../tools/fusion_reason.md)
- Model selector: [`fusion-models.md`](fusion-models.md)
- Behavioral owner/troubleshooting: [`../subsystems/fusion.md`](../subsystems/fusion.md)

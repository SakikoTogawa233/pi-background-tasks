---
doc_id: tools/fusion_reason
audience: agent
mode: mixed
review_policy: contract
stability: stable
covers_surfaces: [tool:fusion_reason]
covers_sources: []
---
# `fusion_reason`

<!-- pi-docs:begin name="tool-contract-fusion_reason" generator="scripts/docs/generate.mjs" -->
- Label: **Fusion Reason**
- Source: `src/fusion-extension.ts:1032`
- Description: Run a five-model Fusion reason workflow. Candidate children receive the reason projection and no tools; evaluator and merger also run without tools.
- Root schema: `object`; additionalProperties: `false`

| Field | Required | Type | Description | Constraints |
| --- | --- | --- | --- | --- |
| `prompt` | yes | `string` | Reasoning request. Candidate children run without tools over the reason workflow's projected conversation context. | minLength 1 |

<details>
<summary>Normalized TypeBox contract</summary>


```json
{
  "additionalProperties": false,
  "properties": {
    "prompt": {
      "description": "Reasoning request. Candidate children run without tools over the reason workflow's projected conversation context.",
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "prompt"
  ],
  "type": "object"
}
```

</details>
<!-- pi-docs:end name="tool-contract-fusion_reason" -->

Fixed-purpose public Fusion tool for self-contained no-tool reasoning.

## Signature

```ts
fusion_reason({ prompt: string })
```

The schema is closed: `prompt` is required, must trim to non-blank text, and no other keys are accepted. There is no public `capability`, mode, provider, model, or tool-policy argument.

## Context and tools

`fusion_reason` receives a versioned session-projection input (`pi-background-tasks.fusion-input.v5`): visible user/assistant text is retained verbatim, while assistant thinking and tool traffic are replaced by deterministic omission receipts and a local omission ledger artifact. Tool-call invocations exclude the active Fusion tool-call leaf and sibling calls from the projected branch.

Candidate children run with `--no-tools`. The blind evaluator, conditional evaluator-repair, and merger also run with `--no-tools` by stage policy.

## Execution model

A successful run starts three candidate children, then a blind evaluator, then a merger. If the evaluator output is not valid closed-schema JSON, Fusion performs one evaluator-repair attempt and revalidates. Do not assume exactly five child calls: repair, preflight refusal, cancellation, spawn retry, and failures change the observed attempt count.

The tool result returns the merger's exact text directly, with `details` containing the Fusion result metadata and `usage` cloning the complete Pi `Usage` object including all cost fields.

## Limitations

Omitted tool payloads are not available to children. Restate required facts from prior tool output inside `prompt` before calling.

## Related

- Command shorthand: [`../commands/fusion.md`](../commands/fusion.md)
- Behavioral owner/troubleshooting: [`../subsystems/fusion.md`](../subsystems/fusion.md)

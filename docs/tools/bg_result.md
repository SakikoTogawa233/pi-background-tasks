---
doc_id: tools/bg_result
audience: agent
mode: mixed
review_policy: contract
stability: stable
covers_surfaces: [tool:bg_result]
covers_sources: []
---
# `bg_result`

<!-- pi-docs:begin name="tool-contract-bg_result" generator="scripts/docs/generate.mjs" -->
- Label: **Delegate Result**
- Source: `src/delegate-extension.ts:428`
- Description: Retrieve the hash-verified answer from a bg_delegate task. Never blocks: a running task returns a typed not-ready result. A completed answer is verified against its recorded SHA-256 before it is returned, and an oversized answer is never truncated.
- Root schema: `object`; additionalProperties: `false`

| Field | Required | Type | Description | Constraints |
| --- | --- | --- | --- | --- |
| `delivery` | no | `string` | inline returns the verified answer text; artifact returns metadata plus the artifact reference. Oversized answers are never truncated. |  |
| `taskId` | yes | `string` | Delegate task id returned by bg_delegate. |  |

<details>
<summary>Normalized TypeBox contract</summary>


```json
{
  "additionalProperties": false,
  "properties": {
    "delivery": {
      "description": "inline returns the verified answer text; artifact returns metadata plus the artifact reference. Oversized answers are never truncated.",
      "type": "string"
    },
    "taskId": {
      "description": "Delegate task id returned by bg_delegate.",
      "type": "string"
    }
  },
  "required": [
    "taskId"
  ],
  "type": "object"
}
```

</details>
<!-- pi-docs:end name="tool-contract-bg_result" -->

`bg_result` retrieves the result of a `bg_delegate` task. It never blocks: a running task returns a typed not-ready view, and a terminal task is verified before any answer bytes are returned.

## Public arguments

Required:

- `taskId: string` — task id or unambiguous prefix resolved by the background-task registry. Must be non-empty after trimming.

Optional:

- `delivery: "inline" | "artifact"` — if omitted, answers at or below `48 KiB` are returned inline and larger answers are returned as an artifact reference. `artifact` always returns metadata/reference. `inline` for an oversized answer fails loudly.

The TypeBox schema is closed (`additionalProperties: false`).

## Not-ready behavior

If the delegate task is still running, `bg_result` returns successfully with details:

- `schema_version: "pi-background-tasks.delegate-result-view.v1"`;
- `state: "running"`;
- `delivery: "none"`;
- artifact dir and budget facts when available.

This is not an error and does not wait. End the turn or do other independent work until the terminal notification arrives.

## Verification before return

For terminal tasks, the parent evaluates the child artifacts. `result.json` is the child-written commit point. If it is absent, the task has no accepted answer even if the child exited `0`.

A present package is accepted only after verifying:

1. JSON shape and schema version;
2. `task_id` and `launch_nonce`;
3. `seed_sha256`;
4. route object and every route attestation against the pinned provider/model;
5. answer encoding (`utf-8`);
6. strict base64 for every answer block;
7. every block byte length and SHA-256;
8. aggregate answer byte length and SHA-256;
9. well-formed UTF-8 round trip.

The returned text is decoded from the same aggregate buffer that was hashed. Corruption, stale packages, missing attestations, route drift, or invalid UTF-8 produce typed failures and no answer bytes.

## Inline/artifact delivery and no truncation

`bg_result` never truncates an answer.

- Default delivery: inline when `answer.byte_length <= 48 KiB`, artifact reference otherwise.
- `delivery: "artifact"`: returns metadata and points to `.pi/delegate/.../result.json` even for small answers.
- `delivery: "inline"`: returns the full verified answer only if it fits the inline cap; otherwise fails with `result_too_large_for_inline` and names the preserved artifact.

Large answers remain complete in `result.json` as base64 blocks plus aggregate hash.

## Failure classes users see

Common retrieval outcomes:

- `task_unknown` — unknown id/prefix or not a delegate task.
- `result_unavailable` / `child_exited_without_commit` — terminal task produced no committed result package.
- `child_cancelled`, `child_timeout`, `child_turn_limit`, `child_tool_call_limit` — child did not complete cleanly.
- `provider_context_budget_exhausted`, `aggregate_tool_output_cap`, `child_model_output_limit` — budget/limit refusal.
- `route_attestation_missing`, `route_mismatch` — route evidence missing or not the pinned route.
- `seed_hash_mismatch`, `answer_hash_mismatch`, `child_result_invalid`, `child_result_encoding_invalid` — integrity or encoding failure.
- `artifact_read_failed`, `artifact_spill_failed`, `artifact_error` — artifact I/O failure.
- `result_too_large_for_inline` — explicit inline request exceeded the inline cap.

Delegate errors include whether a child process was created, preserved artifact hints when known, and remediation text. Usage missing from the provider is reported as `unavailable`, not synthesized as zero.

## Parent outcome separation

After evaluation, the parent attempts a durable `outcome.json` write separately from child-written `result.json`. This avoids either writer overwriting the other's evidence, but the write is best-effort: its failure is ignored and does not change the returned adjudication, so `outcome.json` may be absent.

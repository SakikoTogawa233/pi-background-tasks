---
doc_id: tools/bg_kill
audience: agent
mode: mixed
review_policy: contract
stability: stable
covers_surfaces: [tool:bg_kill]
covers_sources: []
---
# `bg_kill`

Stop a running task. Shell tasks route through process-tree termination. External tasks route one correlated cancellation request and wait for owner acknowledgement and settlement.

<!-- pi-docs:begin name="tool-contract-bg_kill" generator="scripts/docs/generate.mjs" -->
- Label: **Background Kill**
- Source: `src/extension.ts:839`
- Description: Stop a running background task by ID. Fails loudly if the task is unknown or already finished.
- Root schema: `object`

| Field | Required | Type | Description | Constraints |
| --- | --- | --- | --- | --- |
| `taskId` | yes | `string` | Task ID or unambiguous prefix to stop |  |

<details>
<summary>Normalized TypeBox contract</summary>


```json
{
  "properties": {
    "taskId": {
      "description": "Task ID or unambiguous prefix to stop",
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
<!-- pi-docs:end name="tool-contract-bg_kill" -->

---
doc_id: tools/bg_status
audience: agent
mode: mixed
review_policy: contract
stability: stable
covers_surfaces: [tool:bg_status]
covers_sources: []
---
# `bg_status`

Point-in-time status for one task or recent tasks. It is not a waiting loop.

<!-- pi-docs:begin name="tool-contract-bg_status" generator="scripts/docs/generate.mjs" -->
- Label: **Background Status**
- Source: `src/extension.ts:763`
- Description: Inspect one background task or list all running/recent background tasks. This is a point-in-time inspection tool, not a waiting primitive.
- Root schema: `object`

| Field | Required | Type | Description | Constraints |
| --- | --- | --- | --- | --- |
| `taskId` | no | `string` | Optional task ID or unambiguous prefix. If omitted, all running/recent tasks are returned. |  |

<details>
<summary>Normalized TypeBox contract</summary>


```json
{
  "properties": {
    "taskId": {
      "description": "Optional task ID or unambiguous prefix. If omitted, all running/recent tasks are returned.",
      "type": "string"
    }
  },
  "required": [],
  "type": "object"
}
```

</details>
<!-- pi-docs:end name="tool-contract-bg_status" -->

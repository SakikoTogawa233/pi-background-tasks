---
doc_id: tools/bg_logs
audience: agent
mode: mixed
review_policy: contract
stability: stable
covers_surfaces: [tool:bg_logs]
covers_sources: []
---
# `bg_logs`

Read a bounded head or tail from a task output file. Full output remains on disk.

<!-- pi-docs:begin name="tool-contract-bg_logs" generator="scripts/docs/generate.mjs" -->
- Label: **Background Logs**
- Source: `src/extension.ts:794`
- Description: Read bounded output from a background task for deliberate inspection; this is not a waiting primitive. Output is capped at 50.0KB for model safety and points to the full output file when truncated.
- Root schema: `object`

| Field | Required | Type | Description | Constraints |
| --- | --- | --- | --- | --- |
| `maxBytes` | no | `number` | Maximum bytes to return, capped at 50.0KB. Default: 50.0KB. |  |
| `tail` | no | `boolean` | Read the tail of the log when true, head when false. Default: true. |  |
| `taskId` | yes | `string` | Task ID or unambiguous prefix |  |

<details>
<summary>Normalized TypeBox contract</summary>


```json
{
  "properties": {
    "maxBytes": {
      "description": "Maximum bytes to return, capped at 50.0KB. Default: 50.0KB.",
      "type": "number"
    },
    "tail": {
      "description": "Read the tail of the log when true, head when false. Default: true.",
      "type": "boolean"
    },
    "taskId": {
      "description": "Task ID or unambiguous prefix",
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
<!-- pi-docs:end name="tool-contract-bg_logs" -->

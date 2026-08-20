---
doc_id: tools/bg_run
audience: agent
mode: mixed
review_policy: contract
stability: stable
covers_surfaces: [tool:bg_run]
covers_sources: []
---
# `bg_run`

Start a named background shell command and return immediately with task id and output path. Default completion delivery sends a durable notification and starts one follow-up turn.

<!-- pi-docs:begin name="tool-contract-bg_run" generator="scripts/docs/generate.mjs" -->
- Label: **Background Run**
- Source: `src/extension.ts:683`
- Description: Start a named long-running shell command in the background and return immediately with a task ID and output path. By default, completed, failed, or killed terminal state is delivered automatically as <background-task-notification> and starts a follow-up agent turn; do not sleep or poll merely to wait. Output is written to .pi/tasks and model-visible logs are bounded to 50.0KB.
- Root schema: `object`

| Field | Required | Type | Description | Constraints |
| --- | --- | --- | --- | --- |
| `command` | yes | `string` | Shell command to start in the background |  |
| `description` | no | `string` | Optional longer human-readable context for the task |  |
| `isAgent` | yes | `boolean` | Required for preserved shell API compatibility. Classify the command as agent-launched or ordinary; this package applies no workflow-specific behavior. |  |
| `name` | yes | `string` | Short human-readable task name shown in the bg footer dock. Required; use 2-6 words, not the raw command. |  |
| `notifyOnCompletion` | no | `boolean` | Whether to deliver the durable terminal notification. Default: true; disable only when deliberately taking over completion monitoring. |  |
| `timeoutSeconds` | no | `number` | Optional timeout; task is failed and killed when exceeded |  |
| `triggerOnCompletion` | no | `boolean` | Whether that notification should automatically trigger a follow-up agent turn. Default: true for bg_run; requires notifyOnCompletion. |  |

<details>
<summary>Normalized TypeBox contract</summary>


```json
{
  "properties": {
    "command": {
      "description": "Shell command to start in the background",
      "type": "string"
    },
    "description": {
      "description": "Optional longer human-readable context for the task",
      "type": "string"
    },
    "isAgent": {
      "description": "Required for preserved shell API compatibility. Classify the command as agent-launched or ordinary; this package applies no workflow-specific behavior.",
      "type": "boolean"
    },
    "name": {
      "description": "Short human-readable task name shown in the bg footer dock. Required; use 2-6 words, not the raw command.",
      "type": "string"
    },
    "notifyOnCompletion": {
      "description": "Whether to deliver the durable terminal notification. Default: true; disable only when deliberately taking over completion monitoring.",
      "type": "boolean"
    },
    "timeoutSeconds": {
      "description": "Optional timeout; task is failed and killed when exceeded",
      "type": "number"
    },
    "triggerOnCompletion": {
      "description": "Whether that notification should automatically trigger a follow-up agent turn. Default: true for bg_run; requires notifyOnCompletion.",
      "type": "boolean"
    }
  },
  "required": [
    "command",
    "isAgent",
    "name"
  ],
  "type": "object"
}
```

</details>
<!-- pi-docs:end name="tool-contract-bg_run" -->

---
doc_id: reference/runtime-contracts
audience: maintainer
mode: mixed
review_policy: contract
stability: stable
covers_surfaces: []
covers_sources: []
---
# Runtime contracts reference

<!-- pi-docs:begin name="runtime-contracts" generator="scripts/docs/generate.mjs" -->
### Environment variable references

| Name | Access | Provenance |
| --- | --- | --- |
| `ComSpec` | read | `src/core/common.ts:519`<br>`src/core/common.ts:530` |
| `path` | read | `src/core/common.ts:474` |
| `Path` | read | `src/core/common.ts:474` |
| `PATH` | read | `src/core/common.ts:474` |
| `PI_BG_DISABLE_UPDATE_CHECK` | read | `src/extension.ts:429` |
| `PI_BG_MAX_OUTPUT_BYTES` | read | `src/core/registry.ts:35` |
| `PI_BG_REGISTRY_URL` | read | `src/extension.ts:438` |
| `PI_BG_SHELL` | read | `src/core/common.ts:515` |
| `PI_BG_SHELL_PATH` | read | `src/core/common.ts:516` |
| `PI_MODEL` | read, write | `src/core/foreground-bash.ts:589`<br>`src/core/foreground-bash.ts:596` |
| `PI_OFFLINE` | read | `src/extension.ts:430` |
| `PI_PROVIDER` | read, write | `src/core/foreground-bash.ts:588`<br>`src/core/foreground-bash.ts:595` |
| `PI_REASONING_LEVEL` | read, write | `src/core/foreground-bash.ts:590`<br>`src/core/foreground-bash.ts:598` |
| `PI_SESSION_FILE` | read, write | `src/core/foreground-bash.ts:587`<br>`src/core/foreground-bash.ts:593` |
| `PI_SESSION_ID` | read, write | `src/core/foreground-bash.ts:586`<br>`src/core/foreground-bash.ts:591` |
| `SHELL` | read | `src/core/common.ts:511` |
| `SystemRoot` | read | `src/core/windows-taskkill.ts:96` |
| `WINDIR` | read | `src/core/windows-taskkill.ts:101` |

### Runtime paths and artifacts

| Kind | Path/artifact | Provenance |
| --- | --- | --- |
| directory | `.pi/tasks/<session-id>-<pid>/` | `src/core/registry.ts:302` |
| task-file | `.pi/tasks/<session-id>-<pid>/<task-id>.json` | `src/core/registry.ts:451` |
| task-file | `.pi/tasks/<session-id>-<pid>/<task-id>.output` | `src/core/registry.ts:450` |

### Schema identifiers

| Schema | Provenance |
| --- | --- |
| `pi-background-tasks.extension-request.v1` | `src/core/extension-api.ts:19` |
| `pi-background-tasks.extension-response.v1` | `src/core/extension-api.ts:20` |
| `pi-background-tasks.extension-terminal.v1` | `src/core/extension-api.ts:21` |
| `pi-background-tasks.external-cancel.v2` | `src/core/extension-api.ts:29` |
| `pi-background-tasks.external-request.v2` | `src/core/extension-api.ts:27` |
| `pi-background-tasks.external-response.v2` | `src/core/extension-api.ts:28` |
| `pi-background-tasks.external-terminal.v2` | `src/core/extension-api.ts:30` |

### Status vocabularies


```json
{
  "TASK_STATUS_VALUES": [
    "running",
    "completed",
    "failed",
    "killed"
  ],
  "TERMINAL_TASK_STATUS_VALUES": [
    "completed",
    "failed",
    "killed"
  ]
}
```
<!-- pi-docs:end name="runtime-contracts" -->

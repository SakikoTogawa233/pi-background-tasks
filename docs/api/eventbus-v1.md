---
doc_id: api/eventbus-v1
audience: maintainer
mode: mixed
review_policy: behavioral
stability: stable
covers_surfaces: [eventbus:background-task-v1, eventbus:external-task-v2]
covers_sources: [src/core/extension-api.ts]
---
# EventBus contracts

<!-- pi-docs:begin name="eventbus-contract" generator="scripts/docs/generate.mjs" -->
| v1 channel purpose | Channel | Schema |
| --- | --- | --- |
| Request | `pi-background-tasks:request:v1` | `pi-background-tasks.extension-request.v1` |
| Response | `pi-background-tasks:response:v1` | `pi-background-tasks.extension-response.v1` |
| Terminal | `pi-background-tasks:terminal:v1` | `pi-background-tasks.extension-terminal.v1` |

v1 operations: `capabilities`, `kill`, `logs`, `run`, `status`.


```json
{
  "api_version": 1,
  "kill": true,
  "logs": true,
  "logs_bounded": true,
  "run": true,
  "run_completion_trigger": true,
  "run_is_agent": true,
  "status": true
}
```


| v2 channel purpose | Channel | Schema |
| --- | --- | --- |
| Request | `pi-background-tasks:external-request:v2` | `pi-background-tasks.external-request.v2` |
| Response | `pi-background-tasks:external-response:v2` | `pi-background-tasks.external-response.v2` |
| Cancellation | `pi-background-tasks:external-cancel:v2` | `pi-background-tasks.external-cancel.v2` |
| Terminal | `pi-background-tasks:external-terminal:v2` | `pi-background-tasks.external-terminal.v2` |

v2 operations: `cancel_ack`, `handshake`, `kill`, `log`, `logs`, `register`, `settle`, `status`, `update`.


```json
{
  "api_version": 2,
  "cancel": true,
  "cancel_ack": true,
  "kill": true,
  "log": true,
  "logs": true,
  "logs_bounded": true,
  "register": true,
  "settle": true,
  "status": true,
  "terminal_after_settle": true,
  "update": true
}
```
<!-- pi-docs:end name="eventbus-contract" -->

## Shell v1 preservation

V1 remains closed and compatible for `capabilities`, `run`, `status`, `logs`, and `kill`. Run and kill terminal publication is gated until the correlated response is observable. Terminal metadata is written before publication. Duplicate request ids, malformed frames, unknown operations, pre-session requests, and shutdown requests fail loudly.

## External-task v2

V2 is domain-neutral and owner-managed:

1. `handshake` claims a unique owner id and returns the compatible service id plus owner token.
2. `register` allocates the task id in the background registry and records only generic name/description, owner reference, capabilities, delivery flags, output path, and lifecycle state.
3. `update` and `log` require the exact next per-task sequence.
4. `kill` emits one correlated cancellation frame when the task is cancellable.
5. `cancel_ack` must match the active cancellation id.
6. `settle` commits `completed`, `failed`, or `killed`; a cancellation must be acknowledged and settle as `killed`.
7. Terminal publication occurs only after settlement, durable terminal metadata, the settle response, and any correlated kill response.

All frames are closed. Unknown keys—including domain-specific fields—are rejected before task creation or mutation. Unknown owners, stale service ids/tokens, duplicate owner references, duplicate request ids, and out-of-order sequences also fail without partial mutation.

During shutdown, new work is refused while `cancel_ack` and `settle` remain available so already-routed cancellation can complete before the service closes.

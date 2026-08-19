---
doc_id: api/eventbus-v1
audience: maintainer
mode: mixed
review_policy: behavioral
stability: evolving
covers_surfaces: [eventbus:background-task-v1]
covers_sources: [src/core/extension-api.ts]
---
# EventBus API v1

<!-- pi-docs:begin name="eventbus-contract" generator="scripts/docs/generate.mjs" -->
| Channel purpose | Channel | Schema |
| --- | --- | --- |
| Request | `pi-background-tasks:request:v1` | `pi-background-tasks.extension-request.v1` |
| Response | `pi-background-tasks:response:v1` | `pi-background-tasks.extension-response.v1` |
| Terminal | `pi-background-tasks:terminal:v1` | `pi-background-tasks.extension-terminal.v1` |

Operations: `capabilities`, `kill`, `logs`, `run`, `status`.


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
<!-- pi-docs:end name="eventbus-contract" -->

Primary source: `src/core/extension-api.ts`. Code is authoritative.

## Channels and schema ids

| Purpose | Channel | `schema_version` |
|---|---|---|
| Requests | `pi-background-tasks:request:v1` | `pi-background-tasks.extension-request.v1` |
| Responses | `pi-background-tasks:response:v1` | `pi-background-tasks.extension-response.v1` |
| Terminal events | `pi-background-tasks:terminal:v1` | `pi-background-tasks.extension-terminal.v1` |

## Request frame

Closed object; unknown keys fail.

```ts
{
  schema_version: 'pi-background-tasks.extension-request.v1',
  request_id: string,        // non-empty, max 200 chars
  operation: 'capabilities' | 'run' | 'status' | 'logs' | 'kill',
  payload: object            // operation-specific closed object
}
```

Payloads:

- `capabilities`: `{}` only.
- `run`: `{ name, command, isAgent, notifyOnCompletion, triggerOnCompletion, timeoutSeconds? }`; strings are non-empty, booleans are booleans, `timeoutSeconds` is a positive integer when present.
- `status`: `{ taskId? }`; `taskId` is non-empty when present.
- `logs`: `{ taskId, maxBytes?, tail? }`; `maxBytes` is positive when present and is still bounded by runtime log caps.
- `kill`: `{ taskId }`.

Malformed frames still receive a response where possible: `request_id` and `operation` echo valid non-empty input strings, otherwise `malformed`.

## Response frame

Closed by construction through the exported union:

```ts
// success
{
  schema_version: 'pi-background-tasks.extension-response.v1',
  request_id: string,
  operation: string,
  ok: true,
  result: BackgroundTaskExtensionResult
}

// error
{
  schema_version: 'pi-background-tasks.extension-response.v1',
  request_id: string,
  operation: string,
  ok: false,
  error: string             // whitespace-compacted, max 240 chars
}
```

Duplicate `request_id` values are rejected within one service lifecycle. The service rejects requests before `session_start` and while shutting down. Calling `beginShutdown()` unsubscribes the request listener, so later requests are not handled and receive no service response; `close()` is valid only after the owned request promises drain. After a later `session_start` on the same extension instance, the extension installs one fresh service and one fresh subscription; the permanently closed prior service is never reused.

## Capabilities

`capabilities` returns exactly:

```json
{
  "api_version": 1,
  "run": true,
  "run_is_agent": true,
  "run_completion_trigger": true,
  "status": true,
  "logs": true,
  "logs_bounded": true,
  "kill": true
}
```

## Terminal frames

Terminal events are emitted on `pi-background-tasks:terminal:v1`:

```ts
{
  schema_version: 'pi-background-tasks.extension-terminal.v1',
  task: BgTaskSnapshot
}
```

The terminal event carries no request id; consumers correlate by `task.id` returned from `run`/`kill`/`status`.

## Ordering and durability barrier

For `run` and `kill` requests, the service installs a terminal-publication gate. After the response is emitted, the gate waits one microtask before releasing terminal publication, so immediate-exit tasks cannot publish terminal before the caller has observed the task id.

The registry publishes terminal snapshots only after the output stream has finished/closed and durable terminal metadata has been written. Each task owns one publication promise, and successful publication is latched and not emitted again. If `EventBus.emit` throws, that promise rejects loudly; the registry does not schedule timer-based redelivery, because an earlier listener may already have observed the frame.

Session shutdown closes registry launch admission and request intake synchronously, then drains all registry launches admitted before that boundary before taking the existing-task snapshot. Post-spawn startup failures remain launch-owned while the registry terminates the child and awaits its shared phase-A/phase-B finalization. Shutdown settles the task snapshot, drains the exact promises for requests already in flight, settles a second snapshot, and then drains all owned terminal-publication promises before closing the service. The first task pass prevents a kill deadlock: `stopTask` can finish phase B, the kill handler can emit its response and release its publication gate, and only then does publication drain complete. A subsequent session recreates the service rather than publishing through the closed instance.

## Operations

- `run` starts a background task through the registry and returns a `BgTaskSnapshot`.
- `status` returns `{ tasks }`; with `taskId`, the array has one resolved task or errors loudly.
- `logs` returns bounded log details plus `text`; full bytes stay in `.pi/tasks/...output`.
- `kill` stops a running task and returns `{ task, message }` after the stop path.
- `capabilities` is pure and does not require a task.

## Integration example

```ts
const requestId = crypto.randomUUID();
const terminal = new Promise((resolve) => {
  const off = events.on('pi-background-tasks:terminal:v1', (frame) => {
    if (frame?.schema_version === 'pi-background-tasks.extension-terminal.v1') {
      off();
      resolve(frame.task);
    }
  });
});

events.emit('pi-background-tasks:request:v1', {
  schema_version: 'pi-background-tasks.extension-request.v1',
  request_id: requestId,
  operation: 'run',
  payload: {
    name: 'Example',
    command: 'printf eventbus-ok',
    isAgent: false,
    notifyOnCompletion: true,
    triggerOnCompletion: true
  }
});
```

Listen for the matching response on `pi-background-tasks:response:v1`, deduplicate terminal frames by `task.id`, and treat the frame's metadata-backed status as terminal truth; do not poll status merely to reconfirm it.

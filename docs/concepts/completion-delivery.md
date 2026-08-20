---
doc_id: concepts/completion-delivery
audience: agent
mode: authored
review_policy: contract
stability: stable
covers_surfaces: [renderer:background-task-notification]
covers_sources: []
---
# Completion delivery

`bg_run` defaults to a durable terminal notification and one follow-up turn. Do not sleep or poll merely to wait. If delivery is deliberately disabled, use status/logs for point-in-time inspection without tight polling.

The notification is sent after terminal metadata and includes task id, name, status, output path, and error. EventBus terminal publication has its own response-order barrier but uses the same durable registry state.

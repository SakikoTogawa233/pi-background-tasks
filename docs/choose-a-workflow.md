---
doc_id: choose-a-workflow
audience: user
mode: authored
review_policy: contract
stability: stable
covers_surfaces: []
covers_sources: []
---
# Choose a lifecycle path

- Expected long command: `bg_run` or `/bg`.
- Ordinary foreground shell work: `bash`; hand off with `Ctrl+B` if it runs long.
- Deliberate inspection: `bg_status`, `bg_logs`, `/jobs`, or `/logs`.
- Stop: `bg_kill`, `/kill`, or dock controls.
- External plugin work: the owning plugin registers through EventBus v2; users still see one task registry and dock.

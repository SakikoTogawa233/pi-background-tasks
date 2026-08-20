# @sakiko233/pi-background-tasks — Maintainer Gateway

Read in this order before editing production code:

1. `docs/INDEX.md`
2. `docs/read-before-edit.md`
3. the owning authored document named there

## Package boundary

This package owns background shell process lifecycle and one domain-neutral external-task service. It exposes exactly `bash`, `bg_run`, `bg_status`, `bg_logs`, and `bg_kill`, plus the documented shell commands, footer dock, notifications, and foreground `Ctrl+B` handoff.

It does not own prompts, provider routing, child-model execution, workflow results, or provider attribution. External owners keep all domain semantics and communicate only through EventBus v2.

## Hard rules

- Preserve EventBus v1 shell compatibility.
- EventBus v2 frames are closed and sequence-checked; malformed or stale frames fail without mutation.
- Terminal publication follows durable terminal metadata and the correlated response barrier.
- External cancellation is owner-correlated and terminal state is not claimed before acknowledgement and settlement.
- Keep one registry, one task namespace, and one dock.
- Do not hand-edit generated regions, `docs/INDEX.md`, `docs/read-before-edit.md`, or `docs/manifest.json`.
- Run `npm run docs:generate` after source or authored-doc changes, then `npm run docs:verify`.

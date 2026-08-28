---
doc_id: subsystems/host-ui
audience: maintainer
mode: authored
review_policy: behavioral
stability: stable
covers_surfaces: []
covers_sources: [extensions/background-tasks.ts, src/core/update-check.ts, src/extension.ts, src/ui/background-tasks-manager.ts]
---
# Host UI

The single package entrypoint registers exactly five tools: `bash`, `bg_run`, `bg_status`, `bg_logs`, and `bg_kill`.

Commands are `/bg`, `/jobs`, `/logs`, `/kill`, `/tasks`, `/bg-tasks`, `/bg-clear`, and `/bg-update`. Shortcuts are `Ctrl+B`, `Shift+Down`, and optional `Ctrl+Alt+C`.

Shell and external tasks share one dedicated below-editor task row, one update-only native footer status, one overlay dock, one task namespace, one history, one log reader, one kill path, and one completion renderer. External tasks display only generic owner/capability facts. They cannot be rerun as shell commands from the dock.

The dedicated row uses Pi's public `setWidget` API with `placement: "belowEditor"` at every terminal width. It renders the unchanged light-blue background label whenever the shared registry has running tasks or unseen successful completions, and the keyed native `background-tasks` status is cleared while that row is visible. Failed and stopped tasks do not keep the row visible or add task counts. When no row-worthy task information remains, the widget clears immediately; an available package update remains as the unchanged update-only native footer status.

Shutdown closes launch admission and v1 intake, routes cancellation to running external owners, accepts their acknowledgement/settlement frames, drains finalization/publication, and closes the service.

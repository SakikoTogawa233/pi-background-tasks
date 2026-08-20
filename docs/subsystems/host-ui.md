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

Shell and external tasks share one footer status, one overlay dock, one task namespace, one history, one log reader, one kill path, and one completion renderer. External tasks display only generic owner/capability facts. They cannot be rerun as shell commands from the dock.

Shutdown closes launch admission and v1 intake, routes cancellation to running external owners, accepts their acknowledgement/settlement frames, drains finalization/publication, and closes the service.

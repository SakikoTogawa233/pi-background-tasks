---
doc_id: subsystems/background-task-runtime
audience: maintainer
mode: authored
review_policy: behavioral
stability: stable
covers_surfaces: [tool:bash]
covers_sources: [src/core/common.ts, src/core/foreground-bash.ts, src/core/registry.ts, src/core/windows-taskkill.ts]
---
# Background task runtime

The registry owns task ids, status, output paths, bounded output, terminal metadata, process termination, notification ordering, and one shared dock.

Statuses are `running`, `completed`, `failed`, and `killed`. Terminal states are published only after the output stream closes and metadata is written. One finalization promise and one terminal-publication promise prevent duplicate delivery.

Foreground Bash uses a two-second fast path, `Ctrl+B` manual handoff, and a 120-second total-runtime TUI handoff threshold unless the public Bash timeout overrides it. Adoption transfers the already-running child and continuous output file to the registry; it never restarts the command.

Direct shell tasks use platform shell policy, output caps, timeouts, process-group/tree termination, bounded logs, launch admission, shutdown cleanup, and retention pruning.

Externally managed tasks use the same ids, metadata, output, status, logs, kill, notification, and UI surfaces. The external owner receives cancellation and alone commits terminal settlement. The registry never invents an external terminal state before that contract completes.

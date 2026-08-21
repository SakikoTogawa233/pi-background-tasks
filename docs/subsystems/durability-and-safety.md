---
doc_id: subsystems/durability-and-safety
audience: maintainer
mode: authored
review_policy: behavioral
stability: stable
covers_surfaces: []
covers_sources: [src/core/durable-fs.ts]
---
# Durability and safety

Metadata replacement uses an exclusive temporary file, file sync, close, rename, and POSIX directory sync. Failures retain operation/path/cleanup evidence and fail loudly. Windows rename contention uses bounded retries of the same atomic operation, not an alternate write path.

Ordinary output is a streaming file. Finalization waits for stream finish/close before terminal metadata. Metadata is the durable terminal truth used by status, notifications, and EventBus publication.

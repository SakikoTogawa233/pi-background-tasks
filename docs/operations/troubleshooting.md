---
doc_id: operations/troubleshooting
audience: maintainer
mode: authored
review_policy: contract
stability: stable
covers_surfaces: []
covers_sources: []
---
# Troubleshooting

- Unknown or ambiguous task id: use `/jobs` or `bg_status` and retry with the exact id.
- Missing output: inspect the metadata path and registry errors; no alternate output location is invented.
- External frame rejected: verify service id, owner id/token, task id, closed keys, and exact next sequence.
- External cancellation hangs: the owner must acknowledge the correlated cancellation id and settle the task.
- Shutdown failure: inspect the exact task cleanup error; the service does not claim completion for unresolved external work.

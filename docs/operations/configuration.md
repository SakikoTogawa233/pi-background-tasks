---
doc_id: operations/configuration
audience: maintainer
mode: authored
review_policy: contract
stability: stable
covers_surfaces: []
covers_sources: []
---
# Configuration

`PI_BG_MAX_OUTPUT_BYTES` controls the task output cap. `PI_BG_SHELL` and `PI_BG_SHELL_PATH` select the Windows shell policy. `PI_BG_DISABLE_UPDATE_CHECK`, `PI_BG_REGISTRY_URL`, and `PI_OFFLINE` control the one-shot update check.

Missing or invalid shell configuration fails before task creation.

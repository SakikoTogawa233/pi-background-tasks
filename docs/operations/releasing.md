---
doc_id: operations/releasing
audience: maintainer
mode: authored
review_policy: contract
stability: stable
covers_surfaces: []
covers_sources: []
---
# Releasing operations

Follow `PUBLISHING.md`. Derive name and version from `package.json`. Inspect `npm pack --dry-run --json --ignore-scripts` as payload truth. Publish only through the GitHub Actions trusted-publisher workflow after acceptance and coordinated versioning.

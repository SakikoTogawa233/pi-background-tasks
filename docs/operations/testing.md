---
doc_id: operations/testing
audience: maintainer
mode: authored
review_policy: contract
stability: stable
covers_surfaces: []
covers_sources: []
---
# Testing operations

`TESTING.md` defines the gate lanes and isolation. `TEST_PLAN.md` maps the accepted behavior.

Default: `npm run test`. Full interactive: `npm run test:full`. Release adds cache prime, smoke, docs, payload, pack, pnpm, and compatibility. Windows integration is `npm run test:windows` on Windows.

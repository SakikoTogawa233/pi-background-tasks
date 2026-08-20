---
doc_id: subsystems/docs-freshness-gate
audience: maintainer
mode: mixed
review_policy: contract
stability: stable
covers_surfaces: []
covers_sources: []
---
# Docs freshness gate

The docs engine extracts package metadata, public registrations, EventBus facts, runtime paths, schemas, environment references, and source ownership. Unsupported registration syntax fails instead of falling back to stale text.

<!-- pi-docs:begin name="docs-freshness-gate" generator="scripts/docs/generate.mjs" -->
- Canonical package version: `2.6.0`
- Governed markdown docs: 27
- Public surfaces extracted: 19
- Governed production sources: 10
- Tool contracts extracted: 5
- Schema IDs extracted: 7
- Environment variable references extracted: 18
- Behavioral attestation receipts not passing: 4
- Receipt store: `docs/attestations.json`

`npm run docs:verify` is read-only: it renders generated files twice in memory and compares them with committed bytes. `npm run docs:generate` is the only docs writer.
<!-- pi-docs:end name="docs-freshness-gate" -->

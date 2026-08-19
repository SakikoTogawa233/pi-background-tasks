---
doc_id: operations/testing
audience: maintainer
mode: authored
review_policy: contract
stability: evolving
covers_surfaces: []
covers_sources: []
---
# Testing operations

Package entry docs: `TESTING.md` and `TEST_PLAN.md`. This page explains how to choose gates without losing the detailed coverage matrix.

## Isolation defaults

Automated package tests should use isolated temp project/agent/session directories and these defaults unless a test intentionally overrides them:

```bash
PI_OFFLINE=1
PI_SKIP_VERSION_CHECK=1
PI_TELEMETRY=0
CI=1
```

Never point tests at the user's real `~/.pi/agent`.

## Current package scripts

From current `package.json`:

| Lane | Script | Meaning |
|---|---|---|
| Typecheck | `npm run typecheck` | `tsc --noEmit`. |
| Type safety package tests | `npm run test:type-safety` | Package/type-safety tests. |
| Unit | `npm run test:unit` | Pure/unit coverage, including durable fs, budgets, projection, Fusion/delegate core. |
| SDK | `npm run test:sdk` | Real package entrypoint through SDK-style harnesses. |
| RPC | `npm run test:rpc` | RPC command/tool surface. |
| Component | `npm run test:component` | TUI component rendering/key behavior. |
| Package | `npm run test:package` | Manifest/payload/mutation/package guards. |
| Hook contract | `npm run test:hook-contract` | Real Pi hook characterization evidence comparison. |
| Default | `npm run test` | Typecheck + type-safety + unit + SDK + RPC + component + package + hook-contract. |
| Expect PTY | `npm run test:pty` | Real expect/TUI scenarios with the existing host-capability skip; full gate only. |
| tmux TUI | `npm run test:tmux` | Non-skipping real Pi TUI foreground-bash scenarios through isolated 80x24 `/usr/bin/tmux` sessions; full gate only. |
| Windows | `npm run test:windows` | Windows-only shell/process-tree integration, including adopted-task `taskkill`; run on Windows CI/hosts. |
| Agent loop | `npm run test:agent-loop` | Scripted-provider real agent-loop behavior; full gate only. |
| Full | `npm run test:full` | Default + Expect PTY + tmux TUI + agent-loop. |
| Smoke | `npm run smoke` | Isolated load-only `/jobs`. |
| Large context smoke | `npm run smoke:large-context` | Offline Fusion context/budget reproduction; no inference/child spawn. |
| Compatibility | `npm run test:compat` | Release-only exact Pi version install/compat plus current-host witness. |
| Pack | `npm run pack:dry-run` | Release payload preview. |
| Docs generate | `npm run docs:generate` | Regenerates generated docs regions/index/manifest. |
| Docs verify | `npm run docs:verify` | Offline, read-only deterministic docs freshness verification; renders generated files twice in memory and reports semantic receipt freshness without requiring it. |
| Strict docs attestation verify | `npm run docs:verify:attestations` | Optional strict mode that additionally requires every behavioral receipt to match current prose and sources. |
| Docs attestation | `npm run docs:attest/record -- <doc_id> --reviewer <identity-after-semantic-review> --verdict PASS --notes <review-notes>` | Computes hashes and records an explicit semantic PASS receipt after review; `npm run docs:attest` is an alias and still needs args. |
| Docs unit/package gate | `npm run test:docs` | Docs-gate unit/package tests. |
| Payload check | `npm run payload:check` | Package payload policy check. |
| Release version check | `npm run release:check-version -- --ref-type tag --ref-name "v$VERSION"` | Tag version sanity; automation passes a strict explicit ref, while no-argument invocation reads the real GitHub tag-ref environment. Never publishes. |

Do not run full/default/root suites for documentation-only edits unless the operator explicitly asks. If the operator restricts verification to focused checks, report that `docs:verify`/attestation were not run.

## Evidence that must be preserved

`TESTING.md` and `TEST_PLAN.md` intentionally carry exhaustive QA knowledge. Do not replace them with generic summaries.

Preserve especially:

- Pi hook contract evidence and byte-identical shipped copy behavior;
- Fusion golden-byte and independent oracle coverage;
- delegate seed/budget/artifact/result/guard/mutation coverage;
- scripted-provider no-poll/no-sleep follow-up behavior;
- foreground bash's unit/component/SDK/Expect PTY/non-skipping tmux/scripted-provider layers and Windows adopted-tree termination coverage;
- Expect PTY keyboard-protocol negotiation notes and the separate direct-tmux gate (`extended-keys on`, no tmux-3.5-only `extended-keys-format csi-u`);
- compatibility TypeBox peer/payload checks;
- live subscription evidence caveat: it is release-time, real inference, and subscription OAuth only.

## Focused docs checks

When a change is constrained to focused docs checks, use targeted checks such as:

```bash
python3 - <<'PY'
from pathlib import Path
for p in [*Path('docs').rglob('*.md'), Path('TESTING.md'), Path('TEST_PLAN.md'), Path('PUBLISHING.md')]:
    if p.exists(): print(p)
PY
```

Recommended focused checks for docs changes:

1. frontmatter schema on `docs/**/*.md`;
2. package-local markdown links resolve;
3. no standalone links to removed parent `../EXTENSION_*` standards;
4. docs workflow wording matches current `package.json` scripts;
5. version/tag references derive from `package.json` or observed git tags.

These checks are not substitutes for code gates when source behavior changes.

## Gate selection

- **Doc-only navigation/release wording:** focused link/frontmatter/version checks.
- **EventBus docs vs API changes:** EventBus unit/SDK targeted tests if code changed; otherwise focused docs checks.
- **Context projection/budget changes:** unit tests for projection/budget/golden/oracle; do not update goldens casually.
- **Durability/launch changes:** durable-fs, pi-launch, Windows argv targeted units.
- **Foreground bash/adoption changes:** `tests/unit/foreground-bash.test.ts`, `tests/unit/registry-adopt.test.ts`, adopted-task component tests, foreground SDK tests, preserved foreground Expect PTY tests, the required `npm run test:tmux` real-TUI gate, scripted-provider follow-up, and `npm run test:windows` on Windows. Preserve total-runtime timing, ownership transfer, continuous output, notification, shutdown, and process-tree assertions across layers.
- **Delegate guard changes:** hook contract, delegate unit/SDK/scripted-provider targeted gates.
- **Release candidate:** ordinary release checks in `docs/operations/releasing.md`; live subscription evidence only when explicitly certifying release behavior.

---
doc_id: operations/releasing
audience: maintainer
mode: authored
review_policy: contract
stability: evolving
covers_surfaces: []
covers_sources: []
---
# Releasing operations

Package maintenance entrypoint: `PUBLISHING.md`. Source version is always `package.json`; never hard-code a release version in commands.

```bash
NAME=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")
printf '%s@%s\n' "$NAME" "$VERSION"
```

The current Sakiko fork release is `@sakiko233/pi-background-tasks@2.5.0`. The release workflow creates `v$VERSION`; do not certify a pinned git install until that tag exists in the Sakiko repository.

## Ordinary release checks

Run from the `@sakiko233/pi-background-tasks` package root in an isolated environment. These are release-candidate checks, not tag certification:

```bash
npm run typecheck
npm run test:type-safety
npm run test:unit
npm run test:sdk
npm run test:rpc
npm run test:component
npm run test:package
npm run test:hook-contract
npm run smoke
npm run smoke:large-context
npm run pack:dry-run
# With pnpm 11.18.0 on PATH:
npm run test:pnpm-pack
npm run docs:verify
npm run payload:check
# On a tag ref only: GITHUB_REF_TYPE=tag GITHUB_REF_NAME=v$VERSION npm run release:check-version
npm run test:compat
npm view @sakiko233/pi-background-tasks name version --json
```

`npm run test:full` additionally runs the preserved Expect PTY lane, the non-skipping `/usr/bin/tmux` real-Pi TUI lane, and scripted-provider agent-loop gates. Treat it as a full interactive gate; do not run it for routine docs edits.

Live evidence (`npx tsx scripts/delegate-live-run.ts`) is release-time and performs real subscription-OAuth inference. It must never use API-key/metered frontier channels.

## Payload verification

Use `npm pack --dry-run --json` output as the payload source of truth. Verify at minimum:

- `extensions/anthropic-attribution.ts` and `extensions/background-tasks.ts` are included as the ordered Pi entrypoints;
- runtime `src/` files needed by both entrypoints are included;
- `docs/`, `README.md`, `TESTING.md`, `TEST_PLAN.md`, `PUBLISHING.md`, `BACKGROUND-TASKS-INSTRUCTIONS.md`, `THIRD_PARTY_NOTICES.md`, root `logo.png`, and `LICENSE` are included per current `package.json.files`;
- tests, scripts, node_modules, local `.pi/` artifacts, generated evidence not meant for runtime, and nested tarballs are excluded;
- TypeBox remains a Pi-provided peer and no private/nested runtime TypeBox copy is bundled;
- production dependencies use registry versions only; no exotic URL/git/file subdependency is shipped;
- docs/assets/gateway/logo inclusion matches `package.json.files` exactly.

## Tag certification vs npm publishing

Separate these activities:

1. **npm release candidate:** version comes from `package.json`; run ordinary release checks and inspect the pack payload. The one-time new-package bootstrap for `2.5.0` is documented in `PUBLISHING.md`.
2. **git tag certification:** verify the Sakiko repo is at the exact release commit and clean. `npm run release:check-version` requires an explicit tag ref (`GITHUB_REF_TYPE=tag`, `GITHUB_REF_NAME=v$VERSION`) and never publishes.
3. **post-publish install smoke:** install by `npm:@sakiko233/pi-background-tasks@$VERSION` in an isolated Pi agent dir. Use git install smoke only after the corresponding Sakiko tag exists.

After the initial npm bootstrap and package-specific Trusted Publisher setup, `.github/workflows/release.yml` publishes unpublished versions through npm OIDC and creates the matching GitHub Release. It stores no npm token.

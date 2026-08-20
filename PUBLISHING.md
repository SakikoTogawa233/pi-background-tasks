# Publishing @sakiko233/pi-background-tasks

Release checklist for the Sakiko fork's npm and GitHub releases. The current release is `2.6.0`.

The release version is always read from `package.json`:

```bash
# From the @sakiko233/pi-background-tasks package root:
NAME=$(node -p "require('./package.json').name")
VERSION=$(node -p "require('./package.json').version")
printf '%s@%s\n' "$NAME" "$VERSION"
```

The release workflow creates `v$VERSION` after the npm release gates pass. Do not advertise a pinned git install until that GitHub release/tag exists.

## Preconditions

- npm account with publish rights for the `@sakiko233` scope and `@sakiko233/pi-background-tasks`.
- GitHub repository: `github.com/SakikoTogawa233/pi-background-tasks`.
- Clean worktree and final release commit on `main`.
- Frontier model evidence, if any, uses Pi subscription/OAuth channels only; never metered APIs.

## npm authentication

npm publication authenticates through Trusted Publisher: npmjs.com trusts repository `SakikoTogawa233/pi-background-tasks` with workflow filename `release.yml` and no GitHub environment. `.github/workflows/release.yml` declares `id-token: write` and `actions/setup-node` writes the registry configuration; `npm publish` then exchanges the GitHub Actions OIDC token for registry credentials, so no `NPM_TOKEN` repository secret, `NODE_AUTH_TOKEN` mapping, or locally stored npm token exists or is needed. Local `npm publish` cannot authenticate; releases publish only through the workflow. The `--provenance` option still generates the provenance attestation from the same OIDC identity. If publication fails with 403, verify the npm Trusted Publisher entry still matches repository, workflow filename, and absence of environment.

## Ordinary release checks

```bash
npm run typecheck
npm run test:type-safety
npm run test:unit
npm run test:sdk
npm run test:rpc
npm run test:component
npm run test:package
npm run test:hook-contract
npm run cache:prime-packed-install
npm run smoke
npm run smoke:large-context
npm run docs:verify
npm run payload:check
# Explicit ref for release automation, including branch-push workflows:
npm run release:check-version -- --ref-type tag --ref-name "v$VERSION"
npm run pack:dry-run
# With pnpm 11.18.0 on PATH:
npm run test:pnpm-pack
npm run test:compat
npm view @sakiko233/pi-background-tasks name version --json
```

Run `npm run cache:prime-packed-install` online before the default test gate. It reads the sole production dependency and its transitive closure from `package-lock.json` and caches their exact locked versions so the package suite's tarball install remains genuinely offline on a clean runner.

`npm run test:full` is the full interactive gate (default gate plus PTY and agent-loop). Run it when certifying full TUI/agent-loop behavior, not for docs-only maintenance.

## Payload verification

Use `npm pack --dry-run --json --ignore-scripts` output as the payload source of truth for payload inspection. Verify that `extensions/`, `src/`, `docs/`, `README.md`, `TESTING.md`, `TEST_PLAN.md`, `PUBLISHING.md`, `BACKGROUND-TASKS-INSTRUCTIONS.md`, root `logo.png`, and `LICENSE` match current `package.json.files`, and that tests/scripts/local `.pi` artifacts/node_modules/nested tarballs are excluded.

## Publish to npm

The release workflow publishes unpublished versions, including the initial `2.5.0` bootstrap, with:

```bash
npm publish --provenance --access public
```

`actions/setup-node` writes npm's registry configuration, and the publish step relies on Trusted Publisher OIDC: the workflow's `id-token: write` permission lets `npm publish` exchange the GitHub Actions OIDC token for registry credentials, and `--provenance` attests the same identity. Keep the `id-token: write` permission and the npm Trusted Publisher entry (repository, workflow filename, no environment) consistent when maintaining the workflow.

Post-publish smoke with isolated Pi state:

```bash
PI_CODING_AGENT_DIR=$(mktemp -d) pi -e npm:@sakiko233/pi-background-tasks@$VERSION --offline --no-tools --no-session -p "/jobs"
pi install npm:@sakiko233/pi-background-tasks@$VERSION
```

## Standalone git tag certification

Pi git package installs treat the repository root as the package root. Do not point Pi at the `ai-pipeline` monorepo root for this package.

Before any git install instructions are published, verify in the standalone repo that tag `v$VERSION` exists and points at the release commit. Release automation passes the ref explicitly with `npm run release:check-version -- --ref-type tag --ref-name "v$VERSION"`. With no CLI arguments, the check reads `GITHUB_REF_TYPE` and `GITHUB_REF_NAME`, as it does on a real GitHub tag ref. The check never publishes. If the tag does not exist, the git channel is not certified for this release.

Git install smoke only after the tag exists:

```bash
PI_CODING_AGENT_DIR=$(mktemp -d) pi -e git:github.com/SakikoTogawa233/pi-background-tasks@v$VERSION --offline --no-tools --no-session -p "/jobs"
pi install git:github.com/SakikoTogawa233/pi-background-tasks@v$VERSION
```

## pi.dev/packages

The package includes the `pi-package` keyword and a `pi.extensions` manifest. After npm publish, it should be discoverable by pi.dev package indexing. If it does not appear automatically, refresh according to the package-gallery process.

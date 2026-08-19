# Publishing @sakiko233/pi-background-tasks

Release checklist for the Sakiko fork's npm and GitHub releases. The current release is `2.5.0`.

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

## Initial npm publication and Trusted Publisher bootstrap

`@sakiko233/pi-background-tasks` is a brand-new npm package. npm cannot configure a package-specific Trusted Publisher until the package exists, so an authorized npm owner must perform the initial authenticated publication of `2.5.0` outside GitHub Actions. Do not add an `NPM_TOKEN` or any placeholder secret to this repository.

After that initial publication, configure npm Trusted Publisher for GitHub Actions with repository `SakikoTogawa233/pi-background-tasks` and workflow filename `release.yml`, then run the workflow manually. The workflow uses OIDC with provenance and public access; it detects that npm already has `2.5.0` and can still create the missing `v2.5.0` GitHub Release. Future versions can be published entirely by the trusted-publisher workflow.

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
npm run smoke
npm run smoke:large-context
npm run docs:verify
npm run payload:check
# On a tag ref only: GITHUB_REF_TYPE=tag GITHUB_REF_NAME=v$VERSION npm run release:check-version
npm run pack:dry-run
# With pnpm 11.18.0 on PATH:
npm run test:pnpm-pack
npm run test:compat
npm view @sakiko233/pi-background-tasks name version --json
```

`npm run test:full` is the full interactive gate (default gate plus PTY and agent-loop). Run it when certifying full TUI/agent-loop behavior, not for docs-only maintenance.

## Payload verification

Use `npm pack --dry-run --json --ignore-scripts` output as the payload source of truth for payload inspection. Verify that `extensions/`, `src/`, `docs/`, `README.md`, `TESTING.md`, `TEST_PLAN.md`, `PUBLISHING.md`, `BACKGROUND-TASKS-INSTRUCTIONS.md`, root `logo.png`, and `LICENSE` match current `package.json.files`, and that tests/scripts/local `.pi` artifacts/node_modules/nested tarballs are excluded.

## Publish to npm

For `2.5.0`, the authorized npm owner performs the one-time bootstrap described above:

```bash
npm login
npm publish --access public
```

After Trusted Publisher is configured, `.github/workflows/release.yml` publishes later versions with `npm publish --provenance --access public`; no npm secret is stored in GitHub.

Post-publish smoke with isolated Pi state:

```bash
PI_CODING_AGENT_DIR=$(mktemp -d) pi -e npm:@sakiko233/pi-background-tasks@$VERSION --offline --no-tools --no-session -p "/jobs"
pi install npm:@sakiko233/pi-background-tasks@$VERSION
```

## Standalone git tag certification

Pi git package installs treat the repository root as the package root. Do not point Pi at the `ai-pipeline` monorepo root for this package.

Before any git install instructions are published, verify in the standalone repo that tag `v$VERSION` exists and points at the release commit. `npm run release:check-version` requires an explicit tag ref (`GITHUB_REF_TYPE=tag`, `GITHUB_REF_NAME=v$VERSION`) and never publishes. If the tag does not exist, the git channel is not certified for this release.

Git install smoke only after the tag exists:

```bash
PI_CODING_AGENT_DIR=$(mktemp -d) pi -e git:github.com/SakikoTogawa233/pi-background-tasks@v$VERSION --offline --no-tools --no-session -p "/jobs"
pi install git:github.com/SakikoTogawa233/pi-background-tasks@v$VERSION
```

## pi.dev/packages

The package includes the `pi-package` keyword and a `pi.extensions` manifest. After npm publish, it should be discoverable by pi.dev package indexing. If it does not appear automatically, refresh according to the package-gallery process.

# Publishing pi-background-tasks

Release checklist for npm publishing and standalone git publishing. The current release candidate is 0.9.0, which adds the `fusion_validate` validation workflow and Anthropic child sanitization; 0.7.0 introduced the Fusion public surfaces (`/fusion`, `/fusion-models`, `fusion_brainstorm`) in addition to the background-task surfaces. Do not advertise the GitHub install target until the standalone repository has the exact release commit and tag.

## Preconditions

- npm account with publish rights for `pi-background-tasks`.
- Standalone GitHub repository, expected: `github.com/ismailsaleekh/pi-background-tasks`.
- Clean worktree.
- Final repair commit present in the standalone package repository; do not push from automated repair runs unless the operator explicitly requests it.

## Verify

```bash
cd packages/pi-background-tasks
npm run test
npm run test:full
npm run smoke
npm run smoke:large-context
npm run pack:dry-run
npm run test:compat
npm view pi-background-tasks name version --json
```

`npm run test:compat` covers exact Pi `0.75.5`, `0.81.1`, `0.82.1`, and `0.83.0`. For each version it verifies the resolved `typebox` is Pi's bundled peer (not a private or nested copy) and scans the installed package bytes for TypeBox APIs removed in the 1.3.x line.

`pi-background-tasks` is already published; bump `package.json` before each npm publish.

## Publish to npm

```bash
cd packages/pi-background-tasks
npm login
npm publish --access public
```

Pi install smoke after publish:

```bash
PI_CODING_AGENT_DIR=$(mktemp -d) pi -e npm:pi-background-tasks@0.9.0 --offline --no-tools --no-session -p "/jobs"
pi install npm:pi-background-tasks@0.9.0
```

## Publish to git

Because Pi git package installs treat the repository root as the package root, do not point Pi at the `ai-pipeline` monorepo root for this package. Push the contents of `packages/pi-background-tasks/` to a standalone repository.

```bash
cd packages/pi-background-tasks
git status --short --branch
git log --oneline -3
git remote -v
git push origin main
git tag v0.9.0
git push origin v0.9.0
```

Pi install smoke after git tag, using an isolated Pi agent directory so no local checkout or user `~/.pi` state is involved:

```bash
PI_CODING_AGENT_DIR=$(mktemp -d) pi -e git:github.com/ismailsaleekh/pi-background-tasks@v0.9.0 --offline --no-tools --no-session -p "/jobs"
pi install git:github.com/ismailsaleekh/pi-background-tasks@v0.9.0
```

## pi.dev/packages

The package includes the `pi-package` keyword and a `pi.extensions` manifest. After npm publish, it should be discoverable by pi.dev package indexing. If it does not appear automatically, submit/refresh the package according to the pi.dev package-gallery process.

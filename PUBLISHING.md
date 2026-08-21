# Publishing @sakiko233/pi-background-tasks

The current package version is read from `package.json`. This implementation task does not bump it or publish.

## Ordinary release checks

```bash
npm run typecheck
npm run test:type-safety
npm run test:unit
npm run test:sdk
npm run test:rpc
npm run test:component
npm run test:package
npm run cache:prime-packed-install
npm run smoke
npm run docs:verify
npm run payload:check
npm run release:check-version -- --ref-type tag --ref-name "v$VERSION"
npm run pack:dry-run
npm run test:pnpm-pack
npm run test:compat
npm view @sakiko233/pi-background-tasks name version --json
```

Run `npm run test:full` for the full PTY/tmux/scripted-provider certification. Run `npm run test:windows` on Windows.

## Payload

The package contains one Pi entrypoint, `extensions/background-tasks.ts`, plus runtime `src/`, docs, maintainer guides, license/notices, and logo. Tests, scripts, local state, nested archives, and `node_modules` are excluded. Production dependencies are empty; Pi-provided host packages remain peers.

## Release path

Publishing occurs only in GitHub Actions through npm Trusted Publisher OIDC. Never run local `npm publish`. Acceptance and coordinated versioning happen before push, PR, merge, publication, tag, or release verification.

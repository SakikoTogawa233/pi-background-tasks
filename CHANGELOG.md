# Changelog

All notable changes to the Sakiko fork of pi-background-tasks are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.5.2] - 2026-08-19

### Changed

- Split the durable terminal transition from phase-B finalization so callers can synchronize on the lifecycle boundary they actually require.
- Added a launch-admission barrier: shutdown closes admission synchronously, drains launches that already acquired ownership, then settles registered tasks.
- Drained in-flight EventBus requests and terminal publications during shutdown, preserving response, terminal-event, and service-close ordering.
- Made extension service installation reload-safe while retaining one registry owner across a reload.
- Made the first accepted stop intent authoritative. Concurrent callers share one in-flight stop, while a later physical termination attempt can retry after a timeout or failed Windows `taskkill` using fresh platform state.
- Required RPC clients to synchronize explicitly with terminal state rather than inferring it from earlier process activity.

### Fixed

- Post-spawn metadata failures now terminate and settle ordinary, delegate, and attested children without replacing the original startup error with cleanup failures.
- Prevented shutdown from missing launches that had acquired ownership but had not completed registration or spawning.
- Prevented completed tasks from being pruned before finalization and terminal publication are both settled.
- Prevented reloads from leaving EventBus service handlers uninstalled or attached to stale lifecycle state.

### Tests

- Expanded lifecycle coverage for terminal versus finalization waits, launch/shutdown races, EventBus request and publication draining, reloads, shared stop calls, stop retry behavior, metadata-failure cleanup, publication-safe pruning, and terminal RPC synchronization.
- Made fake-registry platform behavior explicit so POSIX and Windows routing contracts are deterministic.

## [2.5.1] - 2026-08-19

### Changed

- Made `stopTask` await complete process finalization, including durable terminal metadata, before resolving.
- Canonicalized macOS `/var` identities and made installed-package cleanup portable on Windows.
- Made cross-platform CI and release execution deterministic, including exact release-ref validation, offline packed-install cache priming, and repository-secret npm publication with provenance.
- Added explicit Sakiko fork attribution to the repository documentation.

### Fixed

- Added installed-package regression coverage proving delegate hook-contract evidence remains packaged, byte-identical, and fail-closed when loaded from the installed extension.
- Normalized ambient delegate extension paths and platform-specific SDK, adopted-task stop, npm shim, path, and cleanup behavior on Windows.

## [2.5.0] - 2026-08-19

### Added

- Added foreground Bash backgrounding: press Ctrl+B to move a running foreground command into the background-task registry.
- Added automatic backgrounding after 120 seconds of total foreground runtime.
- Added registry adoption of the already-running foreground process, transferring lifecycle, output, stop, UI, and completion ownership without relaunching it.
- Added layered foreground-backgrounding coverage across unit, SDK, PTY, scripted-provider, production process, and real tmux TUI tests.
- Established the Sakiko fork's package identity, attribution, publication documentation, cross-platform CI, and automated npm/GitHub release workflow.

### Changed

- Exposed foreground Bash registration through the extension API and documented the Ctrl+B and timeout behavior in user and generated documentation.

[Unreleased]: https://github.com/SakikoTogawa233/pi-background-tasks/compare/v2.5.2...HEAD
[2.5.2]: https://github.com/SakikoTogawa233/pi-background-tasks/compare/v2.5.1...v2.5.2
[2.5.1]: https://github.com/SakikoTogawa233/pi-background-tasks/compare/v2.5.0...v2.5.1
[2.5.0]: https://github.com/SakikoTogawa233/pi-background-tasks/releases/tag/v2.5.0

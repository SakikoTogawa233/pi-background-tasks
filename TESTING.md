# @sakiko233/pi-background-tasks Testing

Use isolated project, agent, and session directories with:

```bash
PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 CI=1
```

## Default gate

```bash
npm run test
```

Runs typecheck, type-safety, unit, SDK, RPC, component, and package lanes.

## Full interactive gate

```bash
npm run test:full
```

Adds Expect PTY, non-skipping tmux TUI, and deterministic scripted-provider lanes.

## Release checks

```bash
npm run cache:prime-packed-install
npm run smoke
npm run docs:verify
npm run payload:check
npm run pack:dry-run
npm run test:pnpm-pack
npm run test:compat
```

Windows process-tree integration remains a separate platform gate:

```bash
npm run test:windows
```

## Required coverage

- foreground Bash fast path, `Ctrl+B`, timed handoff, ownership transfer, and shutdown;
- registry spawn, logs, timeout, output cap, kill, finalization, notification, pruning, and platform tree termination;
- EventBus v1 capabilities/run/status/logs/kill/terminal response ordering;
- EventBus v2 unique service claim, handshake/register/update/log/cancel/ack/settle/status/logs/kill/terminal ordering, malformed-frame rejection, and shutdown settlement;
- exact five-tool runtime surface and lifecycle-only packed payload;
- one registry/dock for shell and external tasks;
- SDK, RPC, component, PTY, tmux, scripted-provider, package, docs, compatibility, pnpm, and Windows-relevant lanes.

# @sakiko233/pi-background-tasks Test Plan

## Public contract

| Area | Contract |
|---|---|
| Tools | Exactly `bash`, `bg_run`, `bg_status`, `bg_logs`, `bg_kill` |
| Commands | `/bg`, `/jobs`, `/logs`, `/kill`, `/tasks`, `/bg-tasks`, `/bg-clear`, `/bg-update` |
| UI | One footer status and one focused dock |
| Runtime | `.pi/tasks/<session-id>-<pid>/` output and metadata |
| EventBus v1 | Closed shell capabilities/run/status/logs/kill/terminal frames |
| EventBus v2 | Closed external-task handshake/register/update/log/cancel/ack/settle/status/logs/kill/terminal frames |

## Acceptance matrix

- Exact runtime tools and commands: package/SDK.
- Foreground handoff and adopted process ownership: unit, SDK, PTY, tmux, scripted provider, Windows routing.
- Direct shell task lifecycle: unit, SDK, RPC, package smoke, compatibility.
- Bounded logs and output caps: unit, SDK, RPC.
- Completion notification and response-before-terminal ordering: unit, SDK, scripted provider.
- EventBus v1 compatibility: unit and SDK.
- EventBus v2 owner handshake, unique service, one registry, sequence enforcement, generic snapshots, cancellation acknowledgement, settlement, terminal ordering, and shutdown: unit.
- Malformed, duplicate, stale, unknown-owner, out-of-order, and domain-bearing v2 frames create no partial task mutation: unit.
- Lifecycle-only manifest, docs, source, and packed bytes: package, payload, docs, pack, pnpm, compatibility.
- Windows process-tree termination: mocked unit and Windows integration.

## Mandatory gates

`npm run test`, `npm run test:full`, `npm run cache:prime-packed-install`, `npm run smoke`, `npm run docs:verify`, `npm run payload:check`, `npm run pack:dry-run`, `npm run test:pnpm-pack`, and `npm run test:compat`. Run `npm run test:windows` on Windows.

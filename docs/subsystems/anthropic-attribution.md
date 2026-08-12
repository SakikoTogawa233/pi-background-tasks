---
doc_id: subsystems/anthropic-attribution
audience: maintainer
mode: authored
review_policy: behavioral
stability: evolving
covers_surfaces: []
covers_sources: [extensions/anthropic-attribution.ts, src/core/anthropic-attribution-path.ts, src/core/anthropic-attribution.ts]
---
# Anthropic attribution subsystem

This subsystem owns the package-wide Anthropic subscription attribution provider, exact-match system-prompt sanitization, cache-retention command, and the package extension path shared by isolated child Pi processes.

## Global package behavior

`package.json.pi.extensions` loads `extensions/anthropic-attribution.ts` for every normal `pi-background-tasks` installation, before the background-task entrypoint. The extension is provider-gated: non-Anthropic sessions and payloads are unchanged.

For Anthropic sessions it registers the package-owned `anthropic` provider transport and applies the Claude Code subscription request contract:

- subscription OAuth token transport only; metered Anthropic credentials are refused;
- Claude Code session, account, device, beta, user-agent, and system-identity attribution;
- model-specific fixed/adaptive thinking policy;
- the conservative 200K subscription context policy;
- system, final-tool, and final-conversation cache surfaces;
- provider-authoritative usage and one-hour cache-write accounting when reported.

The extension reads `userID` and `oauthAccount.accountUuid` from `~/.claude.json` without writing it. Missing/malformed account data, unsupported model policy, malformed payload/cache controls, and non-OAuth transport fail loudly.

## Sanitization

The package has no runtime dependency on `@ravshansbox/pi-anthropic-sps`. Its three reviewed exact-match prompt-line rules are implemented locally in `src/core/anthropic-attribution.ts`, with the upstream MIT notice retained in `THIRD_PARTY_NOTICES.md`.

Only complete matching lines are removed. Other system text, non-text blocks, custom block fields, and valid cache controls are preserved. The rules cover both Pi documentation-list variants—with and without `environment-variables.md`—plus the cross-reference instruction line.

## Duplicate-owner protocol

A package extension and an independent project/user copy can otherwise register duplicate provider hooks and `/claude-cache` commands. The factory therefore probes `pi-anthropic-attribution:claim:v1` on Pi's shared EventBus before registration. The first successfully registered copy installs one responder; later compatible copies become inert.

Ownership is published only after all hooks and the command register. Extension loading is sequential and EventBus listener invocation is synchronous at the probe boundary, so a failed first factory cannot strand a false claim. The responder lives for the shared EventBus runtime, matching the extension registrations it protects.

## Isolated package children

Ambient discovery is insufficient for child paths that use `--no-extensions`. `resolveAnthropicAttributionExtensionPath()` is the single package path seam used by:

- Fusion Anthropic children, before the Fusion runtime governor;
- Anthropic delegate children, before the delegate guard;
- Anthropic attested Pi children.

Non-Anthropic child argv does not resolve or add this extension. Missing package extension bytes fail before child creation; no route substitution or sanitizer fallback is attempted.

Arbitrary shell commands started through `bg_run` are not rewritten. An Anthropic child `pi` launched this way must keep normal extension discovery enabled. If the command deliberately uses `--no-extensions`, it must also explicitly load this package's `extensions/anthropic-attribution.ts` with `-e`/`--extension`; otherwise attribution and sanitization are bypassed and the launch is unsupported. The package does not parse or override arbitrary shell authority.

## Cache retention

`PI_CACHE_RETENTION=none|short|long` selects process/provider policy. `/claude-cache status|short|long|default` stores a branch-local session override as a custom entry that does not enter model context. Call-level `cacheRetention` remains highest precedence, notably preserving Pi's compaction opt-out.

## Related docs

- [`/claude-cache`](../commands/claude-cache.md)
- [Configuration](../operations/configuration.md)
- [Fusion subsystem](fusion.md)
- [Delegation subsystem](delegation.md)
- [Attested Pi runs](attested-pi-runs.md)

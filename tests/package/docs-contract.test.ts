import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonText } from '../../src/core/common.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const text = (path: string): string => readFileSync(join(root, path), 'utf8');

void describe('docs package integration contract', () => {
  void it('declares deterministic docs and payload gates', () => {
    const pkg = parseJsonText(text('package.json')) as { scripts: Record<string, string>; files: string[] };
    assert.equal(pkg.scripts['docs:generate'], 'node scripts/docs/generate.mjs');
    assert.equal(pkg.scripts['docs:verify'], 'node scripts/docs/verify.mjs');
    assert.match(pkg.scripts['prepack'] ?? '', /docs:verify/);
    assert.match(pkg.scripts['prepack'] ?? '', /payload:check/);
    assert.ok(pkg.files.includes('docs/'));
    assert.ok(pkg.files.includes('BACKGROUND-TASKS-INSTRUCTIONS.md'));
  });

  void it('documents Trusted Publisher release ownership and lifecycle-only payload', () => {
    const publishing = text('PUBLISHING.md');
    assert.match(publishing, /Trusted Publisher OIDC/);
    assert.match(publishing, /Never run local `npm publish`/);
    assert.match(publishing, /one Pi entrypoint, `extensions\/background-tasks\.ts`/);
    assert.match(publishing, /Production dependencies are empty/);
  });

  void it('pins one registry/dock and running/done footer semantics', () => {
    const host = text('docs/subsystems/host-ui.md');
    assert.match(host, /exactly five tools/);
    assert.match(host, /one footer status, one overlay dock, one task namespace/);
    const shortcuts = text('docs/reference/shortcuts-and-dock.md');
    assert.match(shortcuts, /Ctrl\+B/);
    assert.match(shortcuts, /Shift\+Down/);
    assert.match(text('README.md'), /one registry and footer dock/);
  });

  void it('pins v1 preservation and v2 owner-correlated ordering', () => {
    const eventbus = text('docs/api/eventbus-v1.md');
    for (const operation of ['handshake', 'register', 'update', 'log', 'cancel_ack', 'settle', 'status', 'logs', 'kill']) {
      assert.match(eventbus, new RegExp(`\\b${operation}\\b`));
    }
    assert.match(eventbus, /V1 remains closed and compatible/);
    assert.match(eventbus, /Terminal publication occurs only after settlement/);
    assert.match(eventbus, /Unknown keys.*rejected before task creation or mutation/s);
    assert.match(eventbus, /During shutdown.*cancel_ack.*settle/s);
  });

  void it('declares the extracted scope in the 3.0.0 changelog entry', () => {
    const changelog = text('CHANGELOG.md');
    const unreleased = changelog.slice(
      changelog.indexOf('## [Unreleased]'),
      changelog.indexOf('## [3.0.0]'),
    );
    assert.doesNotMatch(unreleased, /### (Removed|Added|Changed)/u, 'Unreleased must be empty after the 3.0.0 cut');
    const released = changelog.slice(
      changelog.indexOf('## [3.0.0]'),
      changelog.indexOf('## [2.6.0]'),
    );
    assert.match(released, /^## \[3\.0\.0\] - \d{4}-\d{2}-\d{2}$/m);
    assert.match(released, /### Removed/);
    for (const removed of [/delegate/u, /attested/u, /Fusion/u, /Anthropic attribution/u]) {
      assert.match(released, removed, `3.0.0 must describe the removed surface: ${String(removed)}`);
    }
    assert.match(released, /EventBus v2 external-task/u);
    assert.match(released, /### Added|### Changed/u);
    const pkg = parseJsonText(text('package.json')) as { version: string };
    assert.equal(pkg.version, '3.0.0', 'package.json must match the 3.0.0 changelog entry');
  });

  void it('generates only task runtime paths and v1/v2 schemas', () => {
    const runtime = text('docs/reference/runtime-contracts.md');
    assert.match(runtime, /\.pi\/tasks\/<session-id>-<pid>\//);
    assert.match(runtime, /external-request\.v2/);
    assert.match(runtime, /extension-request\.v1/);
    assert.doesNotMatch(runtime, /candidate-<slot>|seed\.json|merged\.md|attestation\.json/);
  });
});

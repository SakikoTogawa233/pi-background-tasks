import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);

function runNode(rel: string, args: string[] = []) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(rel, root)), ...args], {
    cwd: fileURLToPath(root),
    encoding: 'utf8',
    env: { ...process.env, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0' },
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

void describe('docs freshness gate mutation fixtures', () => {
  void it('fails closed for malformed docs, stale coverage, stale receipts, payload gaps, unsupported extraction, and nondeterminism', () => {
    const result = runNode('scripts/docs/selftest.mjs');
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /mutation fixtures passed/);
  });

  void it('current docs verify deterministically with advisory receipt state', () => {
    const result = runNode('scripts/docs/verify.mjs');
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /deterministic generation OK; attestations advisory/);
  });

  void it('optional strict mode still fails closed for missing or stale receipts', () => {
    const result = runNode('scripts/docs/verify.mjs', ['--require-attestations']);
    assert.notEqual(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(
      result.stderr,
      /missing behavioral PASS attestation receipt|stale attestation authored prose hash/,
    );
  });
});

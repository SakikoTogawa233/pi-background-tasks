import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../../', import.meta.url);

function runNode(rel: string, args: string[] = [], env: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL(rel, root)), ...args], {
    cwd: fileURLToPath(root),
    encoding: 'utf8',
    env: {
      ...process.env,
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
      ...env,
    },
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

const packageVersion = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
).version as string;
const releaseTag = `v${packageVersion}`;

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

  void it('strict mode accepts the complete current receipt set', () => {
    const result = runNode('scripts/docs/verify.mjs', ['--require-attestations']);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /deterministic generation OK; attestations required/);
  });

  void it('accepts an explicit release ref independently of GitHub reserved environment values', () => {
    const result = runNode(
      'scripts/check-release-version.mjs',
      ['--ref-type', 'tag', '--ref-name', releaseTag],
      { GITHUB_REF_TYPE: 'branch', GITHUB_REF_NAME: 'main' },
    );
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, new RegExp(`${releaseTag} matches package\\.json`));
  });

  void it('preserves no-argument release checks for real tag-ref environments', () => {
    const result = runNode('scripts/check-release-version.mjs', [], {
      GITHUB_REF_TYPE: 'tag',
      GITHUB_REF_NAME: releaseTag,
    });
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, new RegExp(`${releaseTag} matches package\\.json`));
  });

  void it('rejects explicit version mismatches and strict CLI syntax errors', () => {
    const cases: Array<{ args: string[]; error: RegExp }> = [
      {
        args: ['--ref-type', 'tag', '--ref-name', 'v999999.0.0'],
        error: /release tag must be .*received v999999\.0\.0/,
      },
      { args: ['--unknown', 'value'], error: /unknown argument --unknown/ },
      { args: ['--ref-type'], error: /missing value for --ref-type/ },
      {
        args: ['--ref-type', 'tag', '--ref-type', 'tag', '--ref-name', releaseTag],
        error: /duplicate argument --ref-type/,
      },
      {
        args: ['--ref-type', 'branch', '--ref-name', releaseTag],
        error: /--ref-type must be tag; received branch/,
      },
      {
        args: ['--ref-type', 'tag', '--ref-name', packageVersion],
        error: /--ref-name must be a vX\.Y\.Z semantic-version tag/,
      },
    ];

    for (const fixture of cases) {
      const result = runNode('scripts/check-release-version.mjs', fixture.args, {
        GITHUB_REF_TYPE: 'tag',
        GITHUB_REF_NAME: releaseTag,
      });
      assert.notEqual(result.status, 0, `${fixture.args.join(' ')} unexpectedly passed`);
      assert.match(result.stderr, fixture.error);
    }
  });
});

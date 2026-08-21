import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseJsonText } from '../../src/core/common.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const forbidden =
  /bg_delegate|bg_result|bg_run_pi_attested|fusion_(?:reason|investigate|research|validate|brainstorm)|\/fusion(?:-models)?\b|anthropic-attribution|delegate-child|fusion-child|\.pi\/fusion|\.pi\/delegate|attestation\.json/iu;

function object(value: unknown, label: string): Record<string, unknown> {
  assert.ok(typeof value === 'object' && value !== null && !Array.isArray(value), label);
  return value as Record<string, unknown>;
}

async function manifest(): Promise<Record<string, unknown>> {
  return object(parseJsonText(await readFile(join(root, 'package.json'), 'utf8')), 'package.json');
}

async function walk(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}

function npmCli(): string {
  const nodeDir = dirname(process.execPath);
  for (const candidate of [
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`cannot resolve npm-cli.js near ${process.execPath}`);
}

void describe('package', () => {
  void it('declares only the background lifecycle entrypoint and runtime dependencies', async () => {
    const pkg = await manifest();
    assert.equal(pkg['name'], '@sakiko233/pi-background-tasks');
    assert.equal(pkg['version'], '3.0.0');
    assert.equal(pkg['type'], 'module');
    assert.match(String(pkg['description']), /background shell task lifecycle/iu);
    const pi = object(pkg['pi'], 'pi');
    assert.deepEqual(pi['extensions'], ['./extensions/background-tasks.ts']);
    assert.deepEqual(pkg['dependencies'] ?? {}, {});
    const peers = object(pkg['peerDependencies'], 'peerDependencies');
    assert.ok(peers['@earendil-works/pi-coding-agent']);
    assert.ok(peers['@earendil-works/pi-tui']);
    assert.equal(peers['typebox'], '*');
    const files = pkg['files'];
    assert.ok(Array.isArray(files));
    for (const required of [
      'extensions/',
      'src/',
      'docs/',
      'README.md',
      'TESTING.md',
      'TEST_PLAN.md',
      'PUBLISHING.md',
      'BACKGROUND-TASKS-INSTRUCTIONS.md',
      'LICENSE',
      'THIRD_PARTY_NOTICES.md',
      'logo.png',
    ]) assert.ok(files.includes(required), required);
  });

  void it('contains no active removed workflow or attribution bytes', async () => {
    const roots = ['extensions', 'src', 'docs'];
    const files = (await Promise.all(roots.map((dir) => walk(join(root, dir))))).flat();
    files.push(
      join(root, 'README.md'),
      join(root, 'TESTING.md'),
      join(root, 'TEST_PLAN.md'),
      join(root, 'PUBLISHING.md'),
      join(root, 'BACKGROUND-TASKS-INSTRUCTIONS.md'),
      join(root, 'package.json'),
    );
    for (const file of files) {
      if (!/\.(?:ts|js|json|md)$/u.test(file)) continue;
      assert.doesNotMatch(await readFile(file, 'utf8'), forbidden, file);
    }
  });

  void it('packs only the declared lifecycle payload', () => {
    const result = spawnSync(process.execPath, [npmCli(), 'pack', '--dry-run', '--json', '--ignore-scripts'], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, PI_OFFLINE: '1', NPM_CONFIG_OFFLINE: 'true' },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const parsed = parseJsonText(result.stdout);
    assert.ok(Array.isArray(parsed));
    const entry = object(parsed[0], 'pack result');
    const packedFiles = entry['files'];
    assert.ok(Array.isArray(packedFiles));
    const paths = packedFiles.map((value) => String(object(value, 'pack file')['path']));
    assert.ok(paths.includes('extensions/background-tasks.ts'));
    assert.ok(paths.includes('src/core/extension-api.ts'));
    assert.ok(paths.includes('src/core/registry.ts'));
    assert.ok(paths.includes('README.md'));
    assert.equal(paths.some((path) => path.startsWith('tests/')), false);
    assert.equal(paths.some((path) => path.startsWith('scripts/')), false);
    assert.equal(paths.some((path) => forbidden.test(path)), false);
  });
});

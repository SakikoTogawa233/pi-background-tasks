import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseJsonText } from '../../src/core/common.js';

interface PackageJson {
  name: string;
  type: string;
  keywords: string[];
  pi: { extensions: string[] };
  scripts: Record<string, string>;
  files: string[];
  peerDependencies: Record<string, string>;
}

interface NpmPackFile {
  path: string;
}

interface NpmPackEntry {
  filename: string;
  files: NpmPackFile[];
}

const root = new URL('../../', import.meta.url);

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

function field(value: object, key: string): unknown {
  const property: unknown = Reflect.get(value, key);
  return property;
}

function parseJsonValue(text: string): unknown {
  return parseJsonText(text);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  assert.ok(Array.isArray(value), `${label} must be an array`);
  assert.ok(
    value.every((item) => typeof item === 'string'),
    `${label} must contain strings`,
  );
  return value;
}

function parsePackageJson(value: unknown): PackageJson {
  assert.ok(isObject(value), 'package.json must be an object');
  const name = requireString(field(value, 'name'), 'name');
  const type = requireString(field(value, 'type'), 'type');
  const pi = field(value, 'pi');
  const scripts = field(value, 'scripts');
  const peerDependencies = field(value, 'peerDependencies');
  assert.ok(isObject(pi));
  assert.ok(isObject(scripts));
  assert.ok(isObject(peerDependencies));
  return {
    name,
    type,
    keywords: requireStringArray(field(value, 'keywords'), 'keywords'),
    pi: { extensions: requireStringArray(field(pi, 'extensions'), 'pi.extensions') },
    scripts: Object.fromEntries(
      Object.entries(scripts).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
    files: requireStringArray(field(value, 'files'), 'files'),
    peerDependencies: Object.fromEntries(
      Object.entries(peerDependencies).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    ),
  };
}

async function pkg(): Promise<PackageJson> {
  return parsePackageJson(parseJsonValue(await readFile(new URL('package.json', root), 'utf8')));
}

async function text(file: string): Promise<string> {
  return readFile(new URL(file, root), 'utf8');
}

function makeIsolatedEnvRoot(prefix: string): string {
  const rootDir = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(rootDir, 'home'), { recursive: true });
  mkdirSync(join(rootDir, 'cache'), { recursive: true });
  mkdirSync(join(rootDir, 'config'), { recursive: true });
  return rootDir;
}

function removeIsolatedEnvRoot(rootDir: string): void {
  rmSync(rootDir, { recursive: true, force: true });
}

function isolatedNpmEnv(rootDir: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env['PATH'] ?? '',
    HOME: join(rootDir, 'home'),
    USERPROFILE: join(rootDir, 'home'),
    XDG_CONFIG_HOME: join(rootDir, 'config'),
    NPM_CONFIG_CACHE: join(rootDir, 'cache'),
    NPM_CONFIG_USERCONFIG: join(rootDir, 'npmrc'),
    NPM_CONFIG_REGISTRY: 'http://127.0.0.1.invalid/',
    npm_config_cache: join(rootDir, 'cache'),
    npm_config_userconfig: join(rootDir, 'npmrc'),
    PI_OFFLINE: '1',
    PI_SKIP_VERSION_CHECK: '1',
    PI_TELEMETRY: '0',
    CI: '1',
  };
}

function parsePackEntries(stdout: string): NpmPackEntry[] {
  const parsed = parseJsonValue(stdout);
  assert.ok(Array.isArray(parsed), 'npm pack output must be an array');
  return parsed.map((entry): NpmPackEntry => {
    assert.ok(isObject(entry), 'pack entry must be an object');
    const filename = requireString(field(entry, 'filename'), 'pack filename');
    const files = field(entry, 'files');
    assert.ok(Array.isArray(files), 'pack entry files must be an array');
    return {
      filename,
      files: files.map((file): NpmPackFile => {
        assert.ok(isObject(file), 'pack file must be an object');
        const path = requireString(field(file, 'path'), 'pack file path');
        return { path };
      }),
    };
  });
}

void describe('package', () => {
  void it('manifest/docs cover public extension surfaces', async () => {
    const p = await pkg();
    assert.equal(p.name, 'pi-background-tasks');
    assert.equal(p.type, 'module');
    assert.ok(p.keywords.includes('pi-package'));
    assert.ok(p.keywords.includes('pi-extension'));
    assert.deepEqual(p.pi.extensions, ['./extensions/background-tasks.ts']);
    assert.match(p.scripts['test:agent-loop'] ?? '', /scripted-provider/);
    assert.match(p.scripts['test:full'] ?? '', /test:agent-loop/);
    assert.match(p.scripts['test:compat'] ?? '', /test-compat/);
    assert.ok(p.files.includes('extensions/'));
    assert.ok(p.files.includes('src/'));
    assert.ok(!p.files.includes('scripts/'));
    assert.ok(p.peerDependencies['@earendil-works/pi-coding-agent']);
    assert.ok(p.peerDependencies['@earendil-works/pi-tui']);
    assert.ok(p.peerDependencies['typebox']);
    for (const f of [
      'README.md',
      'TESTING.md',
      'TEST_PLAN.md',
      'PUBLISHING.md',
      'LICENSE',
      'src/extension.ts',
      'src/ui/background-tasks-manager.ts',
      'src/ui/fusion-model-selector.ts',
      'src/core/common.ts',
      'src/core/registry.ts',
      'src/core/extension-api.ts',
      'src/core/attested-pi-run.ts',
      'src/core/fusion/orchestrator.ts',
      'src/core/fusion/pi-child.ts',
      'src/fusion-extension.ts',
      'extensions/background-tasks.ts',
    ])
      assert.ok(existsSync(new URL(f, root)), f);

    const extensionSource = await text('src/extension.ts');
    assert.match(extensionSource, /registerFusionExtension\(pi\)/);
    const readme = await text('README.md');
    const plan = await text('TEST_PLAN.md');
    for (const surface of [
      '/bg',
      '/jobs',
      '/logs',
      '/kill',
      '/tasks',
      '/bg-tasks',
      '/bg-clear',
      '/bg-update',
      'bg_run',
      'bg_run_pi_attested',
      'bg_status',
      'bg_logs',
      'bg_kill',
      'pi-background-tasks:request:v1',
      'pi-background-tasks:response:v1',
      'pi-background-tasks:terminal:v1',
      'src/core/extension-api.ts',
      'Shift+Down',
      'Ctrl+Alt+C',
      '/fusion',
      '/fusion-models',
      'fusion_brainstorm',
      'fusion-result',
      'fusion-models.json',
      '.pi/fusion',
    ]) {
      assert.match(
        readme,
        new RegExp(surface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `README missing ${surface}`,
      );
      assert.match(
        plan,
        new RegExp(surface.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `TEST_PLAN missing ${surface}`,
      );
    }
  });

  void it('fusion production code avoids direct completion APIs and local adapters', async () => {
    const fusionFiles = [
      'src/fusion-extension.ts',
      'src/core/fusion/config.ts',
      'src/core/fusion/context.ts',
      'src/core/fusion/prompts.ts',
      'src/core/fusion/evaluation.ts',
      'src/core/fusion/pi-child.ts',
      'src/core/fusion/artifacts.ts',
      'src/core/fusion/orchestrator.ts',
      'src/ui/fusion-model-selector.ts',
      'extensions/background-tasks.ts',
    ];
    for (const file of fusionFiles) {
      const source = await text(file);
      assert.doesNotMatch(source, /@earendil-works\/pi-ai\/compat/);
      assert.doesNotMatch(source, /import\s*\{[^}]*\b(?:complete|stream|streamSimple)\b[^}]*}\s*from\s*['"]@earendil-works\/pi-ai/);
      assert.doesNotMatch(source, /\.pi\/extensions/);
      assert.doesNotMatch(source, /ai-pipeline/);
    }
    const child = await text('src/core/fusion/pi-child.ts');
    for (const flag of [
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--no-session',
    ]) assert.match(child, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  void it('packs exactly the runtime/docs payload and excludes tests/artifacts', () => {
    const envRoot = makeIsolatedEnvRoot('pi-bg-pack-env-');
    const r = spawnSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: root,
      encoding: 'utf8',
      env: isolatedNpmEnv(envRoot),
    });
    removeIsolatedEnvRoot(envRoot);
    assert.equal(r.status, 0, r.stderr);
    const firstEntry = parsePackEntries(r.stdout)[0];
    assert.ok(firstEntry, 'npm pack must return one entry');
    const files = firstEntry.files.map((file) => file.path).sort();
    for (const f of [
      'extensions/background-tasks.ts',
      'src/extension.ts',
      'src/core/common.ts',
      'src/core/registry.ts',
      'src/core/extension-api.ts',
      'src/core/attested-pi-run.ts',
      'src/ui/background-tasks-manager.ts',
      'src/ui/fusion-model-selector.ts',
      'src/fusion-extension.ts',
      'src/core/fusion/types.ts',
      'src/core/fusion/config.ts',
      'src/core/fusion/context.ts',
      'src/core/fusion/prompts.ts',
      'src/core/fusion/evaluation.ts',
      'src/core/fusion/pi-child.ts',
      'src/core/fusion/artifacts.ts',
      'src/core/fusion/orchestrator.ts',
      'src/testing/normalize.ts',
      'README.md',
      'TESTING.md',
      'TEST_PLAN.md',
      'PUBLISHING.md',
      'LICENSE',
      'package.json',
    ])
      assert.ok(files.includes(f), f);
    assert.ok(!files.some((f) => f.startsWith('tests/')), 'tests must not ship');
    assert.ok(!files.some((f) => f.startsWith('scripts/')), 'release-only scripts must not ship');
    assert.ok(!files.some((f) => f.includes('node_modules')), 'node_modules must not ship');
    assert.ok(!files.some((f) => f.endsWith('.tgz')), 'nested tarballs must not ship');
  });

  void it('local tarball installs with the expected package files', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'pi-bg-pack-'));
    let tarball: URL | undefined;
    const packEnvRoot = makeIsolatedEnvRoot('pi-bg-pack-env-');
    const installEnvRoot = makeIsolatedEnvRoot('pi-bg-install-env-');
    try {
      const pack = spawnSync('npm', ['pack', '--json'], {
        cwd: root,
        encoding: 'utf8',
        env: isolatedNpmEnv(packEnvRoot),
      });
      assert.equal(pack.status, 0, pack.stderr);
      const firstEntry = parsePackEntries(pack.stdout)[0];
      assert.ok(firstEntry, 'npm pack must return one entry');
      tarball = new URL(firstEntry.filename, root);
      const tarballPath = tarball.pathname;
      const init = spawnSync('npm', ['init', '-y'], {
        cwd: temp,
        encoding: 'utf8',
        env: isolatedNpmEnv(installEnvRoot),
      });
      assert.equal(init.status, 0, init.stderr);
      const install = spawnSync(
        'npm',
        ['install', '--legacy-peer-deps', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath],
        {
          cwd: temp,
          encoding: 'utf8',
          env: isolatedNpmEnv(installEnvRoot),
        },
      );
      assert.equal(install.status, 0, install.stderr);
      for (const f of [
        'package.json',
        'extensions/background-tasks.ts',
        'src/extension.ts',
        'src/fusion-extension.ts',
        'src/core/registry.ts',
        'src/core/extension-api.ts',
        'src/core/attested-pi-run.ts',
        'src/core/fusion/orchestrator.ts',
        'src/core/fusion/pi-child.ts',
        'src/ui/background-tasks-manager.ts',
        'src/ui/fusion-model-selector.ts',
      ]) {
        assert.ok(existsSync(join(temp, 'node_modules', 'pi-background-tasks', f)), f);
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
      removeIsolatedEnvRoot(packEnvRoot);
      removeIsolatedEnvRoot(installEnvRoot);
      if (tarball) await rm(tarball, { force: true });
    }
  });
});

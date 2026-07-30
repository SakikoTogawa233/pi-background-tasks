import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
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

interface SourceViolation {
  file: string;
  rule: string;
  excerpt: string;
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

async function walkSourceTree(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walkSourceTree(path)));
    else if (/\.ts$/.test(entry.name)) files.push(path);
  }
  return files;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function compactExcerpt(source: string): string {
  return source.replace(/\s+/g, ' ').trim().slice(0, 180);
}

function isPathLikeParameter(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'path' || lower === 'file' || lower.endsWith('path');
}

function isPathSyncHelperName(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith('write') || lower.startsWith('replace')) return false;
  if (
    lower === 'fsync' ||
    lower === 'sync' ||
    lower === 'fsyncfile' ||
    lower === 'fsyncpath' ||
    lower === 'syncfile' ||
    lower === 'syncpath'
  )
    return true;
  if (lower.includes('fsync') && (lower.includes('file') || lower.includes('path'))) return true;
  return lower.startsWith('sync') && (lower.includes('file') || lower.includes('path'));
}

function addPatternViolations(
  violations: SourceViolation[],
  file: string,
  rule: string,
  source: string,
  pattern: RegExp,
): void {
  for (const match of source.matchAll(pattern)) {
    violations.push({ file, rule, excerpt: compactExcerpt(match[0] ?? '') });
  }
}

function addExportedPathSyncViolations(
  violations: SourceViolation[],
  file: string,
  source: string,
): void {
  const exportedFunction = /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(\s*([A-Za-z_$][\w$]*)\b/g;
  for (const match of source.matchAll(exportedFunction)) {
    const name = match[1];
    const parameter = match[2];
    if (
      name !== undefined &&
      parameter !== undefined &&
      isPathSyncHelperName(name) &&
      isPathLikeParameter(parameter)
    ) {
      violations.push({ file, rule: 'exported path sync helper', excerpt: compactExcerpt(match[0]) });
    }
  }

  const exportedConst = /\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)\b/g;
  for (const match of source.matchAll(exportedConst)) {
    const name = match[1];
    const parameter = match[2];
    if (
      name !== undefined &&
      parameter !== undefined &&
      isPathSyncHelperName(name) &&
      isPathLikeParameter(parameter)
    ) {
      violations.push({ file, rule: 'exported path sync helper', excerpt: compactExcerpt(match[0]) });
    }
  }

  const exportedList = /\bexport\s*\{([^}]*)\}/g;
  for (const match of source.matchAll(exportedList)) {
    const names = match[1];
    if (names !== undefined && names.split(',').some((name) => isPathSyncHelperName(name.trim()))) {
      violations.push({ file, rule: 'exported path sync helper', excerpt: compactExcerpt(match[0]) });
    }
  }
}

function addSwallowedSyncViolations(
  violations: SourceViolation[],
  file: string,
  source: string,
): void {
  const syncTryCatch = /try\s*\{(?:(?!\}\s*catch)[\s\S])*?\.sync\s*\([^)]*\)[\s\S]*?\}\s*catch\s*(?:\([^)]*\))?\s*\{([\s\S]*?)\}/g;
  for (const match of source.matchAll(syncTryCatch)) {
    const body = match[1] ?? '';
    const trimmed = body.trim();
    const recordsFailure = /failure\(\s*['"]sync_(?:file|directory)['"]/.test(body) ||
      /throwDurable\b/.test(body);
    const throwsImmediately = /^throw\b/.test(trimmed);
    if (trimmed.length === 0 || /\breturn\b/.test(body) || (!recordsFailure && !throwsImmediately)) {
      violations.push({ file, rule: 'silent sync catch', excerpt: compactExcerpt(match[0] ?? '') });
    }
  }
}

function formatSourceViolations(violations: readonly SourceViolation[]): string {
  return violations
    .map((violation) => `${violation.file} ${violation.rule}: ${violation.excerpt}`)
    .join('\n');
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
      'src/core/pi-launch.ts',
      'src/core/fusion/orchestrator.ts',
      'src/core/fusion/pi-child.ts',
      'src/core/fusion/budget.ts',
      'src/fusion-extension.ts',
      'src/fusion-child-extension.ts',
      'extensions/background-tasks.ts',
      'extensions/fusion-child.ts',
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
      'context-omission-ledger.json',
      'budget-plan.json',
      'fusion-input.v2',
      'prompt_budget_exceeded',
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
      'src/core/fusion/budget.ts',
      'src/ui/fusion-model-selector.ts',
      'src/fusion-child-extension.ts',
      'extensions/background-tasks.ts',
      'extensions/fusion-child.ts',
    ];
    for (const file of fusionFiles) {
      const source = await text(file);
      assert.doesNotMatch(source, /@earendil-works\/pi-ai\/compat/);
      assert.doesNotMatch(
        source,
        /import\s*\{[^}]*\b(?:complete|stream|streamSimple)\b[^}]*}\s*from\s*['"]@earendil-works\/pi-ai/,
      );
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
    ])
      assert.match(child, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  void it('BUG-182 keeps Fusion usage on the exact host contract across shipped producers and consumers', async () => {
    const files = [
      'src/fusion-child-extension.ts',
      'src/fusion-extension.ts',
      'src/core/fusion/types.ts',
      'src/core/fusion/pi-child.ts',
      'src/core/fusion/orchestrator.ts',
      'src/core/fusion/artifacts.ts',
    ];
    for (const file of files) {
      const source = await text(file);
      assert.doesNotMatch(source, /costTotal/, `${file} must not carry the retired cost shape`);
    }
    const child = await text('src/fusion-child-extension.ts');
    assert.match(child, /fusion-child-result\.v2/);
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) {
      assert.match(child, new RegExp(`cost\\.${key}`));
    }
    const types = await text('src/core/fusion/types.ts');
    assert.match(types, /fusion-result\.v2/);
    assert.match(types, /fusion-manifest\.v2/);
    assert.match(types, /export type FusionUsage = Usage/);
    const extension = await text('src/fusion-extension.ts');
    assert.match(extension, /usage: Usage/);
    assert.match(extension, /usage: cloneFusionUsage\(result\.details\.usage\)/);
  });

  void it('keeps the Fusion context/budget path free of silent truncation and fallback shapes', async () => {
    const context = await text('src/core/fusion/context.ts');
    const budget = await text('src/core/fusion/budget.ts');
    const orchestratorText = await text('src/core/fusion/orchestrator.ts');
    const orchestratorSource = () => orchestratorText;

    // No clipping of retained conversational text. Scan code only: comments
    // legitimately discuss truncation in order to forbid it.
    const codeOnly = (source: string): string =>
      source
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n')
        .filter((line) => !line.trim().startsWith('//'))
        .join('\n');
    for (const [label, source] of [
      ['context', codeOnly(context)],
      ['budget', codeOnly(budget)],
    ] as const) {
      assert.doesNotMatch(source, /\.slice\(/, `${label} must not clip retained content`);
      assert.doesNotMatch(source, /\.substring\(/, `${label} must not clip retained content`);
      assert.doesNotMatch(source, /\.trim\(\)\.slice/, `${label} must not clip retained content`);
      assert.doesNotMatch(source, /catch\s*\{\s*\}/, `${label} must not swallow errors`);
    }

    // The projection must never carry a payload preview, however it is spelled.
    assert.match(context, /tool_payload_preview_bytes: 0/);

    // Budget rejection must be a loud typed error, never a clamp or a downgrade.
    assert.match(budget, /prompt_budget_exceeded/);
    assert.match(budget, /model_capacity_unknown/);
    assert.doesNotMatch(budget, /Math\.min\([^)]*allowed/i, 'budget must not clamp to fit');

    // Output contracts must be enforced, which is what makes the downstream
    // reserve a guarantee rather than an assumption.
    assert.match(budget, /assertChildOutputWithinContract/);
    assert.match(budget, /child_output_cap/);
    assert.match(orchestratorSource(), /assertChildOutputWithinContract\('candidate'/);

    // The downstream reserve must be converted through the same byte-to-token
    // function used to measure prompts, not reserved as output tokens directly.
    assert.match(
      budget,
      /FUSION_DOWNSTREAM_RESERVE_TOKENS = Math\.ceil\(\s*FUSION_DOWNSTREAM_RESERVE_BYTES \/ FUSION_BYTES_PER_TOKEN_DIVISOR/,
    );

    // Safety must derive from the smallest route, so no max-style selection.
    assert.doesNotMatch(budget, /Math\.max\([^)]*allowed_input_tokens/);
    assert.match(budget, /smallest input budget|never the largest/);

    // The conservative divisor must not drift to the 4-bytes-per-token assumption.
    assert.match(budget, /FUSION_BYTES_PER_TOKEN_DIVISOR = 2/);

    // Every budget stage must be guarded in the orchestrator before spawning.
    const orchestrator = orchestratorSource();
    for (const stage of ['candidate', 'evaluation', 'evaluation_repair', 'merge']) {
      assert.match(
        orchestrator,
        new RegExp(`assertStagePrompt\\(\\s*'${stage}'`),
        `orchestrator must preflight the ${stage} stage`,
      );
    }
    assert.match(orchestrator, /assertBaseContext\(/);
  });

  void it('keeps production durable syncing handle-scoped and loud', async () => {
    const files = await walkSourceTree(fileURLToPath(new URL('src/', root)));
    const violations: SourceViolation[] = [];
    for (const file of files) {
      const source = stripComments(await readFile(file, 'utf8'));
      const label = file.startsWith(root.pathname) ? file.slice(root.pathname.length) : file;
      addPatternViolations(
        violations,
        label,
        'read-open sync',
        source,
        /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:nodeOpen|open|fs(?:Promises)?\.open|[A-Za-z_$][\w$]*\.openWritable)\s*\([^;]*,\s*(['"])r\+?\2[^;]*\)\s*;?[\s\S]*?\b\1\s*\.\s*sync\s*\(/g,
      );
      addPatternViolations(
        violations,
        label,
        'read-open sync',
        source,
        /\b([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:nodeOpen|open|fs(?:Promises)?\.open|[A-Za-z_$][\w$]*\.openWritable)\s*\([^;]*,\s*(['"])r\+?\2[^;]*\)\s*;?[\s\S]*?\b\1\s*\.\s*sync\s*\(/g,
      );
      addPatternViolations(
        violations,
        label,
        'fsyncFile function',
        source,
        /\b(?:async\s+)?function\s+fsyncFile\b|\b(?:const|let|var)\s+fsyncFile\s*=/g,
      );
      addExportedPathSyncViolations(violations, label, source);
      addSwallowedSyncViolations(violations, label, source);
    }
    assert.equal(violations.length, 0, formatSourceViolations(violations));
  });

  void it('converts file URLs to native paths instead of using URL.pathname', async () => {
    // On Windows `new URL(...).pathname` yields `/D:/a/repo/`, and joining that
    // produces `D:\D:\a\repo\...`, which fails with ENOENT. CI proved this.
    // `fileURLToPath` is the only correct conversion.
    const roots = ['src', 'extensions', 'scripts', 'tests'];
    const offenders: string[] = [];
    for (const rootDir of roots) {
      const dir = fileURLToPath(new URL(`${rootDir}/`, root));
      if (!existsSync(dir)) continue;
      for (const file of await walkSourceTree(dir)) {
        const source = await readFile(file, 'utf8');
        const stripped = source
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .split('\n')
          .filter((line) => !line.trim().startsWith('//'))
          .join('\n');
        if (/new URL\([^)]*\)\s*\.pathname/.test(stripped)) offenders.push(file);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      'use fileURLToPath(new URL(...)) so Windows paths resolve correctly',
    );
  });

  void it('typechecks standalone with the full monorepo strictness vendored locally', async () => {
    // The package is published both from this monorepo and as a standalone git
    // repo. A parent `../../tsconfig.base.json` does not exist in the standalone
    // checkout, so `extends` must point at a locally vendored copy. CI proved
    // that a missing base silently drops `skipLibCheck` and makes `tsc` walk
    // node_modules type definitions.
    const tsconfig = parseJsonValue(await text('tsconfig.json'));
    assert.ok(isObject(tsconfig));
    assert.equal(
      field(tsconfig, 'extends'),
      './tsconfig.base.json',
      'tsconfig must extend a locally vendored base so standalone checkouts typecheck',
    );

    const localBase = parseJsonValue(await text('tsconfig.base.json'));
    assert.ok(isObject(localBase));
    const localOptions = field(localBase, 'compilerOptions');
    assert.ok(isObject(localOptions));

    // Every strictness flag from the monorepo base must be present and equal.
    // Weakening the standalone config to make a build pass is not acceptable.
    const required: Record<string, boolean> = {
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      noImplicitOverride: true,
      noImplicitReturns: true,
      noPropertyAccessFromIndexSignature: true,
      noFallthroughCasesInSwitch: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      useUnknownInCatchVariables: true,
      verbatimModuleSyntax: true,
      isolatedModules: true,
      allowUnreachableCode: false,
      allowUnusedLabels: false,
      skipLibCheck: true,
    };
    for (const [flag, expected] of Object.entries(required)) {
      assert.equal(
        field(localOptions, flag),
        expected,
        `vendored tsconfig.base.json must keep ${flag}=${String(expected)}`,
      );
    }
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
      'extensions/fusion-child.ts',
      'src/extension.ts',
      'src/fusion-child-extension.ts',
      'src/core/common.ts',
      'src/core/registry.ts',
      'src/core/extension-api.ts',
      'src/core/attested-pi-run.ts',
      'src/core/pi-launch.ts',
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
      'src/core/fusion/budget.ts',
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
        [
          'install',
          '--legacy-peer-deps',
          '--offline',
          '--ignore-scripts',
          '--no-audit',
          '--no-fund',
          tarballPath,
        ],
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
        'extensions/fusion-child.ts',
        'src/extension.ts',
        'src/fusion-extension.ts',
        'src/fusion-child-extension.ts',
        'src/core/registry.ts',
        'src/core/extension-api.ts',
        'src/core/attested-pi-run.ts',
        'src/core/pi-launch.ts',
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

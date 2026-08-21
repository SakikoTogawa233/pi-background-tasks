import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseJsonText } from '../src/core/common.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const versions = ['0.81.1', '0.82.1', '0.83.0', '0.84.0'] as const;
const typeboxByVersion: Record<(typeof versions)[number], string> = {
  '0.81.1': '~1.1.38',
  '0.82.1': '~1.1.38',
  '0.83.0': '1.3.7',
  '0.84.0': '1.3.7',
};
const forbidden =
  /bg_delegate|bg_result|bg_run_pi_attested|fusion_(?:reason|investigate|research|validate|brainstorm)|anthropic-attribution|delegate-child|fusion-child/iu;

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, [...args], { cwd, env, encoding: 'utf8', timeout: 120_000 });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function resolveNpmCli(): string {
  const nodeDir = dirname(process.execPath);
  for (const candidate of [
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]) if (existsSync(candidate)) return candidate;
  throw new Error(`cannot resolve npm-cli.js near ${process.execPath}`);
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

function packageBin(temp: string): { executable: string; args: string[] } {
  const manifestPath = join(temp, 'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json');
  const manifest = record(parseJsonText(readFileSync(manifestPath, 'utf8')), 'Pi package manifest');
  const bin = record(manifest['bin'], 'Pi package bin');
  const cli = String(bin['pi']);
  return { executable: process.execPath, args: [join(dirname(manifestPath), cli)] };
}

async function verifyInstalledBytes(packageDir: string): Promise<void> {
  for (const file of await walk(packageDir)) {
    if (!/\.(?:ts|js|json|md)$/u.test(file)) continue;
    const text = await readFile(file, 'utf8');
    if (forbidden.test(text)) throw new Error(`removed surface remains in installed file ${file}`);
  }
}

async function main(): Promise<void> {
  const npmCli = resolveNpmCli();
  const packOutput = run(
    process.execPath,
    [npmCli, 'pack', '--json', '--ignore-scripts'],
    root,
    { ...process.env, PI_OFFLINE: '1', PI_SKIP_VERSION_CHECK: '1', PI_TELEMETRY: '0', CI: '1' },
  );
  const pack = parseJsonText(packOutput);
  if (!Array.isArray(pack) || pack.length !== 1) throw new Error('npm pack must return one entry');
  const tarball = join(root, String(record(pack[0], 'pack entry')['filename']));
  try {
    for (const version of versions) {
      const temp = await mkdtemp(join(tmpdir(), `pi-bg-compat-${version}-`));
      try {
        await writeFile(
          join(temp, 'package.json'),
          `${JSON.stringify({
            private: true,
            type: 'module',
            dependencies: {
              '@earendil-works/pi-coding-agent': version,
              '@earendil-works/pi-tui': version,
              typebox: typeboxByVersion[version],
              '@sakiko233/pi-background-tasks': `file:${tarball}`,
            },
          }, null, 2)}\n`,
          'utf8',
        );
        const env = {
          ...process.env,
          PI_OFFLINE: '1',
          PI_SKIP_VERSION_CHECK: '1',
          PI_TELEMETRY: '0',
          CI: '1',
          NPM_CONFIG_CACHE: process.env['NPM_CONFIG_CACHE'] ?? join(tmpdir(), 'pi-npm-cache'),
        };
        run(process.execPath, [npmCli, 'install', '--ignore-scripts', '--legacy-peer-deps'], temp, env);
        const packageDir = join(temp, 'node_modules', '@sakiko233', 'pi-background-tasks');
        const installedManifest = record(parseJsonText(await readFile(join(packageDir, 'package.json'), 'utf8')), 'installed manifest');
        const pi = record(installedManifest['pi'], 'installed pi manifest');
        const extensions = pi['extensions'];
        if (!Array.isArray(extensions) || extensions.length !== 1 || extensions[0] !== './extensions/background-tasks.ts') {
          throw new Error(`Pi ${version}: installed extension manifest is not lifecycle-only`);
        }
        await verifyInstalledBytes(packageDir);
        if (existsSync(join(packageDir, 'node_modules', 'typebox'))) {
          throw new Error(`Pi ${version}: package installed a private TypeBox copy`);
        }
        const launch = packageBin(temp);
        const agentDir = join(temp, 'agent');
        const sessions = join(temp, 'sessions');
        await mkdir(agentDir, { recursive: true });
        await mkdir(sessions, { recursive: true });
        run(
          launch.executable,
          [
            ...launch.args,
            '--offline',
            '--no-session',
            '--no-extensions',
            '-e',
            join(packageDir, 'extensions', 'background-tasks.ts'),
            '--no-skills',
            '--no-prompt-templates',
            '--no-context-files',
            '--no-tools',
            '-p',
            '/jobs',
          ],
          temp,
          { ...env, PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: sessions },
        );
        console.log(`Pi ${version}: lifecycle package load and payload checks passed`);
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
    }
  } finally {
    await rm(tarball, { force: true });
  }
}

await main();

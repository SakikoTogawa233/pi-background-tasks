import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseJsonText } from '../src/core/common.js';
import { isolatedTestEnv } from '../src/testing/normalize.js';
import { installFusionFakePi } from '../tests/helpers/fusion-fake-pi.js';

const requiredVersions = ['0.75.5', '0.81.1', '0.82.1'] as const;
const root = new URL('../', import.meta.url).pathname;

interface PackFileEntry {
  filename: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const result = spawnSync(command, [...args], {
    cwd,
    encoding: 'utf8',
    env: { ...env, NPM_CONFIG_CACHE: env['NPM_CONFIG_CACHE'] ?? '/tmp/pi-npm-cache' },
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed in ${cwd}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

async function runRpcPromptUntil(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  prompt: string,
  expected: RegExp,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error: Error | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGTERM');
      if (error === undefined) resolve(stdout);
      else reject(error);
    };
    const timer = setTimeout(() => {
      finish(new Error(`RPC prompt timed out\n${stdout}\n${stderr}`));
    }, 20_000);
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      if (expected.test(stdout)) finish(undefined);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      finish(error);
    });
    child.on('close', (code) => {
      if (!settled && code !== 0)
        finish(
          new Error(
            `RPC prompt exited ${code === null ? 'null' : String(code)}\n${stdout}\n${stderr}`,
          ),
        );
    });
    child.stdin.end(
      `${JSON.stringify({ type: 'prompt', message: prompt, id: 'compat-rpc-prompt' })}\n`,
    );
  });
}

function parsePack(text: string): PackFileEntry {
  const parsed = parseJsonText(text);
  if (!Array.isArray(parsed)) throw new Error('npm pack JSON output must be an array');
  const first = parsed[0];
  if (!isRecord(first)) throw new Error('npm pack JSON entry must be an object');
  return { filename: requireString(first['filename'], 'pack filename') };
}

async function smokeVersion(version: string, tarballPath: string): Promise<void> {
  const temp = await mkdtemp(join(tmpdir(), `pi-bg-compat-${version}-`));
  try {
    run('npm', ['init', '-y'], temp);
    run(
      'npm',
      [
        'install',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
        tarballPath,
        `@earendil-works/pi-coding-agent@${version}`,
        `@earendil-works/pi-tui@${version}`,
        'typebox@^1.1.38',
      ],
      temp,
    );
    const cli = join(temp, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
    const extension = join(
      temp,
      'node_modules',
      'pi-background-tasks',
      'extensions',
      'background-tasks.ts',
    );
    if (!existsSync(cli)) throw new Error(`Pi CLI not installed for ${version}: ${cli}`);
    if (!existsSync(extension))
      throw new Error(`package extension missing for ${version}: ${extension}`);
    const agentDir = join(temp, 'agent');
    await mkdir(agentDir, { recursive: true });
    const fake = await installFusionFakePi(temp, { mergedText: `compat fusion ${version}` });
    const scriptedProviderPath = join(
      root,
      'tests',
      'scripted-provider',
      'scripted-provider-extension.ts',
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...isolatedTestEnv,
      PATH: `${fake.binDir}:${process.env['PATH'] ?? ''}`,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: join(temp, 'sessions'),
      PI_BG_SCRIPTED_API_KEY: 'scripted-api-key',
      PI_BG_SCRIPTED_SCENARIO: 'display-only-bg',
    };
    run(
      process.execPath,
      [
        cli,
        '--no-extensions',
        '-e',
        extension,
        '--offline',
        '--no-tools',
        '--no-session',
        '-p',
        '/jobs',
      ],
      temp,
      env,
    );
    run(
      process.execPath,
      [
        cli,
        '--no-extensions',
        '-e',
        scriptedProviderPath,
        '-e',
        extension,
        '--offline',
        '--no-tools',
        '--no-session',
        '--model',
        'pi-bg-scripted/scripted-model',
        '-p',
        '/fusion compatibility prompt',
      ],
      temp,
      env,
    );
    const childCalls = await readFile(fake.logPath, 'utf8');
    const childCallCount =
      childCalls.trim().length === 0 ? 0 : childCalls.trim().split('\n').length;
    if (childCallCount !== 5)
      throw new Error(
        `Fusion compatibility expected five child calls for ${version}, saw ${String(childCallCount)}`,
      );
    await runRpcPromptUntil(
      process.execPath,
      [
        cli,
        '--mode',
        'rpc',
        '--no-extensions',
        '-e',
        extension,
        '--offline',
        '--no-tools',
        '--no-session',
        '--no-skills',
        '--no-prompt-templates',
        '--no-context-files',
      ],
      temp,
      env,
      '/fusion-models',
      /requires Pi TUI mode/,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

const pack = parsePack(run('npm', ['pack', '--json'], root));
const tarballPath = join(root, pack.filename);
try {
  for (const version of requiredVersions) await smokeVersion(version, tarballPath);
  console.log(`Smoke-loaded pi-background-tasks against Pi ${requiredVersions.join(', ')}`);
} finally {
  await rm(tarballPath, { force: true });
}

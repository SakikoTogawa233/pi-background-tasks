import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { parseJsonText } from '../src/core/common.js';
import { isolatedTestEnv } from '../src/testing/normalize.js';
import { installFusionFakePi, resolveRealPiCli } from '../tests/helpers/fusion-fake-pi.js';

const requiredVersions = ['0.75.5', '0.81.1', '0.82.1'] as const;
const root = new URL('../', import.meta.url).pathname;

interface PackFileEntry {
  filename: string;
}

interface RpcSessionStats {
  sessionFile: string;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`);
  return value;
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`${label} must be a finite number`);
  return value;
}

function parseRpcSessionStats(value: unknown): RpcSessionStats {
  if (!isRecord(value)) throw new Error('RPC session stats must be an object');
  const tokens = value['tokens'];
  if (!isRecord(tokens)) throw new Error('RPC session stats.tokens must be an object');
  return {
    sessionFile: requireString(value['sessionFile'], 'RPC session stats.sessionFile'),
    tokens: {
      input: requireNumber(tokens['input'], 'RPC session stats.tokens.input'),
      output: requireNumber(tokens['output'], 'RPC session stats.tokens.output'),
      cacheRead: requireNumber(tokens['cacheRead'], 'RPC session stats.tokens.cacheRead'),
      cacheWrite: requireNumber(tokens['cacheWrite'], 'RPC session stats.tokens.cacheWrite'),
      total: requireNumber(tokens['total'], 'RPC session stats.tokens.total'),
    },
    cost: requireNumber(value['cost'], 'RPC session stats.cost'),
  };
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

async function runRpcSessionStats(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  prompt?: string,
): Promise<RpcSessionStats> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdoutBuffer = '';
    let stdoutDiagnostic = '';
    let stderrDiagnostic = '';
    let stats: RpcSessionStats | undefined;
    let statsRequested = false;
    let settled = false;
    const appendDiagnostic = (current: string, chunk: string): string =>
      `${current}${chunk}`.slice(-64 * 1024);
    const finish = (error: Error | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!child.killed) child.kill('SIGTERM');
      if (error !== undefined) reject(error);
      else if (stats === undefined) reject(new Error('RPC process closed without session stats'));
      else resolve(stats);
    };
    const requestStats = () => {
      if (statsRequested) return;
      statsRequested = true;
      child.stdin.write(`${JSON.stringify({ type: 'get_session_stats', id: 'compat-stats' })}\n`);
    };
    const processLine = (line: string) => {
      if (!line.trim()) return;
      let parsed: unknown;
      try {
        parsed = parseJsonText(line);
      } catch (error) {
        finish(
          new Error(
            `RPC emitted invalid JSON: ${error instanceof Error ? error.message : String(error)}\n${line.slice(0, 1000)}`,
          ),
        );
        return;
      }
      if (!isRecord(parsed)) {
        finish(new Error(`RPC emitted a non-object frame: ${line.slice(0, 1000)}`));
        return;
      }
      if (prompt !== undefined && parsed['type'] === 'agent_end') requestStats();
      if (
        parsed['type'] === 'response' &&
        parsed['command'] === 'get_session_stats' &&
        parsed['id'] === 'compat-stats'
      ) {
        if (parsed['success'] !== true) {
          finish(new Error(`get_session_stats failed: ${line.slice(0, 1000)}`));
          return;
        }
        try {
          stats = parseRpcSessionStats(parsed['data']);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
          return;
        }
        child.kill('SIGTERM');
      }
    };
    const timer = setTimeout(() => {
      finish(
        new Error(
          `RPC session stats timed out\nstdout:\n${stdoutDiagnostic}\nstderr:\n${stderrDiagnostic}`,
        ),
      );
    }, 30_000);
    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdoutDiagnostic = appendDiagnostic(stdoutDiagnostic, text);
      stdoutBuffer += text;
      if (stdoutBuffer.length > 2 * 1024 * 1024) {
        finish(new Error('RPC emitted a line larger than 2 MiB'));
        return;
      }
      for (;;) {
        const newline = stdoutBuffer.indexOf('\n');
        if (newline < 0) break;
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        processLine(line);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrDiagnostic = appendDiagnostic(stderrDiagnostic, chunk.toString('utf8'));
    });
    child.on('error', (error) => {
      finish(error);
    });
    child.on('close', (code, signal) => {
      if (stats !== undefined) {
        finish(undefined);
        return;
      }
      finish(
        new Error(
          `RPC process exited ${code === null ? 'null' : String(code)} (${signal ?? 'no signal'}) before stats\nstdout:\n${stdoutDiagnostic}\nstderr:\n${stderrDiagnostic}`,
        ),
      );
    });
    if (prompt === undefined) requestStats();
    else
      child.stdin.write(
        `${JSON.stringify({ type: 'prompt', message: prompt, id: 'compat-fusion-prompt' })}\n`,
      );
  });
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

async function readPersistedFusionToolResult(
  sessionFile: string,
): Promise<Record<string, unknown>> {
  const lines = (await readFile(sessionFile, 'utf8')).split('\n').filter(Boolean);
  for (const line of lines) {
    const entry = parseJsonText(line);
    if (!isRecord(entry) || entry['type'] !== 'message') continue;
    const message = entry['message'];
    if (
      isRecord(message) &&
      message['role'] === 'toolResult' &&
      message['toolName'] === 'fusion_brainstorm'
    ) {
      return message;
    }
  }
  throw new Error('persisted session is missing the fusion_brainstorm tool result');
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

async function verifyCurrentHostFusionUsage(): Promise<string> {
  const realPi = resolveRealPiCli();
  if (realPi === undefined)
    throw new Error('BUG-182 current-host Fusion usage test requires pi on PATH');
  const version = run(realPi, ['--version'], root).trim();
  const temp = await mkdtemp(join(tmpdir(), 'pi-bg-current-host-usage-'));
  try {
    const agentDir = join(temp, 'agent');
    const sessionDir = join(temp, 'sessions');
    await Promise.all([
      mkdir(agentDir, { recursive: true }),
      mkdir(sessionDir, { recursive: true }),
    ]);
    const fake = await installFusionFakePi(temp, { mergedText: 'host usage fused answer' });
    const scriptedProviderPath = join(
      root,
      'tests',
      'scripted-provider',
      'scripted-provider-extension.ts',
    );
    const extension = join(root, 'extensions', 'background-tasks.ts');
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...isolatedTestEnv,
      PATH: `${fake.binDir}:${process.env['PATH'] ?? ''}`,
      PI_CODING_AGENT_DIR: agentDir,
      PI_BG_SCRIPTED_API_KEY: 'scripted-api-key',
      PI_BG_SCRIPTED_SCENARIO: 'fusion-brainstorm',
      PI_BG_SCRIPTED_EVENTS: join(temp, 'provider-events.jsonl'),
    };
    const rpcArgs = [
      '--mode',
      'rpc',
      '--no-extensions',
      '-e',
      scriptedProviderPath,
      '-e',
      extension,
      '--offline',
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--session-dir',
      sessionDir,
      '--model',
      'pi-bg-scripted/scripted-model',
    ];
    const stats = await runRpcSessionStats(
      realPi,
      rpcArgs,
      temp,
      env,
      'Use fusion for the current-host usage contract test.',
    );
    const expectedTokens = {
      input: 75,
      output: 45,
      cacheRead: 10,
      cacheWrite: 15,
      total: 145,
    };
    const persistedToolResult = await readPersistedFusionToolResult(stats.sessionFile);
    const persistedUsage = persistedToolResult['usage'];
    const expectedUsage = {
      input: 55,
      output: 35,
      cacheRead: 10,
      cacheWrite: 15,
      totalTokens: 115,
      cost: {
        input: 0.005,
        output: 0.01,
        cacheRead: 0.015,
        cacheWrite: 0.02,
        total: 0.05,
      },
    };
    if (!isDeepStrictEqual(persistedUsage, expectedUsage)) {
      throw new Error(
        `Current Pi ${version} persisted invalid Fusion usage: ${JSON.stringify(persistedUsage)}; toolResult=${JSON.stringify(persistedToolResult).slice(0, 4000)}`,
      );
    }
    if (!isDeepStrictEqual(stats.tokens, expectedTokens)) {
      throw new Error(
        `Current Pi ${version} Fusion stats tokens mismatch: ${JSON.stringify(stats.tokens)}`,
      );
    }
    if (Math.abs(stats.cost - 0.05) > 1e-12) {
      throw new Error(`Current Pi ${version} Fusion stats cost mismatch: ${String(stats.cost)}`);
    }
    const replay = await runRpcSessionStats(
      realPi,
      [...rpcArgs, '--session', stats.sessionFile],
      temp,
      env,
    );
    if (
      !isDeepStrictEqual(replay.tokens, stats.tokens) ||
      Math.abs(replay.cost - stats.cost) > 1e-12
    ) {
      throw new Error(`Current Pi ${version} replayed Fusion session stats do not match`);
    }
    return version;
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

const pack = parsePack(run('npm', ['pack', '--json'], root));
const tarballPath = join(root, pack.filename);
try {
  for (const version of requiredVersions) await smokeVersion(version, tarballPath);
  const currentHostVersion = await verifyCurrentHostFusionUsage();
  console.log(
    `Smoke-loaded pi-background-tasks against Pi ${requiredVersions.join(', ')}; current host ${currentHostVersion} persisted and replayed full Fusion usage`,
  );
} finally {
  await rm(tarballPath, { force: true });
}

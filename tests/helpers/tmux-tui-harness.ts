import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { constants, realpathSync } from 'node:fs';
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isolatedTestEnv } from './normalize.js';

const TMUX_BIN = '/usr/bin/tmux';

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export interface TmuxTuiHarnessOptions {
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export interface TmuxTuiHarness {
  readonly root: string;
  readonly cwd: string;
  readonly home: string;
  readonly agentDir: string;
  readonly sessionDir: string;
  readonly sessionName: string;
  readonly providerEventsPath: string;
  readonly tuiLogPath: string;
  readonly tmuxVersion: string;
  start(startupPattern?: RegExp, timeoutMs?: number): Promise<string>;
  sendText(text: string): void;
  sendKeys(...keys: string[]): void;
  capture(): string;
  captureHistory(): string;
  waitFor(pattern: RegExp, description: string, timeoutMs?: number): Promise<string>;
  cleanup(): Promise<void>;
}

/**
 * Run a real Pi TUI in a dedicated tmux server with an isolated project, HOME,
 * agent directory, session directory, and 80x24 pane.
 */
export async function createTmuxTuiHarness(
  options: TmuxTuiHarnessOptions,
): Promise<TmuxTuiHarness> {
  await access(TMUX_BIN, constants.X_OK);
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-tmux-'));
  const cwd = join(root, 'project');
  const home = join(root, 'home');
  const agentDir = join(root, 'agent');
  const sessionDir = join(root, 'sessions');
  const tmuxTmpDir = join(root, 'tmux');
  const providerEventsPath = join(root, 'provider-events.jsonl');
  const tuiLogPath = join(root, 'tui-ansi.log');
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(agentDir, { recursive: true }),
    mkdir(sessionDir, { recursive: true }),
    mkdir(tmuxTmpDir, { recursive: true }),
  ]);

  const unique = `${String(process.pid)}-${randomUUID().slice(0, 12)}`;
  const sessionName = `pi-bg-tmux-${unique}`;
  const socketName = `pi-bg-tmux-socket-${unique}`;
  const configPath = join(root, 'tmux.conf');
  const launchPath = join(root, 'test-session.sh');
  await writeFile(
    configPath,
    [
      'set -g extended-keys on',
      'set -g status off',
      'set -g exit-empty off',
      'set -g remain-on-exit on',
      'set -g default-terminal tmux-256color',
      '',
    ].join('\n'),
    'utf8',
  );

  const launchEnv: Record<string, string> = {
    ...isolatedTestEnv,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    NPM_CONFIG_CACHE: join(root, 'npm-cache'),
    PI_TUI_WRITE_LOG: tuiLogPath,
    TERM: 'tmux-256color',
    ...options.env,
  };
  const exports = Object.entries(launchEnv).map(
    ([key, value]) => `export ${key}=${shellQuote(value)}`,
  );
  await writeFile(
    launchPath,
    ['#!/usr/bin/env bash', 'set -euo pipefail', ...exports, `exec ${options.command.map(shellQuote).join(' ')}`, ''].join(
      '\n',
    ),
    'utf8',
  );
  await chmod(launchPath, 0o700);

  const tmuxEnv = { ...process.env, HOME: home, TMUX_TMPDIR: tmuxTmpDir };
  const tmux = (args: readonly string[]): string => {
    const result = spawnSync(TMUX_BIN, ['-L', socketName, '-f', configPath, ...args], {
      encoding: 'utf8',
      env: tmuxEnv,
      timeout: 10_000,
    });
    assert.equal(
      result.status,
      0,
      `tmux ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    return result.stdout;
  };

  const versionResult = spawnSync(TMUX_BIN, ['-V'], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(versionResult.status, 0, versionResult.stderr);
  const tmuxVersion = versionResult.stdout.trim();

  tmux(['new-session', '-d', '-s', sessionName, '-x', '80', '-y', '24', '-c', cwd]);
  assert.equal(tmux(['display-message', '-p', '-t', sessionName, '#{pane_width}x#{pane_height}']).trim(), '80x24');
  assert.equal(tmux(['show-options', '-gv', 'extended-keys']).trim(), 'on');

  const sendText = (text: string): void => {
    tmux(['send-keys', '-t', sessionName, '-l', '--', text]);
  };
  const sendKeys = (...keys: string[]): void => {
    tmux(['send-keys', '-t', sessionName, ...keys]);
  };
  const capture = (): string => tmux(['capture-pane', '-t', sessionName, '-p']).replace(/\r/g, '');
  const captureHistory = (): string =>
    tmux(['capture-pane', '-t', sessionName, '-p', '-S', '-']).replace(/\r/g, '');
  const waitFor = async (
    pattern: RegExp,
    description: string,
    timeoutMs = 10_000,
  ): Promise<string> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      const screen = captureHistory();
      pattern.lastIndex = 0;
      if (pattern.test(screen)) return screen;
      await delay(50);
    }
    throw new Error(`Timed out waiting for ${description}\n${capture()}`);
  };

  return {
    root,
    cwd,
    home,
    agentDir,
    sessionDir,
    sessionName,
    providerEventsPath,
    tuiLogPath,
    tmuxVersion,
    async start(startupPattern = /\(auto\)/, timeoutMs = 12_000): Promise<string> {
      sendText(launchPath);
      sendKeys('Enter');
      await delay(300);
      const screen = await waitFor(startupPattern, 'Pi TUI startup', timeoutMs);
      await delay(600);
      return screen;
    },
    sendText,
    sendKeys,
    capture,
    captureHistory,
    waitFor,
    async cleanup(): Promise<void> {
      tmux(['kill-session', '-t', sessionName]);
      tmux(['kill-server']);
      await rm(root, { recursive: true, force: true });
    },
  };
}

export function resolveRealPiBinary(): string {
  const piPath = join(dirname(realpathSync(process.execPath)), 'pi');
  return realpathSync(piPath);
}

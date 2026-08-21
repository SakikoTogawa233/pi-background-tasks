import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { isolatedTestEnv, stripAnsi } from './normalize.js';

const expectBin = '/usr/bin/expect';
const backgroundExtensionPath = resolve('extensions/background-tasks.ts');

export const PTY_SKIP_REASON =
  'interactive stdin is not deliverable to a raw-mode Node TUI via /usr/bin/expect on this host ' +
  '(verified: a plain `cat` receives input but a Node process.stdin reader does not). ' +
  'Run `npm run test:pty` on a host/CI where Node TTY stdin works under the PTY driver.';

function tclQuote(value: string): string {
  return `{${value.replace(/}/g, '\\}')}}`;
}

let ptyInputProbe: Promise<boolean> | undefined;

/**
 * Probe the exact Node raw-stdin shape used by Pi under Expect. The result is
 * cached so all PTY suites preserve the same host capability skip.
 */
export function ptyInputSupported(): Promise<boolean> {
  ptyInputProbe ??= probePtyInput();
  return ptyInputProbe;
}

async function probePtyInput(): Promise<boolean> {
  if (process.platform === 'win32') return false;
  if (!existsSync(expectBin)) return false;
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-pty-probe-'));
  try {
    const reader = join(root, 'reader.cjs');
    await writeFile(
      reader,
      [
        'process.stdin.setEncoding("utf8");',
        'if (process.stdin.setRawMode) process.stdin.setRawMode(true);',
        'process.stdin.resume();',
        'process.stdin.on("data", (d) => { if (d.includes("Z")) { process.stdout.write("PTYPROBE_OK\\n"); process.exit(0); } });',
        'process.stdout.write("PTYPROBE_READY\\n");',
      ].join('\n'),
      'utf8',
    );
    const script = join(root, 'probe.expect');
    await writeFile(
      script,
      [
        'set timeout 6',
        `spawn -noecho ${tclQuote(process.execPath)} ${tclQuote(reader)}`,
        'expect { -re "PTYPROBE_READY" {} timeout { exit 2 } }',
        'after 300',
        'send "Z"',
        'expect { -re "PTYPROBE_OK" { exit 0 } timeout { exit 3 } }',
      ].join('\n'),
      'utf8',
    );
    const result = spawnSync(expectBin, [script], { encoding: 'utf8', timeout: 12_000 });
    return result.status === 0 && result.stdout.includes('PTYPROBE_OK');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export interface RunExpectOptions {
  size?: { rows: number; cols: number } | undefined;
  extensionPaths?: readonly string[] | undefined;
  model?: string | undefined;
  env?: Readonly<Record<string, string>> | undefined;
}

/** Run a real Pi TUI in an isolated cwd/HOME/session under Expect. */
export async function runExpect(
  body: string,
  timeoutSeconds = 35,
  size?: { rows: number; cols: number },
  options: RunExpectOptions = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-pty-'));
  const cwd = join(root, 'project');
  await mkdir(cwd, { recursive: true });
  const script = join(root, 'scenario.expect');
  const requestedSize = options.size ?? size;
  const sttyInit = requestedSize
    ? `set stty_init {rows ${String(requestedSize.rows)} columns ${String(requestedSize.cols)}}\n`
    : '';
  const extensionArgs = (options.extensionPaths ?? [backgroundExtensionPath])
    .map((path) => `-e ${tclQuote(path)}`)
    .join(' ');
  const modelArg = options.model === undefined ? '' : ` --model ${tclQuote(options.model)}`;
  const optionEnv = Object.entries(options.env ?? {})
    .map(([key, value]) => `set env(${key}) ${tclQuote(value)}`)
    .join('\n');
  const content = `
set timeout ${String(timeoutSeconds)}
${sttyInit}`;
  const tail = `
set env(PI_OFFLINE) "${isolatedTestEnv.PI_OFFLINE}"
set env(PI_SKIP_VERSION_CHECK) "${isolatedTestEnv.PI_SKIP_VERSION_CHECK}"
set env(PI_TELEMETRY) "${isolatedTestEnv.PI_TELEMETRY}"
set env(CI) "${isolatedTestEnv.CI}"
set env(PI_CODING_AGENT_DIR) ${tclQuote(join(root, 'agent'))}
set env(PI_CODING_AGENT_SESSION_DIR) ${tclQuote(join(root, 'sessions'))}
set env(NPM_CONFIG_CACHE) "/tmp/pi-npm-cache"
set env(TERM) "xterm-256color"
${optionEnv}
spawn -noecho /usr/local/bin/pi --offline --no-session --no-extensions ${extensionArgs} --no-skills --no-prompt-templates --no-context-files --no-tools${modelArg}
expect {
  -re {\\[\\?u} { send "\\033\\[?0u"; exp_continue }
  -re {\\[c} { send "\\033\\[?1;2c"; exp_continue }
  -re {\\(auto\\)} {}
  timeout { puts "INITIAL_PROMPT_TIMEOUT"; exit 2 }
}
after 600
${body}
send "\\003"
after 500
exit 0
`;
  await writeFile(script, content + tail, 'utf8');
  try {
    const result = spawnSync(expectBin, [script], {
      cwd,
      encoding: 'utf8',
      timeout: (timeoutSeconds + 5) * 1000,
    });
    const output = `${result.stdout}\n${result.stderr}`;
    assert.equal(result.status, 0, stripAnsi(output));
    return stripAnsi(output).replace(/\r/g, '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

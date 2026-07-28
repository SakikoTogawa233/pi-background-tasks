import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isolatedTestEnv } from '../src/testing/normalize.js';

const root = new URL('../', import.meta.url).pathname;
const agentDir = await mkdtemp(join(tmpdir(), 'pi-bg-smoke-agent-'));
try {
  const result = spawnSync(
    'pi',
    [
      '--no-extensions',
      '-e',
      './extensions/background-tasks.ts',
      '--offline',
      '--no-tools',
      '--no-session',
      '-p',
      '/jobs',
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        ...isolatedTestEnv,
        PI_CODING_AGENT_DIR: agentDir,
        PI_CODING_AGENT_SESSION_DIR: join(agentDir, 'sessions'),
        NPM_CONFIG_CACHE: process.env['NPM_CONFIG_CACHE'] ?? '/tmp/pi-npm-cache',
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(`pi smoke failed\n${result.stdout}\n${result.stderr}`);
  }
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
} finally {
  await rm(agentDir, { recursive: true, force: true });
}

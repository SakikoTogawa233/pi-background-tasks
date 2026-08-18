/**
 * Real-Windows integration coverage.
 *
 * These cases assert behaviour that CANNOT be proven on POSIX with injected
 * seams: npm `.cmd` shim avoidance, cmd.exe quoting and metacharacter
 * handling, PATHEXT resolution, process-tree teardown of grandchildren, and
 * single-handle fsync durability on NTFS.
 *
 * This suite deliberately FAILS when executed off Windows rather than
 * skipping, so a green run can never be mistaken for Windows evidence.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { BgTask } from '../../src/core/common.js';
import type {
  BackgroundTaskChildProcess,
  BackgroundTaskContext,
  BackgroundTaskRegistry,
} from '../../src/core/registry.js';
import { replaceFileDurable, writeFileDurable } from '../../src/core/durable-fs.js';

const isWindows = process.platform === 'win32';

function requireWindows(): void {
  assert.equal(
    process.platform,
    'win32',
    `the Windows integration suite must run on Windows; saw ${process.platform}. ` +
      'Run it through the windows-latest CI job (npm run test:windows).',
  );
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-bg-win-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface AdoptRunningChildOptions {
  command: string;
  name?: string;
  startedAt?: number;
  notifyOnCompletion?: boolean;
  triggerOnCompletion?: boolean;
}

type AdoptRunningChild = (
  ctx: BackgroundTaskContext,
  child: BackgroundTaskChildProcess,
  options: AdoptRunningChildOptions,
) => BgTask;

function adoptRunningChild(
  registry: BackgroundTaskRegistry,
  ctx: BackgroundTaskContext,
  child: BackgroundTaskChildProcess,
  options: AdoptRunningChildOptions,
): BgTask {
  const method = (registry as BackgroundTaskRegistry & { adoptRunningChild?: AdoptRunningChild })
    .adoptRunningChild;
  assert.ok(method, 'BackgroundTaskRegistry.adoptRunningChild is missing');
  return method.call(registry, ctx, child, options);
}

/** True while a PID is still visible to tasklist. */
function processExists(pid: number): boolean {
  const result = spawnSync(
    join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tasklist.exe'),
    ['/FI', `PID eq ${String(pid)}`, '/NH'],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.status !== 0) return false;
  return result.stdout.includes(String(pid));
}

void describe('windows integration', { concurrency: false }, () => {
  void it('runs on Windows', () => {
    requireWindows();
  });

  void it('writes terminal metadata durably on NTFS through a single writable handle', async () => {
    requireWindows();
    await withTempDir(async (dir) => {
      // The exact shape that previously failed with
      // "EPERM: operation not permitted, fsync" on Windows.
      const target = join(dir, 'metadata.json');
      await replaceFileDurable(target, `${JSON.stringify({ status: 'completed' }, null, 2)}\n`);
      const parsed: unknown = JSON.parse(await readFile(target, 'utf8'));
      assert.deepEqual(parsed, { status: 'completed' });

      // Repeated replacement must keep working (manifest-style rewrites).
      await replaceFileDurable(target, `${JSON.stringify({ status: 'killed' }, null, 2)}\n`);
      const second: unknown = JSON.parse(await readFile(target, 'utf8'));
      assert.deepEqual(second, { status: 'killed' });

      const output = join(dir, 'task.output');
      await writeFileDurable(output, 'first');
      await writeFileDurable(output, 'second');
      assert.equal(await readFile(output, 'utf8'), 'second');
      assert.ok((await stat(output)).isFile());
    });
  });

  void it('launches the Pi CLI through node without touching the npm .cmd shim', async () => {
    requireWindows();
    const { resolvePiLaunch, piLaunchArgv } = await import('../../src/core/pi-launch.js');
    const launch = resolvePiLaunch();
    // Never execute a batch shim: cmd/bat/ps1 cannot preserve argv safely.
    assert.doesNotMatch(launch.executable.toLowerCase(), /\.(?:cmd|bat|ps1)$/);
    assert.equal(launch.executable, process.execPath);
    const argv = piLaunchArgv(launch, ['--version']);
    const result = spawnSync(launch.executable, argv, {
      encoding: 'utf8',
      windowsHide: true,
      shell: false,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.trim(), /\d+\.\d+\.\d+/);
  });

  void it('passes shell metacharacters through structured argv without executing them', async () => {
    requireWindows();
    await withTempDir(async (dir) => {
      const sentinel = join(dir, 'pwned.txt');
      const script = join(dir, 'echo-argv.cjs');
      await writeFile(
        script,
        'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n',
        'utf8',
      );
      // Should some layer re-parse argv through cmd.exe, `&` would run a command
      // and the sentinel file would appear.
      const hostile = `& echo pwned > "${sentinel}"`;
      const result = spawnSync(process.execPath, [script, hostile, '%PATH%', 'a"b\\c'], {
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
      });
      assert.equal(result.status, 0, result.stderr);
      const received: unknown = JSON.parse(result.stdout);
      assert.deepEqual(received, [hostile, '%PATH%', 'a"b\\c']);
      await assert.rejects(stat(sentinel), 'no shell operator may execute');
    });
  });

  void it('keeps cmd.exe as the default dialect and honours the documented bash opt-in', async () => {
    requireWindows();
    const { shellInvocation } = await import('../../src/core/common.js');
    const fallback = shellInvocation('echo ok', 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' });
    assert.equal(fallback.dialect, 'cmd');
    assert.deepEqual(fallback.args.slice(0, 3), ['/d', '/s', '/c']);
    // A generic SHELL value must never silently switch the command language.
    const ignoresShell = shellInvocation('echo ok', 'win32', {
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      SHELL: '/bin/bash',
    });
    assert.equal(ignoresShell.dialect, 'cmd');

    const bashPath = process.env['PI_BG_TEST_BASH'];
    assert.ok(bashPath, 'PI_BG_TEST_BASH must point at Git Bash in Windows CI');
    const opted = shellInvocation('echo ok', 'win32', {
      ComSpec: 'C:\\Windows\\System32\\cmd.exe',
      PI_BG_SHELL: 'bash',
      PI_BG_SHELL_PATH: bashPath,
    });
    assert.equal(opted.dialect, 'posix');
    // -c, never -lc: a login shell would inject profile banners into output.
    assert.deepEqual(opted.args, ['-c', 'echo ok']);
  });

  void it('runs a non-login bash so profile banners cannot pollute captured output', async () => {
    requireWindows();
    const bashPath = process.env['PI_BG_TEST_BASH'];
    assert.ok(bashPath, 'PI_BG_TEST_BASH must point at Git Bash in Windows CI');
    await withTempDir(async (home) => {
      await writeFile(join(home, '.bash_profile'), 'echo PROFILE_BANNER\n', 'utf8');
      const result = spawnSync(bashPath, ['-c', 'echo REAL_OUTPUT'], {
        encoding: 'utf8',
        windowsHide: true,
        shell: false,
        env: { ...process.env, HOME: home },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /REAL_OUTPUT/);
      assert.doesNotMatch(result.stdout, /PROFILE_BANNER/);
    });
  });

  void it('terminates a grandchild process tree with taskkill', async () => {
    requireWindows();
    const { runWindowsTaskkill } = await import('../../src/core/windows-taskkill.js');
    await withTempDir(async (dir) => {
      const grandchild = join(dir, 'grandchild.cjs');
      const parent = join(dir, 'parent.cjs');
      const pidFile = join(dir, 'grandchild.pid');
      await writeFile(
        grandchild,
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
          'setInterval(() => {}, 1000);\n',
        'utf8',
      );
      await writeFile(
        parent,
        `const { spawn } = require('node:child_process');\n` +
          `spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore' });\n` +
          'setInterval(() => {}, 1000);\n',
        'utf8',
      );
      const child = spawn(process.execPath, [parent], { stdio: 'ignore', windowsHide: true });
      const parentPid = child.pid;
      assert.ok(parentPid, 'parent pid should exist');

      let grandchildPid = 0;
      for (let attempt = 0; attempt < 100 && grandchildPid === 0; attempt++) {
        await sleep(50);
        try {
          grandchildPid = Number.parseInt(await readFile(pidFile, 'utf8'), 10);
        } catch {
          grandchildPid = 0;
        }
      }
      assert.ok(grandchildPid > 0, 'grandchild should report its pid');
      assert.ok(processExists(grandchildPid), 'grandchild should be running before the kill');

      const outcome = await runWindowsTaskkill(parentPid, 'force');
      assert.equal(outcome.exitCode, 0, outcome.stderr);

      let grandchildGone = false;
      for (let attempt = 0; attempt < 100 && !grandchildGone; attempt++) {
        await sleep(50);
        grandchildGone = !processExists(grandchildPid);
      }
      // Root-only child.kill() would leave this descendant alive.
      assert.ok(grandchildGone, 'taskkill /T /F must remove the whole process tree');
    });
  });

  void it('stops an adopted parent and its grandchild through the registry taskkill tree route', async () => {
    requireWindows();
    const { BackgroundTaskRegistry } = await import('../../src/core/registry.js');
    assert.ok(
      (BackgroundTaskRegistry.prototype as { adoptRunningChild?: AdoptRunningChild })
        .adoptRunningChild,
      'BackgroundTaskRegistry.adoptRunningChild is missing',
    );
    await withTempDir(async (dir) => {
      const grandchild = join(dir, 'adopted-grandchild.cjs');
      const parent = join(dir, 'adopted-parent.cjs');
      const pidFile = join(dir, 'adopted-grandchild.pid');
      await writeFile(
        grandchild,
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));\n` +
          'setInterval(() => {}, 1000);\n',
        'utf8',
      );
      await writeFile(
        parent,
        `const { spawn } = require('node:child_process');\n` +
          `spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore' });\n` +
          'setInterval(() => {}, 1000);\n',
        'utf8',
      );
      const child = spawn(process.execPath, [parent], { stdio: 'ignore', windowsHide: true });
      const parentPid = child.pid;
      assert.ok(parentPid, 'adopted parent pid should exist');

      let grandchildPid = 0;
      for (let attempt = 0; attempt < 100 && grandchildPid === 0; attempt++) {
        await sleep(50);
        try {
          grandchildPid = Number.parseInt(await readFile(pidFile, 'utf8'), 10);
        } catch {
          grandchildPid = 0;
        }
      }
      assert.ok(grandchildPid > 0, 'adopted grandchild should report its pid');
      assert.ok(processExists(grandchildPid), 'adopted grandchild should be running before stopTask');

      const registry = new BackgroundTaskRegistry({
        sendCompletionNotification: () => {},
        logger: { error: () => {} },
      });
      const ctx: BackgroundTaskContext = {
        cwd: dir,
        sessionId: 'windows-adopt-integration',
        modelRegistry: { getAll: () => [] },
        model: undefined,
      };
      await registry.ensureRuntimeDir(ctx);
      const task = adoptRunningChild(registry, ctx, child, {
        command: `${process.execPath} ${parent}`,
        name: 'Adopted Windows Process Tree',
      });
      await registry.stopTask(task, 'user');
      assert.equal(task.status, 'killed');

      let grandchildGone = false;
      for (let attempt = 0; attempt < 100 && !grandchildGone; attempt++) {
        await sleep(50);
        grandchildGone = !processExists(grandchildPid);
      }
      assert.ok(grandchildGone, 'registry.stopTask must remove the adopted process tree');
    });
  });

  void it('tolerates taskkill against an already-exited process', async () => {
    requireWindows();
    const { runWindowsTaskkill } = await import('../../src/core/windows-taskkill.js');
    const child = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const pid = child.pid;
    assert.ok(pid);
    await new Promise<void>((resolve) => {
      child.once('close', () => {
        resolve();
      });
    });
    const outcome = await runWindowsTaskkill(pid, 'force');
    // 128 means "process not found" and is a benign race, not a failure.
    assert.ok(
      outcome.exitCode === 0 || outcome.exitCode === 128,
      `unexpected taskkill exit code ${String(outcome.exitCode)}: ${outcome.stderr}`,
    );
  });

  void it('keeps the event loop responsive while taskkill runs', async () => {
    requireWindows();
    const { runWindowsTaskkill } = await import('../../src/core/windows-taskkill.js');
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const pid = child.pid;
    assert.ok(pid);
    let ticks = 0;
    const heartbeat = setInterval(() => {
      ticks += 1;
    }, 5);
    try {
      await runWindowsTaskkill(pid, 'force');
    } finally {
      clearInterval(heartbeat);
    }
    // A synchronous spawnSync helper would starve the loop entirely.
    assert.ok(ticks > 0, 'taskkill must not block the event loop');
  });
});

if (!isWindows) {
  // Make the off-Windows failure obvious even before assertions run.
  console.error(
    `[windows-integration] this suite requires Windows; current platform is ${process.platform}.`,
  );
}

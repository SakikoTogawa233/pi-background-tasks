import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import type { BgTask } from '../../src/core/common.js';
import {
  BackgroundTaskRegistry,
  type BackgroundTaskChildProcess,
  type BackgroundTaskContext,
  type BackgroundTaskSpawn,
} from '../../src/core/registry.js';
import type { TaskkillOutcome, WindowsKillPhase } from '../../src/core/windows-taskkill.js';

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

class FakeChild extends EventEmitter implements BackgroundTaskChildProcess {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly killCalls: Array<NodeJS.Signals | undefined> = [];

  constructor(readonly pid: number | undefined) {
    super();
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killCalls.push(signal);
    throw new Error('Windows adopted tasks must never call child.kill');
  }

  writeStdout(value: string): void {
    this.stdout.emit('data', Buffer.from(value, 'utf8'));
  }

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.emit('close', code, signal);
  }
}

interface KillTreeCall {
  pid: number;
  phase: WindowsKillPhase;
  signal: AbortSignal | undefined;
}

interface HarnessOptions {
  killTree: (
    pid: number,
    phase: WindowsKillPhase,
    signal?: AbortSignal,
  ) => Promise<TaskkillOutcome>;
  maxOutputBytes?: number;
  killGraceMs?: number;
  stopWaitMs?: number;
}

interface Harness {
  root: string;
  ctx: BackgroundTaskContext;
  registry: BackgroundTaskRegistry;
  children: Map<number, FakeChild>;
  spawned: FakeChild[];
  processKills: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }>;
}

function taskkillOutcome(exitCode = 0, stderr = ''): TaskkillOutcome {
  return {
    exitCode,
    signal: null,
    stdout: '',
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function adoptRunningChild(
  registry: BackgroundTaskRegistry,
  ctx: BackgroundTaskContext,
  child: FakeChild,
  options: AdoptRunningChildOptions,
): BgTask {
  const method = (registry as BackgroundTaskRegistry & { adoptRunningChild?: AdoptRunningChild })
    .adoptRunningChild;
  assert.ok(method, 'BackgroundTaskRegistry.adoptRunningChild is missing');
  return method.call(registry, ctx, child, options);
}

async function createHarness(options: HarnessOptions): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-win-adopt-'));
  const cwd = join(root, 'project');
  await mkdir(cwd, { recursive: true });
  const children = new Map<number, FakeChild>();
  const spawned: FakeChild[] = [];
  const processKills: Harness['processKills'] = [];
  let pid = 9100;
  let id = 0;
  const spawn: BackgroundTaskSpawn = () => {
    const child = new FakeChild(++pid);
    children.set(pid, child);
    spawned.push(child);
    return child;
  };
  const registry = new BackgroundTaskRegistry({
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    spawn,
    makeTaskId: () => `bwinadopt${String(++id).padStart(2, '0')}`,
    killProcess: (targetPid, signal) => {
      processKills.push({ pid: targetPid, signal });
      throw new Error('Windows tasks must never use process.kill');
    },
    killTree: options.killTree,
    maxOutputBytes: options.maxOutputBytes ?? 20 * 1024 * 1024,
    killGraceMs: options.killGraceMs ?? 20,
    stopWaitMs: options.stopWaitMs ?? 750,
    sendCompletionNotification: () => {},
    logger: { error: () => {} },
  });
  const ctx: BackgroundTaskContext = {
    cwd,
    sessionId: 'windows-adopt-routing',
    modelRegistry: { getAll: () => [] },
    model: undefined,
  };
  await registry.ensureRuntimeDir(ctx);
  return { root, ctx, registry, children, spawned, processKills };
}

function registerChild(h: Harness, pid: number): FakeChild {
  const child = new FakeChild(pid);
  h.children.set(pid, child);
  return child;
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

void describe('adopted task Windows kill routing', () => {
  void it('uses taskkill tree terminate for a soft stop and no POSIX or child fallback', async () => {
    const calls: KillTreeCall[] = [];
    let child!: FakeChild;
    const h = await createHarness({
      killTree: (pid, phase, signal) => {
        calls.push({ pid, phase, signal });
        queueMicrotask(() => {
          child.close(null, 'SIGTERM');
        });
        return Promise.resolve(taskkillOutcome());
      },
    });
    try {
      child = registerChild(h, 9201);
      const task = adoptRunningChild(h.registry, h.ctx, child, {
        command: 'npm run dev',
      });
      await h.registry.stopTask(task, 'user');

      assert.deepEqual(
        calls.map(({ pid, phase }) => ({ pid, phase })),
        [{ pid: 9201, phase: 'terminate' }],
      );
      assert.ok(calls[0]?.signal instanceof AbortSignal);
      assert.deepEqual(h.processKills, []);
      assert.deepEqual(child.killCalls, []);
      assert.equal(task.status, 'killed');
    } finally {
      await rm(h.root, { recursive: true, force: true });
    }
  });

  void it('escalates an adopted task from tree terminate to tree force', async () => {
    const calls: KillTreeCall[] = [];
    let child!: FakeChild;
    const h = await createHarness({
      killGraceMs: 15,
      killTree: (pid, phase, signal) => {
        calls.push({ pid, phase, signal });
        if (phase === 'terminate') return new Promise<TaskkillOutcome>(() => {});
        queueMicrotask(() => {
          child.close(null, 'SIGKILL');
        });
        return Promise.resolve(taskkillOutcome());
      },
    });
    try {
      child = registerChild(h, 9202);
      const task = adoptRunningChild(h.registry, h.ctx, child, {
        command: 'npm test -- --watch',
      });
      await h.registry.stopTask(task, 'user');

      assert.deepEqual(
        calls.map(({ pid, phase }) => ({ pid, phase })),
        [
          { pid: 9202, phase: 'terminate' },
          { pid: 9202, phase: 'force' },
        ],
      );
      assert.equal(calls[0]?.signal?.aborted, true);
      assert.equal(calls[1]?.signal, undefined);
      assert.deepEqual(h.processKills, []);
      assert.deepEqual(child.killCalls, []);
      assert.equal(task.status, 'killed');
    } finally {
      await rm(h.root, { recursive: true, force: true });
    }
  });

  void it('never falls back after a soft taskkill failure and still force-terminates the tree', async () => {
    const calls: KillTreeCall[] = [];
    let child!: FakeChild;
    const h = await createHarness({
      killGraceMs: 15,
      killTree: (pid, phase, signal) => {
        calls.push({ pid, phase, signal });
        if (phase === 'terminate') return Promise.resolve(taskkillOutcome(5, 'access denied'));
        queueMicrotask(() => {
          child.close(null, 'SIGKILL');
        });
        return Promise.resolve(taskkillOutcome());
      },
    });
    try {
      child = registerChild(h, 9203);
      const task = adoptRunningChild(h.registry, h.ctx, child, {
        command: 'node server.js',
      });
      await h.registry.stopTask(task, 'user');

      assert.deepEqual(calls.map((call) => call.phase), ['terminate', 'force']);
      assert.match(task.error ?? '', /access denied/);
      assert.deepEqual(h.processKills, []);
      assert.deepEqual(child.killCalls, []);
    } finally {
      await rm(h.root, { recursive: true, force: true });
    }
  });

  void it('stopAllRunning uses taskkill tree routing for mixed normal and adopted tasks', async () => {
    const calls: KillTreeCall[] = [];
    let h!: Harness;
    h = await createHarness({
      killTree: (pid, phase, signal) => {
        calls.push({ pid, phase, signal });
        const child = h.children.get(pid);
        assert.ok(child, `missing child for pid ${String(pid)}`);
        queueMicrotask(() => {
          child.close(null, 'SIGTERM');
        });
        return Promise.resolve(taskkillOutcome());
      },
    });
    try {
      const normal = await h.registry.startTask(h.ctx, 'node normal-task.js', {
        name: 'Normal Task',
      });
      const adoptedChild = registerChild(h, 9204);
      const adopted = adoptRunningChild(h.registry, h.ctx, adoptedChild, {
        command: 'node adopted-task.js',
        name: 'Adopted Task',
      });

      const result = await h.registry.stopAllRunning('user');
      assert.deepEqual(result, { stopped: 2, failures: [] });
      assert.equal(normal.status, 'killed');
      assert.equal(adopted.status, 'killed');
      assert.deepEqual(
        calls.map(({ pid, phase }) => ({ pid, phase })).sort((a, b) => a.pid - b.pid),
        [
          { pid: 9101, phase: 'terminate' },
          { pid: 9204, phase: 'terminate' },
        ],
      );
      assert.deepEqual(h.processKills, []);
      assert.deepEqual(h.spawned[0]?.killCalls, []);
      assert.deepEqual(adoptedChild.killCalls, []);
    } finally {
      await rm(h.root, { recursive: true, force: true });
    }
  });

  void it('routes adopted-task output-cap termination through taskkill tree', async () => {
    const calls: KillTreeCall[] = [];
    let child!: FakeChild;
    const h = await createHarness({
      maxOutputBytes: 8,
      killTree: (pid, phase, signal) => {
        calls.push({ pid, phase, signal });
        queueMicrotask(() => {
          child.close(null, 'SIGTERM');
        });
        return Promise.resolve(taskkillOutcome());
      },
    });
    try {
      child = registerChild(h, 9205);
      const task = adoptRunningChild(h.registry, h.ctx, child, {
        command: 'yes adopted-output',
      });
      child.writeStdout('0123456789abcdef');
      await waitFor(() => task.status === 'failed', 'adopted output-cap finalization');

      assert.equal(task.killKind, 'output_cap');
      assert.match(task.error ?? '', /Output exceeded cap/);
      assert.deepEqual(
        calls.map(({ pid, phase }) => ({ pid, phase })),
        [{ pid: 9205, phase: 'terminate' }],
      );
      assert.deepEqual(h.processKills, []);
      assert.deepEqual(child.killCalls, []);
    } finally {
      await rm(h.root, { recursive: true, force: true });
    }
  });

  void it('reports a missing adopted PID without invoking any kill fallback', async () => {
    const calls: KillTreeCall[] = [];
    const h = await createHarness({
      killTree: (pid, phase, signal) => {
        calls.push({ pid, phase, signal });
        return Promise.resolve(taskkillOutcome());
      },
    });
    try {
      const child = new FakeChild(undefined);
      const task = adoptRunningChild(h.registry, h.ctx, child, {
        command: 'node missing-pid.js',
      });
      await assert.rejects(() => h.registry.stopTask(task, 'user'), /no process id/i);
      assert.equal(task.status, 'running');
      assert.deepEqual(calls, []);
      assert.deepEqual(h.processKills, []);
      assert.deepEqual(child.killCalls, []);
    } finally {
      await rm(h.root, { recursive: true, force: true });
    }
  });
});

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import type { BgTask, BgTaskSnapshot } from '../../src/core/common.js';
import {
  BackgroundTaskRegistry,
  type BackgroundTaskChildProcess,
  type BackgroundTaskContext,
  type CompletionNotificationMessage,
  type CompletionNotificationOptions,
} from '../../src/core/registry.js';
import type { TaskkillOutcome, WindowsKillPhase } from '../../src/core/windows-taskkill.js';
import {
  BackgroundTasksManager,
  type TaskManagerTheme,
} from '../../src/ui/background-tasks-manager.js';
import { stripAnsi } from '../helpers/normalize.js';

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

  constructor(readonly pid: number) {
    super();
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killCalls.push(signal);
    return true;
  }

  writeStdout(value: string): void {
    this.stdout.emit('data', Buffer.from(value, 'utf8'));
  }

  writeStderr(value: string): void {
    this.stderr.emit('data', Buffer.from(value, 'utf8'));
  }

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.emit('close', code, signal);
  }

  fail(error: Error): void {
    this.emit('error', error);
  }
}

interface KillTreeCall {
  pid: number;
  phase: WindowsKillPhase;
  signal: AbortSignal | undefined;
}

interface Harness {
  root: string;
  ctx: BackgroundTaskContext;
  registry: BackgroundTaskRegistry;
  children: Map<number, FakeChild>;
  changes: BgTaskSnapshot[][];
  notifications: Array<{
    message: CompletionNotificationMessage;
    options: CompletionNotificationOptions;
  }>;
  terminals: BgTaskSnapshot[];
  processKills: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }>;
  killTreeCalls: KillTreeCall[];
}

const theme: TaskManagerTheme = {
  fg: (_color, text) => text,
};

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

function taskkillOutcome(): TaskkillOutcome {
  return {
    exitCode: 0,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

async function createHarness(platform: 'linux' | 'win32'): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-adopted-component-'));
  const cwd = join(root, 'project');
  await mkdir(cwd, { recursive: true });
  const children = new Map<number, FakeChild>();
  const changes: BgTaskSnapshot[][] = [];
  const notifications: Harness['notifications'] = [];
  const terminals: BgTaskSnapshot[] = [];
  const processKills: Harness['processKills'] = [];
  const killTreeCalls: KillTreeCall[] = [];
  let id = 0;
  let registry!: BackgroundTaskRegistry;
  registry = new BackgroundTaskRegistry({
    platform,
    makeTaskId: () => `badopt${String(++id).padStart(2, '0')}`,
    onChange: () => {
      changes.push(registry.allTasks().map((task) => registry.snapshot(task)));
    },
    sendCompletionNotification: (message, options) => {
      notifications.push({ message, options });
    },
    publishTerminal: (task) => {
      terminals.push(task);
    },
    killProcess: (pid, signal) => {
      processKills.push({ pid, signal });
      const child = children.get(Math.abs(pid));
      assert.ok(child, `missing fake child for pid ${String(pid)}`);
      queueMicrotask(() => {
        child.close(null, signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM');
      });
      return true;
    },
    killTree: (pid, phase, signal) => {
      killTreeCalls.push({ pid, phase, signal });
      const child = children.get(pid);
      assert.ok(child, `missing fake child for pid ${String(pid)}`);
      queueMicrotask(() => {
        child.close(null, phase === 'force' ? 'SIGKILL' : 'SIGTERM');
      });
      return Promise.resolve(taskkillOutcome());
    },
    killGraceMs: 20,
    stopWaitMs: 500,
    logger: { error: () => {} },
  });
  const ctx: BackgroundTaskContext = {
    cwd,
    sessionId: 'adopted-component',
    modelRegistry: { getAll: () => [] },
    model: undefined,
  };
  await registry.ensureRuntimeDir(ctx);
  return {
    root,
    ctx,
    registry,
    children,
    changes,
    notifications,
    terminals,
    processKills,
    killTreeCalls,
  };
}

function fakeChild(h: Harness, pid: number): FakeChild {
  const child = new FakeChild(pid);
  h.children.set(pid, child);
  return child;
}

function createManager(h: Harness, initialTaskId?: string) {
  const seen = new Set<string>();
  let renders = 0;
  const options: ConstructorParameters<typeof BackgroundTasksManager>[3] = {
    getTasks: () => h.registry.allTasks(),
    stopTask: async (task) => {
      await h.registry.stopTask(h.registry.resolveTask(task.id), 'user');
    },
    stopAllRunning: () => h.registry.stopAllRunning('user'),
    rerunTask: () => Promise.reject(new Error('rerun is outside this adoption test')),
    showOutputPath: () => {},
    markSeen: (id) => {
      seen.add(id);
    },
    markFinishedSeen: (ids) => {
      for (const id of ids) seen.add(id);
    },
    isSeen: (id) => seen.has(id),
  };
  if (initialTaskId !== undefined) options.initialTaskId = initialTaskId;
  const manager = new BackgroundTasksManager(
    {
      requestRender: () => {
        renders += 1;
      },
    },
    theme,
    () => {},
    options,
  );
  return {
    manager,
    seen,
    get renders() {
      return renders;
    },
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

async function outputContains(task: BgTask, text: string): Promise<boolean> {
  return (await readFile(task.outputAbsPath, 'utf8')).includes(text);
}

function terminalCount(h: Harness, taskId: string): number {
  return h.terminals.filter((task) => task.id === taskId).length;
}

function notificationCount(h: Harness, taskId: string): number {
  return h.notifications.filter((entry) => entry.message.details.id === taskId).length;
}

void describe('adopted task registry/UI integration', () => {
  void it('registers an adopted child, exposes ordinary snapshots, and keeps its detail log continuous', async () => {
    const h = await createHarness('linux');
    try {
      const child = fakeChild(h, 8101);
      const task = adoptRunningChild(h.registry, h.ctx, child, {
        command: 'npm run dev',
        name: 'Adopted Dev Server',
        startedAt: 1_800_000_000_000,
      });

      assert.equal(h.registry.allTasks().length, 1);
      assert.equal(h.registry.allTasks()[0], task);
      const adoptedSnapshot = h.registry.snapshot(task);
      assert.equal(adoptedSnapshot.id, task.id);
      assert.equal(adoptedSnapshot.name, 'Adopted Dev Server');
      assert.equal(adoptedSnapshot.command, 'npm run dev');
      assert.equal(adoptedSnapshot.status, 'running');
      assert.equal(adoptedSnapshot.outputPath, task.outputPath);
      assert.equal(adoptedSnapshot.cwd, h.ctx.cwd);
      assert.equal(adoptedSnapshot.startTime, 1_800_000_000_000);
      assert.equal(adoptedSnapshot.pid, 8101);
      assert.equal(adoptedSnapshot.bytesWritten, 0);
      assert.equal(adoptedSnapshot.isAgent, false);
      assert.equal(adoptedSnapshot.notifyOnCompletion, true);
      assert.equal(adoptedSnapshot.triggerOnCompletion, true);
      assert.equal('source' in adoptedSnapshot, false, 'snapshots must not expose a UI source branch');
      assert.equal(h.changes.length, 1, 'adoption must emit onChange');
      assert.equal(h.changes[0]?.[0]?.status, 'running');

      child.writeStdout('first foreground chunk\n');
      await waitFor(() => outputContains(task, 'first foreground chunk'), 'first adopted log chunk');
      const ui = createManager(h, task.id);
      try {
        await new Promise((resolve) => setTimeout(resolve, 20));
        let text = stripAnsi(ui.manager.render(100).join('\n'));
        assert.match(text, /Adopted Dev Server/);
        assert.match(text, /first foreground chunk/);

        child.writeStderr('second background chunk\n');
        await waitFor(
          () => outputContains(task, 'second background chunk'),
          'second adopted log chunk',
        );
        ui.manager.handleInput('r');
        await new Promise((resolve) => setTimeout(resolve, 20));
        text = stripAnsi(ui.manager.render(100).join('\n'));
        assert.match(text, /first foreground chunk/);
        assert.match(text, /second background chunk/);

        const logs = await h.registry.getTaskLogs(task, 4096, true);
        assert.match(logs.text, /first foreground chunk/);
        assert.match(logs.text, /second background chunk/);
      } finally {
        ui.manager.dispose();
      }

      child.close(0, null);
      await h.registry.waitForFinalization(task);
      assert.equal(task.status, 'completed');
      assert.equal(h.changes.at(-1)?.[0]?.status, 'completed');
      assert.equal(terminalCount(h, task.id), 1);
      assert.equal(notificationCount(h, task.id), 1);
    } finally {
      await rm(h.root, { recursive: true, force: true });
    }
  });

  void it('routes the manager k action through registry.stopTask for an adopted child', async () => {
    const h = await createHarness('linux');
    try {
      const child = fakeChild(h, 8102);
      const task = adoptRunningChild(h.registry, h.ctx, child, {
        command: 'npm test -- --watch',
        name: 'Adopted Watcher',
      });
      const ui = createManager(h);
      try {
        ui.manager.handleInput('k');
        await waitFor(() => task.status === 'killed', 'manager stop of adopted task');
        await h.registry.waitForFinalization(task);
        assert.deepEqual(h.processKills, [{ pid: -8102, signal: 'SIGTERM' }]);
        assert.deepEqual(child.killCalls, []);
        assert.match(stripAnsi(ui.manager.render(100).join('\n')), /Adopted Watcher/);
        assert.equal(terminalCount(h, task.id), 1);
        assert.equal(notificationCount(h, task.id), 1);
      } finally {
        ui.manager.dispose();
      }
    } finally {
      await rm(h.root, { recursive: true, force: true });
    }
  });

  void it('routes the manager k action through injected Windows tree termination', async () => {
    const h = await createHarness('win32');
    try {
      const child = fakeChild(h, 8112);
      const task = adoptRunningChild(h.registry, h.ctx, child, {
        command: 'npm test -- --watch',
        name: 'Adopted Windows Watcher',
      });
      const ui = createManager(h);
      try {
        ui.manager.handleInput('k');
        await waitFor(() => task.status === 'killed', 'manager Windows stop of adopted task');
        await h.registry.waitForFinalization(task);

        assert.deepEqual(
          h.killTreeCalls.map(({ pid, phase }) => ({ pid, phase })),
          [{ pid: 8112, phase: 'terminate' }],
        );
        assert.ok(h.killTreeCalls[0]?.signal instanceof AbortSignal);
        assert.equal(h.killTreeCalls[0].signal.aborted, false);
        assert.deepEqual(h.processKills, []);
        assert.deepEqual(child.killCalls, []);
        assert.deepEqual(
          h.terminals.map(({ id, status, pid, exitCode, signal }) => ({
            id,
            status,
            pid,
            exitCode,
            signal,
          })),
          [
            {
              id: task.id,
              status: 'killed',
              pid: 8112,
              exitCode: null,
              signal: 'SIGTERM',
            },
          ],
        );
        assert.equal(notificationCount(h, task.id), 1);
      } finally {
        ui.manager.dispose();
      }
    } finally {
      await rm(h.root, { recursive: true, force: true });
    }
  });

  void it('awaits direct-close finalization before immediate recursive task-directory teardown', async () => {
    const h = await createHarness('linux');
    try {
      const child = fakeChild(h, 8103);
      const task = adoptRunningChild(h.registry, h.ctx, child, {
        command: 'npm run component',
        name: 'Direct Close',
      });
      child.close(0, null);
      await h.registry.waitForFinalization(task);
      await rm(dirname(task.metadataAbsPath), { recursive: true });
      assert.equal(task.status, 'completed');
      assert.equal(task.notified, true);
      assert.equal(existsSync(dirname(task.metadataAbsPath)), false);
    } finally {
      await rm(h.root, { recursive: true, force: true });
    }
  });

  void it('publishes completed and failed adopted terminals exactly once under duplicate events', async () => {
    const h = await createHarness('linux');
    try {
      const completedChild = fakeChild(h, 8103);
      const completed = adoptRunningChild(h.registry, h.ctx, completedChild, {
        command: 'npm run build',
        name: 'Adopted Build',
      });
      completedChild.close(0, null);
      completedChild.close(0, null);
      await h.registry.waitForFinalization(completed);
      assert.equal(completed.status, 'completed');

      const failedChild = fakeChild(h, 8104);
      const failed = adoptRunningChild(h.registry, h.ctx, failedChild, {
        command: 'npm run broken',
        name: 'Adopted Failure',
      });
      failedChild.fail(new Error('foreground pipe failed'));
      failedChild.close(9, null);
      failedChild.close(0, null);
      await h.registry.waitForFinalization(failed);
      assert.equal(failed.status, 'failed');

      assert.equal(terminalCount(h, completed.id), 1);
      assert.equal(notificationCount(h, completed.id), 1);
      assert.equal(terminalCount(h, failed.id), 1);
      assert.equal(notificationCount(h, failed.id), 1);
      const finalChange = h.changes.at(-1) ?? [];
      assert.equal(
        finalChange.find((task) => task.id === completed.id)?.status,
        'completed',
      );
      assert.equal(finalChange.find((task) => task.id === failed.id)?.status, 'failed');
    } finally {
      await rm(h.root, { recursive: true, force: true });
    }
  });
});

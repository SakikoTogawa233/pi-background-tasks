import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseJsonText } from '../../src/core/common.js';
import {
  BackgroundTaskRegistry,
  type BackgroundTaskContext,
  type BackgroundTaskLaunchKind,
  type BackgroundTaskSpawn,
  type CompletionNotificationMessage,
  type CompletionNotificationOptions,
} from '../../src/core/registry.js';
import type { BgTask, BgTaskSnapshot } from '../../src/core/common.js';
import type { TaskkillOutcome, WindowsKillPhase } from '../../src/core/windows-taskkill.js';
import { replaceFileDurable } from '../../src/core/durable-fs.js';

type JsonObject = Record<PropertyKey, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string, message: string): JsonObject {
  const parsed = parseJsonText(text);
  assert.ok(isJsonObject(parsed), message);
  return parsed;
}

function requiredJsonObject(value: unknown, message: string): JsonObject {
  assert.ok(isJsonObject(value), message);
  return value;
}

class FakeChild extends EventEmitter {
  stdin?: {
    write(data: Buffer, callback: (error?: Error | null) => void): boolean;
    end(callback?: () => void): void;
    once(event: 'error', listener: (error: Error) => void): unknown;
  };
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid: number;
  closed = false;
  killCalls: Array<NodeJS.Signals | undefined> = [];
  killImpl: (signal?: NodeJS.Signals) => boolean;

  constructor(pid: number, killImpl?: (signal?: NodeJS.Signals) => boolean) {
    super();
    this.pid = pid;
    this.killImpl = killImpl ?? (() => true);
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killCalls.push(signal);
    return this.killImpl(signal);
  }

  writeStdout(value: string): void {
    this.stdout.emit('data', Buffer.from(value, 'utf8'));
  }

  writeStderr(value: string): void {
    this.stderr.emit('data', Buffer.from(value, 'utf8'));
  }

  close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.closed = true;
    this.emit('close', code, signal);
  }

  fail(error: Error): void {
    this.emit('error', error);
  }
}

interface SpawnRecord {
  child: FakeChild;
  shell: string;
  args: string[];
  options: Parameters<BackgroundTaskSpawn>[2];
}

interface HarnessOptions {
  platform: 'linux' | 'win32';
  onChange?: () => void;
  beforeLaunch?: (kind: BackgroundTaskLaunchKind) => Promise<void>;
  maxRecentTasks?: number;
  maxOutputBytes?: number;
  killGraceMs?: number;
  stopWaitMs?: number;
  killProcess?: (pid: number, signal?: NodeJS.Signals | number) => boolean;
  killTree?: (
    pid: number,
    phase: WindowsKillPhase,
    signal?: AbortSignal,
  ) => Promise<TaskkillOutcome>;
  sendCompletionNotification?: (
    message: CompletionNotificationMessage,
    options: CompletionNotificationOptions,
  ) => void;
  publishTerminal?: (task: BgTaskSnapshot) => void;
  writeJsonAtomic?: (path: string, value: unknown) => Promise<void>;
  logger?: Pick<Console, 'error'>;
  makeTaskId?: () => string;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  childFactory?: (pid: number) => FakeChild;
  modelRegistry?: BackgroundTaskContext['modelRegistry'];
}

async function createHarness(options: HarnessOptions) {
  assert.equal(
    options.killProcess === undefined || options.platform === 'linux',
    true,
    'tests that inject POSIX killProcess must explicitly select platform linux',
  );
  assert.equal(
    options.platform !== 'win32' || options.killTree !== undefined,
    true,
    'tests that select platform win32 must inject deterministic killTree',
  );
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-registry-'));
  const cwd = join(root, 'project');
  await mkdir(cwd, { recursive: true });
  let pid = 4200;
  let idSeq = 0;
  const children: SpawnRecord[] = [];
  const notifications: Array<{
    message: CompletionNotificationMessage;
    options: CompletionNotificationOptions;
  }> = [];
  const errors: unknown[][] = [];
  const processKills: Array<{
    pid: number;
    signal: NodeJS.Signals | number | undefined;
  }> = [];
  let changes = 0;
  const registryOptions: ConstructorParameters<typeof BackgroundTaskRegistry>[0] = {
    platform: options.platform,
    killProcess:
      options.killProcess ??
      ((targetPid, signal) => {
        processKills.push({ pid: targetPid, signal });
        const spawn = children.find(({ child }) => child.pid === Math.abs(targetPid));
        assert.ok(spawn, `missing fake child for pid ${String(targetPid)}`);
        return spawn.child.kill(signal as NodeJS.Signals | undefined);
      }),
    logger: options.logger ?? {
      error: (...args: unknown[]) => {
        errors.push(args);
      },
    },
    makeTaskId: options.makeTaskId ?? (() => `bunit${String(++idSeq).padStart(3, '0')}`),
    sendCompletionNotification:
      options.sendCompletionNotification ??
      ((message, opts) => {
        notifications.push({ message, options: opts });
      }),
    onChange: () => {
      changes++;
      options.onChange?.();
    },
    spawn: (shell, args, spawnOptions) => {
      const child = options.childFactory?.(++pid) ?? new FakeChild(++pid);
      children.push({ child, shell, args: [...args], options: spawnOptions });
      return child;
    },
  };
  if (options.beforeLaunch !== undefined) registryOptions.beforeLaunch = options.beforeLaunch;
  if (options.publishTerminal !== undefined)
    registryOptions.publishTerminal = options.publishTerminal;
  if (options.writeJsonAtomic !== undefined)
    registryOptions.writeJsonAtomic = options.writeJsonAtomic;
  if (options.env !== undefined) registryOptions.env = options.env;
  if (options.maxRecentTasks !== undefined) registryOptions.maxRecentTasks = options.maxRecentTasks;
  if (options.maxOutputBytes !== undefined) registryOptions.maxOutputBytes = options.maxOutputBytes;
  if (options.killGraceMs !== undefined) registryOptions.killGraceMs = options.killGraceMs;
  if (options.stopWaitMs !== undefined) registryOptions.stopWaitMs = options.stopWaitMs;
  if (options.now !== undefined) registryOptions.now = options.now;
  if (options.killTree !== undefined) registryOptions.killTree = options.killTree;
  const registry = new BackgroundTaskRegistry(registryOptions);
  const ctx: BackgroundTaskContext = {
    cwd,
    sessionId: 'registry-test',
    modelRegistry: options.modelRegistry ?? { getAll: () => [] },
    model: undefined,
  };
  return {
    root,
    cwd,
    ctx,
    registry,
    children,
    notifications,
    errors,
    processKills,
    get changes() {
      return changes;
    },
  };
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await replaceFileDurable(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function cleanup(root: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (!(error instanceof Error) || !/ENOTEMPTY/.test(error.message) || attempt === 4)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function waitFor(
  predicate: () => boolean,
  message = 'condition',
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

function lastSpawn(h: Awaited<ReturnType<typeof createHarness>>): SpawnRecord {
  const spawn = h.children.at(-1);
  assert.ok(spawn, 'test harness should have recorded a child process spawn');
  return spawn;
}

function taskkillOutcome(exitCode: number | null, stderr = ''): TaskkillOutcome {
  return {
    exitCode,
    signal: null,
    stdout: '',
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
  };
}

function unexpectedKillTree(): Promise<TaskkillOutcome> {
  throw new Error('this Windows launch-shape test must not request process-tree termination');
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolveFn: ((value: T) => void) | undefined;
  let rejectFn: ((error: unknown) => void) | undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve;
    rejectFn = reject;
  });
  assert.ok(resolveFn, 'deferred resolve should initialize');
  assert.ok(rejectFn, 'deferred reject should initialize');
  return { promise, resolve: resolveFn, reject: rejectFn };
}

function isKillRequester(value: unknown): value is (task: BgTask, signal?: NodeJS.Signals) => void {
  return typeof value === 'function';
}

function requestKillForTest(
  registry: BackgroundTaskRegistry,
  task: BgTask,
  signal?: NodeJS.Signals,
): void {
  const method = Reflect.get(registry, 'requestKill');
  assert.ok(isKillRequester(method), 'registry requestKill should be callable');
  method.call(registry, task, signal);
}

async function startFakeTask(
  h: Awaited<ReturnType<typeof createHarness>>,
  name = 'Registry Task',
): Promise<{ task: BgTask; child: FakeChild }> {
  const task = await h.registry.startTask(h.ctx, 'node fake.js', {
    name,
    isAgent: false,
    notifyOnCompletion: true,
    triggerOnCompletion: true,
  });
  return { task, child: lastSpawn(h).child };
}

void describe('BackgroundTaskRegistry', () => {
  void it('keeps ordinary post-spawn metadata failure under launch ownership through child close and phase B', async () => {
    const terminalWriteEntered = deferred<void>();
    const releaseTerminalWrite = deferred<void>();
    const responseGate = deferred<void>();
    const killRequested = deferred<void>();
    const killCalls: Array<NodeJS.Signals | number | undefined> = [];
    let writes = 0;
    let childRef: FakeChild | undefined;
    const h = await createHarness({
      platform: 'linux',
      writeJsonAtomic: async (path, value) => {
        writes += 1;
        if (writes === 1) throw new Error('injected ordinary startup metadata failure');
        if (writes === 2) {
          terminalWriteEntered.resolve(undefined);
          await releaseTerminalWrite.promise;
        }
        await writeJsonAtomic(path, value);
      },
      killProcess: (pid, signal) => {
        assert.ok(childRef);
        assert.equal(pid, -childRef.pid, 'startup failure must target the detached process tree');
        killCalls.push(signal);
        killRequested.resolve(undefined);
        queueMicrotask(() => childRef?.close(null, 'SIGTERM'));
        return true;
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const launch = h.registry.startTask(h.ctx, 'node live.js', {
        name: 'Ordinary startup failure',
        notifyOnCompletion: false,
        terminalPublicationGate: responseGate.promise,
      });
      const rejectedLaunch = assert.rejects(
        launch,
        /Failed to start background task: injected ordinary startup metadata failure/,
      );
      h.registry.setShuttingDown(true);
      const drain = h.registry.waitForLaunchOperations();
      let drainSettled = false;
      void drain.then(() => {
        drainSettled = true;
      });

      await killRequested.promise;
      await terminalWriteEntered.promise;
      assert.equal(drainSettled, false, 'launch drain must include terminal durability and phase B');
      assert.deepEqual(killCalls, ['SIGTERM']);
      releaseTerminalWrite.resolve(undefined);
      await rejectedLaunch;
      await drain;

      const task = h.registry.allTasks()[0];
      assert.ok(task);
      assert.equal(task.status, 'failed');
      assert.equal(task.error, 'injected ordinary startup metadata failure');
      assert.equal(task.finalizationSettled, true);
      assert.equal(childRef?.closed, true);
      assert.equal(
        h.registry.allTasks().some((owned) => owned.status === 'running'),
        false,
      );
      assert.equal(h.children.filter(({ child }) => !child.closed).length, 0);
      responseGate.resolve(undefined);
      await h.registry.waitForTerminalPublications();
    } finally {
      await cleanup(h.root);
    }
  });

  void it('lets shutdown retry a timed-out post-spawn startup cleanup without replacing its error', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const firstTermination = deferred<void>();
    const killCalls: Array<NodeJS.Signals | number | undefined> = [];
    let childRef: FakeChild | undefined;
    let writes = 0;
    const h = await createHarness({
      platform: 'linux',
      killGraceMs: 10,
      stopWaitMs: 30,
      writeJsonAtomic: async (path, value) => {
        writes += 1;
        if (writes === 1) throw new Error('injected retriable startup failure');
        await writeJsonAtomic(path, value);
      },
      killProcess: (_pid, signal) => {
        killCalls.push(signal);
        if (killCalls.length === 1) firstTermination.resolve(undefined);
        if (killCalls.length === 4) queueMicrotask(() => childRef?.close(null, 'SIGKILL'));
        return true;
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const launch = h.registry.startTask(h.ctx, 'node live.js', {
        name: 'Retriable Startup Cleanup',
        notifyOnCompletion: false,
      });
      const rejectedLaunch = assert.rejects(
        launch,
        /Failed to start background task: injected retriable startup failure; startup cleanup failed: Task .* did not exit within 30ms after cancellation/,
      );
      await firstTermination.promise;
      mock.timers.tick(30);
      await rejectedLaunch;

      const task = h.registry.allTasks()[0];
      assert.ok(task);
      assert.equal(task.status, 'running');
      assert.equal(task.stopPromise, undefined);
      assert.equal(task.startupError, 'injected retriable startup failure');
      assert.equal(task.error, 'injected retriable startup failure');
      assert.equal(task.killKind, 'user');

      const shutdown = h.registry.stopTask(
        task,
        'shutdown',
        'Killed during Pi session shutdown/reload',
      );
      const shutdownConcurrent = h.registry.stopTask(task, 'shutdown');
      assert.equal(shutdownConcurrent, shutdown);
      mock.timers.tick(10);
      await Promise.all([shutdown, shutdownConcurrent]);
      await h.registry.waitForTerminalPublications();

      assert.deepEqual(killCalls, ['SIGTERM', 'SIGKILL', 'SIGTERM', 'SIGKILL']);
      assert.equal(childRef?.closed, true);
      assert.equal(task.status, 'failed');
      assert.equal(task.error, 'injected retriable startup failure');
      assert.equal(task.finalizationSettled, true);
      assert.equal(task.terminalPublished, true);
      assert.equal(h.children.filter(({ child }) => !child.closed).length, 0);
    } finally {
      mock.timers.reset();
      await cleanup(h.root);
    }
  });

  void it('lets an admitted launch register after shutdown closes admission so the snapshot can stop it', async () => {
    const gate = deferred<void>();
    let childRef: FakeChild | undefined;
    const killCalls: Array<NodeJS.Signals | number | undefined> = [];
    const h = await createHarness({
      platform: 'linux',
      beforeLaunch: async (kind) => {
        assert.equal(kind, 'task');
        await gate.promise;
      },
      killProcess: (_pid, signal) => {
        killCalls.push(signal);
        queueMicrotask(() => childRef?.close(null, signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM'));
        return true;
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const launch = h.registry.startTask(h.ctx, 'sleep forever', {
        name: 'Crossing launch',
        notifyOnCompletion: false,
      });
      h.registry.setShuttingDown(true);
      const drain = h.registry.waitForLaunchOperations();
      gate.resolve(undefined);
      const task = await launch;
      await drain;
      assert.equal(h.registry.resolveTask(task.id), task);
      assert.equal(h.children.length, 1);

      const snapshot = h.registry.allTasks();
      assert.deepEqual(snapshot, [task]);
      await Promise.all(snapshot.map((owned) => h.registry.stopTask(owned, 'shutdown')));
      assert.equal(task.status, 'killed');
      assert.deepEqual(killCalls, ['SIGTERM']);
      assert.equal(h.registry.allTasks().some((owned) => owned.status === 'running'), false);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('preserves natural finalization against competing user and shutdown stops', async () => {
    const terminalWriteEntered = deferred<void>();
    const releaseTerminalWrite = deferred<void>();
    let writes = 0;
    const killCalls: Array<NodeJS.Signals | number | undefined> = [];
    const h = await createHarness({
      platform: 'linux',
      killProcess: (_pid, signal) => {
        killCalls.push(signal);
        return true;
      },
      writeJsonAtomic: async (path, value) => {
        writes += 1;
        if (writes === 2) {
          terminalWriteEntered.resolve(undefined);
          await releaseTerminalWrite.promise;
        }
        await writeJsonAtomic(path, value);
      },
    });
    try {
      const { task, child } = await startFakeTask(h, 'Natural finalization wins');
      child.close(0, null);
      await terminalWriteEntered.promise;
      assert.ok(task.finalizationPromise, 'close must synchronously claim finalization');
      assert.equal(task.status, 'running', 'phase A must still be gated on terminal durability');

      const originalError = task.error;
      const originalKillKind = task.killKind;
      await Promise.all([
        assert.rejects(
          h.registry.stopTask(task, 'user', 'user stop must lose'),
          /finalization is already in progress and is not running; cannot apply user stop/,
        ),
        assert.rejects(
          h.registry.stopTask(task, 'shutdown', 'shutdown stop must lose'),
          /finalization is already in progress and is not running; cannot apply shutdown stop/,
        ),
      ]);
      assert.deepEqual(killCalls, []);
      assert.equal(task.killKind, originalKillKind);
      assert.equal(task.error, originalError);

      releaseTerminalWrite.resolve(undefined);
      await h.registry.waitForFinalization(task);
      assert.equal(task.status, 'completed');
      assert.equal(task.killKind, undefined);
      assert.equal(task.error, undefined);
      assert.deepEqual(killCalls, []);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('preserves full shell command bytes except surrounding whitespace', async () => {
    const h = await createHarness({ platform: 'linux' });
    try {
      const command = `'${process.execPath}' '${join(h.cwd, 'bin', 'autopilot-agent-run.mjs')}' --spec '${join(h.cwd, 'specs', 'unit spec.json')}'`;
      const task = await h.registry.startTask(h.ctx, `  ${command}  `, {
        name: 'Quoted Runner',
        isAgent: true,
        notifyOnCompletion: false,
      });
      const spawn = lastSpawn(h);
      assert.equal(task.command, command);
      assert.equal(spawn.args.at(-1), command);
      assert.equal(JSON.parse(readFileSync(task.metadataAbsPath, 'utf8')).command, command);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('rejects unresolved Windows bash before creating a task', async () => {
    const h = await createHarness({
      platform: 'win32',
      killTree: unexpectedKillTree,
      env: { PI_BG_SHELL: 'bash', PATH: '' },
    });
    try {
      await assert.rejects(
        h.registry.startTask(h.ctx, 'echo ok', { name: 'Bad Bash', notifyOnCompletion: false }),
        /could not resolve bash/,
      );
      assert.equal(h.children.length, 0);
      assert.equal(h.registry.allTasks().length, 0);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('uses POSIX process-group kill before child fallback', async () => {
    let childRef: FakeChild | undefined;
    const killCalls: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
    const h = await createHarness({
      platform: 'linux',
      killProcess: (pid, signal) => {
        const call: { pid: number; signal?: NodeJS.Signals | number } = { pid };
        if (signal !== undefined) call.signal = signal;
        killCalls.push(call);
        queueMicrotask(() => {
          childRef?.close(null, typeof signal === 'string' ? signal : null);
        });
        return true;
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task, child } = await startFakeTask(h);
      await h.registry.stopTask(task, 'user');
      assert.deepEqual(killCalls, [{ pid: -child.pid, signal: 'SIGTERM' }]);
      assert.deepEqual(child.killCalls, []);
      assert.equal(task.status, 'killed');
    } finally {
      await cleanup(h.root);
    }
  });

  void it('bounds only the durable terminal transition while stopTask awaits gated full finalization', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const gate = deferred<void>();
    const terminalMetadataDurable = deferred<void>();
    const expectedMetadataWrites = [
      { status: 'running', notified: false },
      { status: 'killed', notified: false },
      { status: 'killed', notified: true },
    ];
    let metadataWrites = 0;
    const h = await createHarness({
      platform: 'linux',
      stopWaitMs: 40,
      writeJsonAtomic: async (path, value) => {
        const writeNumber = ++metadataWrites;
        const metadata = requiredJsonObject(value, `metadata write ${String(writeNumber)}`);
        assert.deepEqual(
          { status: metadata['status'], notified: metadata['notified'] },
          expectedMetadataWrites[writeNumber - 1],
          `unexpected metadata write ${String(writeNumber)}`,
        );
        await writeJsonAtomic(path, value);
        if (writeNumber === 2) terminalMetadataDurable.resolve(undefined);
      },
    });
    try {
      const task = await h.registry.startTask(h.ctx, 'node fake.js', {
        name: 'Complete Finalization',
        isAgent: false,
        notifyOnCompletion: true,
        triggerOnCompletion: true,
        terminalPublicationGate: gate.promise,
      });
      const child = lastSpawn(h).child;
      let stopResolved = false;
      const stopping = h.registry.stopTask(task, 'user');
      void stopping.then(
        () => {
          stopResolved = true;
        },
        () => undefined,
      );
      child.close(null, 'SIGTERM');
      await terminalMetadataDurable.promise;
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      assert.equal(task.status, 'killed');
      assert.equal(metadataWrites, 2, 'phase A must end at the second metadata write');
      assert.equal(stopResolved, false, 'stopTask must still be awaiting phase B');
      mock.timers.tick(100);
      await Promise.resolve();
      assert.equal(
        stopResolved,
        false,
        'the 40ms stop wait must not bound phase B after durable terminal status',
      );

      gate.resolve(undefined);
      await assert.doesNotReject(stopping);
      await h.registry.waitForFinalization(task);

      const metadata = parseJsonObject(
        await readFile(task.metadataAbsPath, 'utf8'),
        'final notification metadata must be an object',
      );
      assert.equal(metadataWrites, 3);
      assert.equal(metadata['status'], 'killed');
      assert.equal(metadata['notified'], true);
      assert.equal(task.notified, true);
      assert.equal(h.notifications.length, 1);
    } finally {
      mock.timers.reset();
      await cleanup(h.root);
    }
  });

  void it('deduplicates finalization waits and fails loudly for inconsistent lifecycle state', async () => {
    const h = await createHarness({ platform: 'linux' });
    try {
      const { task, child } = await startFakeTask(h, 'Explicit Finalization Wait');
      assert.throws(
        () => h.registry.waitForFinalization(task),
        /has not entered finalization/,
      );
      child.fail(new Error('first terminal event'));
      child.close(0, null);
      const finalization = task.finalizationPromise;
      assert.ok(finalization, 'the first terminal event must assign the finalization promise');
      assert.equal(
        task.finalizationPromise,
        finalization,
        'duplicate terminal events must retain one finalization promise',
      );
      await h.registry.waitForFinalization(task);
      assert.equal(task.status, 'failed');
    } finally {
      await cleanup(h.root);
    }
  });

  void it('waits for a terminal task full finalization independently of running-task stops', async () => {
    const gate = deferred<void>();
    const h = await createHarness({ platform: 'linux' });
    try {
      const task = await h.registry.startTask(h.ctx, 'node fake.js', {
        name: 'Shutdown Terminal Finalization',
        notifyOnCompletion: true,
        terminalPublicationGate: gate.promise,
      });
      lastSpawn(h).child.close(0, null);
      await waitFor(() => task.status === 'completed', 'terminal status before shutdown wait');
      let shutdownWaitResolved = false;
      const shutdownWait = h.registry.waitForFinalization(task).then(() => {
        shutdownWaitResolved = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(shutdownWaitResolved, false);
      gate.resolve(undefined);
      await shutdownWait;
      assert.equal(task.notified, true);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('falls back to child.kill when process-group kill fails and reports when both fail', async () => {
    const h = await createHarness({
      platform: 'linux',
      killProcess: () => {
        throw new Error('group unavailable');
      },
      childFactory: (pid) =>
        new FakeChild(pid, function (this: FakeChild, signal) {
          queueMicrotask(() => {
            this.close(null, signal ?? null);
          });
          return true;
        }),
    });
    try {
      const { task, child } = await startFakeTask(h, 'Fallback Kill');
      await h.registry.stopTask(task, 'user');
      assert.deepEqual(child.killCalls, ['SIGTERM']);
      assert.equal(task.status, 'killed');
    } finally {
      await cleanup(h.root);
    }

    const failing = await createHarness({
      platform: 'linux',
      killProcess: () => {
        throw new Error('group unavailable');
      },
      childFactory: (pid) =>
        new FakeChild(pid, () => {
          throw new Error('child unavailable');
        }),
    });
    try {
      const { task } = await startFakeTask(failing, 'Failed Kill');
      await assert.rejects(
        () => failing.registry.stopTask(task, 'user'),
        /Could not kill task[\s\S]*group unavailable[\s\S]*child unavailable/,
      );
      assert.equal(task.status, 'running');
    } finally {
      await cleanup(failing.root);
    }
  });

  void it('uses taskkill tree termination on Windows and never falls back to child.kill', async () => {
    let childRef: FakeChild | undefined;
    const killTreeCalls: Array<{ pid: number; phase: WindowsKillPhase }> = [];
    const h = await createHarness({
      platform: 'win32',
      killGraceMs: 20,
      stopWaitMs: 500,
      killTree: (pid, phase) => {
        killTreeCalls.push({ pid, phase });
        if (phase === 'force') {
          queueMicrotask(() => {
            childRef?.close(null, 'SIGKILL');
          });
        }
        return Promise.resolve(taskkillOutcome(0));
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid, () => {
          throw new Error('root-only kill must not run');
        });
        return childRef;
      },
    });
    try {
      const { task, child } = await startFakeTask(h, 'Windows Kill');
      await h.registry.stopTask(task, 'user');
      assert.deepEqual(h.processKills, [], 'Windows termination must not use POSIX process kill');
      assert.deepEqual(killTreeCalls, [
        { pid: child.pid, phase: 'terminate' },
        { pid: child.pid, phase: 'force' },
      ]);
      assert.deepEqual(child.killCalls, []);
      const windowsSpawn = h.children[0];
      assert.ok(windowsSpawn, 'Windows shell spawn should be recorded');
      // ComSpec is a full path on a real Windows host, so compare the basename.
      assert.equal(basename(windowsSpawn.shell).toLowerCase(), 'cmd.exe');
      assert.deepEqual(windowsSpawn.args.slice(0, 3), ['/d', '/s', '/c']);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('shares duplicate Windows graceful stops and aborts soft taskkill when force starts', async () => {
    let childRef: FakeChild | undefined;
    let softAbortCount = 0;
    let firstTimer: NodeJS.Timeout | undefined;
    const phases: WindowsKillPhase[] = [];
    const h = await createHarness({
      platform: 'win32',
      killGraceMs: 20,
      stopWaitMs: 500,
      killTree: (_pid, phase, signal) => {
        phases.push(phase);
        if (phase === 'terminate') {
          if (signal !== undefined) {
            signal.addEventListener(
              'abort',
              () => {
                softAbortCount += 1;
              },
              { once: true },
            );
          }
          return new Promise<TaskkillOutcome>(() => undefined);
        }
        assert.ok(signal, 'force taskkill must own a distinct abort signal');
        assert.equal(signal.aborted, false);
        assert.equal(softAbortCount, 1, 'soft attempt should be aborted before force starts');
        queueMicrotask(() => {
          childRef?.close(null, 'SIGKILL');
        });
        return Promise.resolve(taskkillOutcome(0));
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task } = await startFakeTask(h, 'Windows Duplicate Stop');
      const first = h.registry.stopTask(task, 'user');
      firstTimer = task.killEscalationTimer;
      assert.ok(firstTimer, 'first graceful stop should arm an escalation timer');
      const second = h.registry.stopTask(task, 'user');
      const third = h.registry.stopTask(task, 'user');
      assert.equal(task.killEscalationTimer, firstTimer, 'duplicate stops must share one timer');
      await Promise.all([first, second, third]);
      assert.deepEqual(phases, ['terminate', 'force']);
      assert.equal(task.killEscalationTimer, undefined);
      assert.equal(softAbortCount, 1);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('treats explicit Windows force as terminal and does not arm escalation', async () => {
    const phases: WindowsKillPhase[] = [];
    const h = await createHarness({
      platform: 'win32',
      killGraceMs: 20,
      killTree: (_pid, phase) => {
        phases.push(phase);
        return Promise.resolve(taskkillOutcome(0));
      },
    });
    try {
      const { task } = await startFakeTask(h, 'Windows Explicit Force');
      requestKillForTest(h.registry, task, 'SIGKILL');
      assert.equal(task.killEscalationTimer, undefined);
      await new Promise((resolve) => setTimeout(resolve, 80));
      assert.deepEqual(phases, ['force']);
      assert.equal(task.killEscalationTimer, undefined);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('records Windows taskkill exit 128 as an already-exited race', async () => {
    const h = await createHarness({
      platform: 'win32',
      killGraceMs: 500,
      stopWaitMs: 1000,
      killTree: () => Promise.resolve(taskkillOutcome(128, 'process not found')),
    });
    try {
      const { task, child } = await startFakeTask(h, 'Windows Missing Process');
      const stopped = h.registry.stopTask(task, 'user');
      await waitFor(
        () => readFileSync(task.outputAbsPath, 'utf8').includes('process not found'),
        'exit 128 notice',
      );
      child.close(0, null);
      await stopped;
      assert.equal(task.status, 'killed');
      assert.match(await readFile(task.outputAbsPath, 'utf8'), /already-exited race/);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('persists a Windows soft failure and still escalates to force after grace', async () => {
    let childRef: FakeChild | undefined;
    const phases: WindowsKillPhase[] = [];
    const h = await createHarness({
      platform: 'win32',
      killGraceMs: 20,
      stopWaitMs: 500,
      killTree: (_pid, phase) => {
        phases.push(phase);
        if (phase === 'terminate') return Promise.resolve(taskkillOutcome(1, 'soft denied'));
        queueMicrotask(() => {
          childRef?.close(null, 'SIGKILL');
        });
        return Promise.resolve(taskkillOutcome(0));
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task } = await startFakeTask(h, 'Windows Soft Failure');
      await h.registry.stopTask(task, 'user');
      assert.deepEqual(phases, ['terminate', 'force']);
      assert.match(task.error ?? '', /soft denied/);
      const metadata = parseJsonObject(await readFile(task.metadataAbsPath, 'utf8'), 'metadata');
      assert.match(String(metadata['error']), /soft denied/);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('retries a settled Windows force failure with fresh shared taskkill state', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const phases: Array<{ phase: WindowsKillPhase; signal: AbortSignal | undefined }> = [];
    let forceAttempt = 0;
    let childRef: FakeChild | undefined;
    const terminals: BgTaskSnapshot[] = [];
    const h = await createHarness({
      platform: 'win32',
      killGraceMs: 20,
      stopWaitMs: 100,
      publishTerminal: (terminal) => terminals.push(terminal),
      killTree: (_pid, phase, signal) => {
        phases.push({ phase, signal });
        assert.ok(signal, `${phase} taskkill must own abortable attempt state`);
        if (phase === 'terminate') return Promise.resolve(taskkillOutcome(1, 'soft denied'));
        forceAttempt += 1;
        if (forceAttempt === 1) return Promise.resolve(taskkillOutcome(5, 'force denied'));
        queueMicrotask(() => childRef?.close(null, 'SIGKILL'));
        return Promise.resolve(taskkillOutcome(0));
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid, () => {
          throw new Error('root-only kill must not run');
        });
        return childRef;
      },
    });
    try {
      const { task, child } = await startFakeTask(h, 'Windows Force Failure Retry');
      const first = h.registry.stopTask(task, 'user', 'first Windows intent');
      const firstConcurrent = h.registry.stopTask(
        task,
        'shutdown',
        'competing first-attempt shutdown',
      );
      assert.equal(firstConcurrent, first, 'first Windows attempt must have one shared owner');
      await Promise.resolve();
      mock.timers.tick(20);
      const firstResults = await Promise.allSettled([first, firstConcurrent]);
      for (const result of firstResults) {
        assert.equal(result.status, 'rejected');
        assert.match(
          result.status === 'rejected' ? String(result.reason) : '',
          /Windows taskkill \/T \/F force termination failed[\s\S]*Descendant processes may have leaked/,
        );
      }
      assert.equal(task.status, 'running');

      const retry = h.registry.stopTask(task, 'shutdown', 'retry must not overwrite intent');
      const retryConcurrent = h.registry.stopTask(task, 'user', 'competing retry');
      assert.equal(retryConcurrent, retry, 'retry must have one fresh shared owner');
      await Promise.resolve();
      mock.timers.tick(20);
      await Promise.all([retry, retryConcurrent]);
      await h.registry.waitForTerminalPublications();

      assert.deepEqual(
        phases.map(({ phase }) => phase),
        ['terminate', 'force', 'terminate', 'force'],
      );
      assert.notEqual(phases[0]?.signal, phases[2]?.signal);
      assert.notEqual(phases[1]?.signal, phases[3]?.signal);
      assert.deepEqual(h.processKills, [], 'Windows retries must not use POSIX process kill');
      assert.deepEqual(child.killCalls, []);
      assert.equal(child.closed, true);
      assert.equal(task.status, 'killed');
      assert.equal(task.finalizationSettled, true);
      assert.equal(terminals.length, 1);
      assert.equal(task.killKind, 'user');
      assert.match(task.error ?? '', /first Windows intent[\s\S]*force denied/);
      assert.doesNotMatch(task.error ?? '', /retry must not overwrite intent|competing retry/);
    } finally {
      mock.timers.reset();
      await cleanup(h.root);
    }
  });

  void it('keeps terminal metadata running until in-flight Windows force settles', async () => {
    let childRef: FakeChild | undefined;
    let forceStarted = false;
    const force = deferred<TaskkillOutcome>();
    const terminals: BgTaskSnapshot[] = [];
    const h = await createHarness({
      platform: 'win32',
      killGraceMs: 20,
      stopWaitMs: 1000,
      publishTerminal: (task) => {
        terminals.push(task);
      },
      killTree: (_pid, phase) => {
        if (phase === 'terminate') return Promise.resolve(taskkillOutcome(0));
        forceStarted = true;
        queueMicrotask(() => {
          childRef?.close(null, 'SIGKILL');
        });
        return force.promise;
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task } = await startFakeTask(h, 'Windows Force Barrier');
      const stopped = h.registry.stopTask(task, 'user');
      await waitFor(() => forceStarted, 'force taskkill start');
      await waitFor(() => task.finalized === true, 'child close reached finalization');
      const runningMetadata = parseJsonObject(
        await readFile(task.metadataAbsPath, 'utf8'),
        'metadata before force settles',
      );
      assert.equal(runningMetadata['status'], 'running');
      assert.equal(terminals.length, 0);
      force.resolve(taskkillOutcome(0));
      await stopped;
      assert.equal(task.status, 'killed');
      const terminalMetadata = parseJsonObject(
        await readFile(task.metadataAbsPath, 'utf8'),
        'metadata after force settles',
      );
      assert.equal(terminalMetadata['status'], 'killed');
      assert.equal(terminals.length, 1);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('keeps duplicate stop requests idempotent and escalates to SIGKILL after grace', async () => {
    let childRef: FakeChild | undefined;
    const killCalls: Array<NodeJS.Signals | number | undefined> = [];
    const h = await createHarness({
      platform: 'linux',
      killGraceMs: 20,
      stopWaitMs: 500,
      killProcess: (_pid, signal) => {
        killCalls.push(signal);
        if (signal === 'SIGKILL') {
          queueMicrotask(() => {
            childRef?.close(null, 'SIGKILL');
          });
        }
        return true;
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task } = await startFakeTask(h, 'Escalate Kill');
      const first = h.registry.stopTask(task, 'user', 'first user stop owns intent');
      const second = h.registry.stopTask(task, 'shutdown', 'competing shutdown must lose');
      assert.equal(second, first, 'concurrent stops must share the first task-owned promise');
      await Promise.all([first, second]);
      assert.deepEqual(killCalls, ['SIGTERM', 'SIGKILL']);
      assert.equal(task.status, 'killed');
      assert.equal(task.killKind, 'user');
      assert.equal(task.error, 'first user stop owns intent');
      assert.equal(task.killEscalationTimer, undefined, 'escalation timer must be cleared');
    } finally {
      await cleanup(h.root);
    }
  });

  void it('schedules exactly one SIGKILL escalation for concurrent stop requests', async () => {
    // Regression: SIGTERM de-duplication guarded the signal but not the timer,
    // so each concurrent stopTask scheduled its own escalation. When the child
    // outlived the grace window that produced duplicate SIGKILLs.
    const killCalls: Array<NodeJS.Signals | number | undefined> = [];
    const h = await createHarness({
      platform: 'linux',
      killGraceMs: 20,
      stopWaitMs: 120,
      // Never close the child, so every scheduled escalation timer can fire.
      killProcess: (_pid, signal) => {
        killCalls.push(signal);
        return true;
      },
      childFactory: (pid) => new FakeChild(pid),
    });
    try {
      const { task } = await startFakeTask(h, 'Escalate Once');
      await Promise.all([
        h.registry.stopTask(task, 'user').catch(() => undefined),
        h.registry.stopTask(task, 'user').catch(() => undefined),
        h.registry.stopTask(task, 'user').catch(() => undefined),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 120));
      assert.deepEqual(
        killCalls,
        ['SIGTERM', 'SIGKILL'],
        'concurrent stop requests must escalate to SIGKILL exactly once',
      );
    } finally {
      await cleanup(h.root);
    }
  });

  void it('retries a timed-out POSIX stop during shutdown and fully finalizes the child', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const killCalls: Array<NodeJS.Signals | number | undefined> = [];
    const terminals: BgTaskSnapshot[] = [];
    let childRef: FakeChild | undefined;
    const h = await createHarness({
      platform: 'linux',
      killGraceMs: 10,
      stopWaitMs: 30,
      publishTerminal: (terminal) => terminals.push(terminal),
      killProcess: (_pid, signal) => {
        killCalls.push(signal);
        if (killCalls.length === 4) queueMicrotask(() => childRef?.close(null, 'SIGKILL'));
        return true;
      },
      childFactory: (pid) => {
        childRef = new FakeChild(pid);
        return childRef;
      },
    });
    try {
      const { task, child } = await startFakeTask(h, 'POSIX Stop Retry');
      const first = h.registry.stopTask(task, 'user', 'first timeout intent');
      const firstConcurrent = h.registry.stopTask(task, 'shutdown', 'competing first shutdown');
      assert.equal(firstConcurrent, first, 'first POSIX attempt must have one shared owner');
      mock.timers.tick(30);
      await Promise.all([
        assert.rejects(first, /did not exit within 30ms after cancellation/),
        assert.rejects(firstConcurrent, /did not exit within 30ms after cancellation/),
      ]);
      assert.deepEqual(killCalls, ['SIGTERM', 'SIGKILL']);
      assert.equal(task.status, 'running');
      assert.equal(task.stopPromise, undefined);

      const shutdown = h.registry.stopTask(task, 'shutdown', 'shutdown retry must lose intent');
      const shutdownConcurrent = h.registry.stopTask(task, 'user', 'competing retry user');
      assert.equal(shutdownConcurrent, shutdown, 'shutdown retry must have one fresh shared owner');
      mock.timers.tick(10);
      await Promise.all([shutdown, shutdownConcurrent]);
      await h.registry.waitForFinalization(task);
      await h.registry.waitForTerminalPublications();

      assert.deepEqual(killCalls, ['SIGTERM', 'SIGKILL', 'SIGTERM', 'SIGKILL']);
      assert.equal(child.closed, true);
      assert.equal(h.children.filter(({ child: owned }) => !owned.closed).length, 0);
      assert.equal(task.status, 'killed');
      assert.equal(task.finalizationSettled, true);
      assert.equal(task.terminalPublished, true);
      assert.equal(terminals.length, 1);
      assert.equal(task.killKind, 'user');
      assert.equal(task.error, 'first timeout intent');
    } finally {
      mock.timers.reset();
      await cleanup(h.root);
    }
  });

  void it('finalizes and notifies once under error/close and output-cap races', async () => {
    const h = await createHarness({
      platform: 'linux',
      maxOutputBytes: 8,
      killProcess: () => true,
    });
    try {
      const { task, child } = await startFakeTask(h, 'Race Failure');
      child.fail(new Error('spawn exploded'));
      child.close(0, null);
      await waitFor(() => task.status !== 'running', 'spawn race finalization');
      await waitFor(() => h.notifications.length === 1, 'single spawn-race notification');
      assert.equal(task.status, 'failed');
      assert.match(task.error ?? '', /spawn exploded/);
      assert.equal(h.notifications.length, 1);
      // BUG-181: the terminal event itself is authoritative; agents must not poll to reconfirm it.
      const notification = h.notifications[0];
      assert.ok(notification, 'terminal notification should be captured');
      assert.match(
        notification.message.content,
        /<guidance>Terminal state and output metadata are durable\. Do not call bg_status to reconfirm; use bg_logs only if output is needed\.<\/guidance>/,
      );
      assert.deepEqual(notification.options, { deliverAs: 'followUp', triggerTurn: true });

      const capped = await h.registry.startTask(h.ctx, 'node noisy.js', {
        name: 'Output Race',
        notifyOnCompletion: true,
        triggerOnCompletion: true,
      });
      const cappedChild = lastSpawn(h).child;
      cappedChild.writeStdout('0123456789abcdef');
      cappedChild.close(1, null);
      cappedChild.close(0, null);
      await waitFor(() => capped.status !== 'running', 'output-cap finalization');
      await waitFor(() => h.notifications.length === 2, 'single output-cap notification');
      assert.equal(capped.status, 'failed');
      assert.match(capped.error ?? '', /Output exceeded cap/);
      assert.equal(h.notifications.length, 2);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('publishes terminal snapshots exactly once after durable metadata', async () => {
    const terminals: BgTaskSnapshot[] = [];
    const metadataStatuses: unknown[] = [];
    let metadataPath = '';
    const h = await createHarness({
      platform: 'linux',
      publishTerminal: (task) => {
        terminals.push(task);
        metadataStatuses.push(
          parseJsonObject(readFileSync(metadataPath, 'utf8'), 'terminal metadata must be written')[
            'status'
          ],
        );
      },
    });
    try {
      const { task, child } = await startFakeTask(h, 'Terminal Once');
      metadataPath = task.metadataAbsPath;
      child.close(0, null);
      child.close(1, null);
      await waitFor(() => task.status !== 'running', 'terminal status');
      await waitFor(() => terminals.length === 1, 'single terminal publication');
      const terminal = terminals[0];
      assert.ok(terminal, 'terminal snapshot should be present');
      assert.equal(terminal.id, task.id);
      assert.equal(terminal.status, 'completed');
      assert.deepEqual(metadataStatuses, ['completed']);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('keeps finalization-settled tasks resolvable until gated terminal publication succeeds', async () => {
    const publicationGate = deferred<void>();
    const terminals: BgTaskSnapshot[] = [];
    const h = await createHarness({
      platform: 'linux',
      maxRecentTasks: 1,
      publishTerminal: (task) => terminals.push(task),
    });
    try {
      const old = await h.registry.startTask(h.ctx, 'printf old', {
        name: 'Publication gated old task',
        notifyOnCompletion: false,
      });
      old.terminalPublicationGate = publicationGate.promise;
      lastSpawn(h).child.close(0, null);
      await h.registry.waitForFinalization(old);
      assert.equal(old.finalizationSettled, true);
      assert.equal(old.terminalPublished, undefined);
      assert.equal(h.registry.resolveTask(old.id), old);

      const running = await h.registry.startTask(h.ctx, 'sleep forever', {
        name: 'Running retention pressure',
        notifyOnCompletion: false,
      });
      assert.equal(h.registry.resolveTask(old.id), old);
      assert.deepEqual(terminals, []);

      publicationGate.resolve(undefined);
      await h.registry.waitForTerminalPublications();
      assert.equal(old.terminalPublished, true);
      assert.equal(terminals.length, 1);
      assert.throws(() => h.registry.resolveTask(old.id), /Unknown background task ID/);
      assert.equal(h.registry.resolveTask(running.id), running);

      lastSpawn(h).child.close(0, null);
      await h.registry.waitForFinalization(running);
      await h.registry.waitForTerminalPublications();
    } finally {
      await cleanup(h.root);
    }
  });

  void it('keeps rejected terminal publication diagnosable and ineligible for pruning', async () => {
    const publicationGate = deferred<void>();
    const h = await createHarness({ platform: 'linux', maxRecentTasks: 1 });
    try {
      const old = await h.registry.startTask(h.ctx, 'printf old', {
        name: 'Rejected publication old task',
        notifyOnCompletion: false,
      });
      old.terminalPublicationGate = publicationGate.promise;
      lastSpawn(h).child.close(0, null);
      await h.registry.waitForFinalization(old);
      const running = await h.registry.startTask(h.ctx, 'sleep forever', {
        name: 'Running pressure after rejection',
        notifyOnCompletion: false,
      });

      publicationGate.reject(new Error('injected publication gate rejection'));
      await assert.rejects(
        h.registry.waitForTerminalPublications(),
        /injected publication gate rejection/,
      );
      assert.equal(old.finalizationSettled, true);
      assert.equal(old.terminalPublished, undefined);
      assert.equal(h.registry.resolveTask(old.id), old);
      assert.match(h.errors.flat().join(' '), /injected publication gate rejection/);

      lastSpawn(h).child.close(0, null);
      await h.registry.waitForFinalization(running);
      assert.equal(h.registry.resolveTask(old.id), old);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('keeps failed terminal EventBus delivery loud without an orphaned retry timer', async () => {
    let attempts = 0;
    const h = await createHarness({
      platform: 'linux',
      publishTerminal: () => {
        attempts += 1;
        throw new Error('terminal bus unavailable');
      },
    });
    try {
      const { task, child } = await startFakeTask(h, 'Terminal Failure');
      child.close(0, null);
      await h.registry.waitForFinalization(task);
      await assert.rejects(
        h.registry.waitForTerminalPublications(),
        /terminal bus unavailable/,
      );
      assert.equal(attempts, 1);
      assert.equal(task.terminalPublished, undefined);
      assert.ok(task.terminalPublicationPromise);
      assert.match(
        h.errors.flat().join(' '),
        /terminal publication failed|terminal bus unavailable/,
      );
    } finally {
      await cleanup(h.root);
    }
  });

  void it('resets notified when completion notification delivery fails and records loud metadata errors', async () => {
    const failingNotify = await createHarness({
      platform: 'linux',
      sendCompletionNotification: () => {
        throw new Error('send failed');
      },
    });
    try {
      const { task, child } = await startFakeTask(failingNotify, 'Notify Failure');
      child.close(0, null);
      await waitFor(() => task.status === 'completed', 'notification failure task completion');
      await waitFor(() => failingNotify.errors.length > 0, 'notification failure log');
      assert.equal(task.notified, false);
      const metadata = parseJsonObject(
        await readFile(task.metadataAbsPath, 'utf8'),
        'notification metadata must be an object',
      );
      assert.equal(metadata['notified'], false);
      assert.match(failingNotify.errors.flat().join(' '), /notification failed|send failed/);
    } finally {
      await cleanup(failingNotify.root);
    }

    const metadataFailure = await createHarness({ platform: 'linux' });
    try {
      const { task, child } = await startFakeTask(metadataFailure, 'Metadata Failure');
      await rm(join(metadataFailure.cwd, '.pi'), { recursive: true, force: true });
      child.close(0, null);
      await waitFor(() => task.status === 'failed', 'metadata failure task completion');
      await waitFor(
        () => metadataFailure.notifications.length === 1,
        'notification despite metadata failure',
      );
      await waitFor(() => metadataFailure.errors.length > 0, 'metadata failure log');
      assert.equal(task.notified, true);
      assert.match(task.error ?? '', /Terminal metadata write failed/);
      assert.match(
        metadataFailure.errors.flat().join(' '),
        /failed to (write failed terminal|write|update )?metadata|ENOENT/,
      );
    } finally {
      await cleanup(metadataFailure.root);
    }
  });

  void it('keeps phase-B tasks resolvable until settlement and prunes them only afterward', async () => {
    let clock = 1_000;
    let blockedRef: BgTask | undefined;
    const phaseAReached = deferred<void>();
    const phaseBGate = deferred<void>();
    const h = await createHarness({
      platform: 'linux',
      maxRecentTasks: 1,
      now: () => clock++,
      onChange: () => {
        if (blockedRef?.status === 'completed') phaseAReached.resolve(undefined);
      },
    });
    try {
      const blocked = await h.registry.startTask(h.ctx, 'printf blocked', {
        name: 'Blocked Phase B',
        notifyOnCompletion: true,
        triggerOnCompletion: false,
        terminalPublicationGate: phaseBGate.promise,
      });
      blockedRef = blocked;
      lastSpawn(h).child.close(0, null);
      await phaseAReached.promise;
      assert.equal(blocked.finalizationSettled, false);

      const newer = await h.registry.startTask(h.ctx, 'printf newer', {
        name: 'Newer Settled',
        notifyOnCompletion: false,
      });
      lastSpawn(h).child.close(0, null);
      await h.registry.waitForFinalization(newer);
      assert.equal(h.registry.resolveTask(blocked.id), blocked);
      assert.equal(
        h.registry.allTasks().includes(newer),
        false,
        'the settled newer task is removable while the older phase-B task is not',
      );

      phaseBGate.resolve(undefined);
      await h.registry.waitForFinalization(blocked);
      assert.equal(blocked.finalizationSettled, true);

      const newest = await h.registry.startTask(h.ctx, 'printf newest', {
        name: 'Newest Settled',
        notifyOnCompletion: false,
      });
      lastSpawn(h).child.close(0, null);
      await h.registry.waitForFinalization(newest);
      assert.throws(() => h.registry.resolveTask(blocked.id), /Unknown background task ID/);
      assert.equal(h.registry.resolveTask(newest.id), newest);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('prunes oldest finished tasks while preserving running tasks', async () => {
    let clock = 1_000;
    const h = await createHarness({
      platform: 'linux',
      maxRecentTasks: 3,
      now: () => clock++,
    });
    try {
      const running = await h.registry.startTask(h.ctx, 'sleep forever', {
        name: 'Still Running',
        notifyOnCompletion: false,
      });
      assert.equal(running.status, 'running');

      for (let i = 1; i <= 4; i++) {
        const suffix = String(i);
        const task = await h.registry.startTask(h.ctx, `printf ${suffix}`, {
          name: `Finished ${suffix}`,
          notifyOnCompletion: false,
        });
        lastSpawn(h).child.close(0, null);
        await waitFor(() => task.status === 'completed', `finished ${suffix}`);
      }

      await waitFor(() => h.registry.allTasks().length <= 3, 'old finished tasks pruned');
      const names = h.registry
        .allTasks()
        .map((task) => task.name)
        .sort();
      assert.deepEqual(names, ['Finished 3', 'Finished 4', 'Still Running'].sort());
    } finally {
      await cleanup(h.root);
    }
  });
});

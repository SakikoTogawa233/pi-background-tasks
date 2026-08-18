/**
 * Contract tests for BackgroundTaskRegistry.adoptRunningChild — the registry
 * bridge that lets the foreground-bash feature hand an already-running
 * process (backgrounded via Ctrl+B or the 120s auto-background timeout) over
 * to the background task registry.
 *
 * Adopted tasks must behave exactly like tasks the registry spawned itself:
 * output capture, finalization on close/error, single terminal notification,
 * and kill support through stopTask.
 *
 * These tests are the red phase of TDD: they fail until adoptRunningChild
 * lands on BackgroundTaskRegistry.
 *
 * Expected method contract:
 *   registry.adoptRunningChild(ctx, child, {
 *     command: string;
 *     name?: string;                    // default derived from command
 *     startedAt?: number;               // foreground start time (ms epoch)
 *     notifyOnCompletion?: boolean;     // default true
 *     triggerOnCompletion?: boolean;    // default true
 *   }): BgTask
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { BgTask } from '../../src/core/common.js';
import {
  BackgroundTaskRegistry,
  type BackgroundTaskContext,
  type CompletionNotificationMessage,
  type CompletionNotificationOptions,
} from '../../src/core/registry.js';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid: number;
  killCalls: Array<NodeJS.Signals | undefined> = [];

  constructor(pid: number) {
    super();
    this.pid = pid;
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

interface Harness {
  root: string;
  ctx: BackgroundTaskContext;
  registry: BackgroundTaskRegistry;
  notifications: Array<{
    message: CompletionNotificationMessage;
    options: CompletionNotificationOptions;
  }>;
}

async function createHarness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-adopt-'));
  const cwd = join(root, 'project');
  await mkdir(cwd, { recursive: true });
  let idSeq = 0;
  const notifications: Harness['notifications'] = [];
  const registry = new BackgroundTaskRegistry({
    logger: {
      error: () => {},
    },
    makeTaskId: () => `adopt${String(++idSeq).padStart(3, '0')}`,
    sendCompletionNotification: (message, options) => {
      notifications.push({ message, options });
    },
    onChange: () => {},
    killProcess: () => true,
  });
  const ctx: BackgroundTaskContext = {
    cwd,
    sessionId: 'adopt-test',
    modelRegistry: { getAll: () => [] },
    model: undefined,
  };
  return { root, ctx, registry, notifications };
}

async function cleanup(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

function notificationAt(
  h: Harness,
  index: number,
): { message: CompletionNotificationMessage; options: CompletionNotificationOptions } {
  const record = h.notifications[index];
  assert.ok(record, `expected notification #${String(index)}`);
  return record;
}

async function waitFor(
  predicate: () => boolean,
  message = 'condition',
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`Timed out waiting for ${message}`);
}

void describe('BackgroundTaskRegistry.adoptRunningChild', () => {
  void it('registers the running process as a first-class background task', async () => {
    const h = await createHarness();
    try {
      const child = new FakeChild(4242);
      const task = h.registry.adoptRunningChild(h.ctx, child, {
        command: 'npm test',
        name: 'fg-bash',
        startedAt: 1_700_000_000_000,
      });

      assert.equal(task.status, 'running');
      assert.equal(task.command, 'npm test');
      assert.equal(task.name, 'fg-bash');
      assert.equal(task.pid, 4242);
      assert.equal(task.startTime, 1_700_000_000_000);
      assert.equal(task.isAgent, false);
      assert.equal(h.registry.allTasks().includes(task), true);
      assert.equal(h.registry.resolveTask(task.id), task);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('captures child output into the task output file after adoption', async () => {
    const h = await createHarness();
    try {
      const child = new FakeChild(4243);
      const task = h.registry.adoptRunningChild(h.ctx, child, {
        command: 'npm test',
      });
      child.writeStdout('line one\n');
      child.writeStderr('warn two\n');
      await waitFor(() => task.bytesWritten > 0, 'adopted output capture');

      const text = readFileSync(task.outputAbsPath, 'utf8');
      assert.match(text, /line one/);
      assert.match(text, /warn two/);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('finalizes as completed on clean exit and notifies with a followUp turn', async () => {
    const h = await createHarness();
    try {
      const child = new FakeChild(4244);
      const task = h.registry.adoptRunningChild(h.ctx, child, {
        command: 'npm test',
        notifyOnCompletion: true,
        triggerOnCompletion: true,
      });
      child.close(0, null);
      await waitFor(() => task.status !== 'running', 'adopted finalization');
      await waitFor(() => h.notifications.length === 1, 'adopted notification');

      assert.equal(task.status, 'completed');
      assert.equal(task.exitCode, 0);
      assert.ok(task.endTime !== undefined, 'endTime must be recorded');
      assert.deepEqual(notificationAt(h, 0).options, {
        deliverAs: 'followUp',
        triggerTurn: true,
      });
      assert.equal(notificationAt(h, 0).message.details.id, task.id);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('finalizes as failed on non-zero exit', async () => {
    const h = await createHarness();
    try {
      const child = new FakeChild(4245);
      const task = h.registry.adoptRunningChild(h.ctx, child, {
        command: 'npm test',
      });
      child.writeStderr('1 failing suite\n');
      child.close(2, null);
      await waitFor(() => task.status !== 'running', 'adopted failure finalization');

      assert.equal(task.status, 'failed');
      assert.equal(task.exitCode, 2);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('suppresses the completion notification when notifyOnCompletion is false', async () => {
    const h = await createHarness();
    try {
      const child = new FakeChild(4246);
      const task = h.registry.adoptRunningChild(h.ctx, child, {
        command: 'npm test',
        notifyOnCompletion: false,
      });
      child.close(0, null);
      await waitFor(() => task.status !== 'running', 'silent adopted finalization');

      assert.equal(task.status, 'completed');
      assert.equal(h.notifications.length, 0);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('finalizes exactly once under error/close races', async () => {
    const h = await createHarness();
    try {
      const child = new FakeChild(4247);
      const task = h.registry.adoptRunningChild(h.ctx, child, {
        command: 'npm test',
        notifyOnCompletion: true,
      });
      child.fail(new Error('pipe exploded'));
      child.close(1, null);
      child.close(0, null);
      await waitFor(() => task.status !== 'running', 'raced adopted finalization');
      await waitFor(() => h.notifications.length === 1, 'single raced notification');

      assert.equal(task.status, 'failed');
      assert.equal(h.notifications.length, 1);
    } finally {
      await cleanup(h.root);
    }
  });

  void it('supports stopTask on an adopted task and marks it killed', async () => {
    const h = await createHarness();
    try {
      const child = new FakeChild(4248);
      const task: BgTask = h.registry.adoptRunningChild(h.ctx, child, {
        command: 'npm test',
      });
      await h.registry.stopTask(task, 'user');
      child.close(null, 'SIGTERM');
      await waitFor(() => task.status !== 'running', 'adopted kill finalization');

      assert.equal(task.status, 'killed');
      assert.ok(
        child.killCalls.length > 0 || task.killSignalSent,
        'stopTask must signal the adopted child',
      );
    } finally {
      await cleanup(h.root);
    }
  });

  void it('defaults startTime to the adoption moment when startedAt is omitted', async () => {
    const h = await createHarness();
    try {
      const before = Date.now();
      const task = h.registry.adoptRunningChild(h.ctx, new FakeChild(4249), {
        command: 'npm test',
      });
      const after = Date.now();
      assert.ok(
        task.startTime >= before && task.startTime <= after,
        `startTime ${String(task.startTime)} must fall within [${String(before)}, ${String(after)}]`,
      );
    } finally {
      await cleanup(h.root);
    }
  });
});

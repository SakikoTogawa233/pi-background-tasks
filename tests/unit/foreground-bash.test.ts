/**
 * Contract tests for the foreground-bash backgrounding feature (migrated from
 * pi-tau's Ctrl+B / auto-background design into this package).
 *
 * Feature under test (to be implemented in `src/core/foreground-bash.ts`):
 *
 * 1. The package overrides the built-in `bash` tool so a long-running
 *    foreground command is automatically moved to the background after
 *    `DEFAULT_AUTO_BACKGROUND_TIMEOUT_MS` (120_000 ms) of total runtime measured
 *    from child spawn. The 2s fast path controls only streaming and the Ctrl+B
 *    hint. The model may override the threshold per call with a `timeout`
 *    parameter (seconds).
 * 2. `Ctrl+B` manually backgrounds the currently running foreground bash
 *    process via a signal-based handoff (`triggerBackground()`), resolving the
 *    tool call immediately while the process keeps running.
 * 3. Backgrounded processes are adopted into the BackgroundTaskRegistry as
 *    first-class tasks (visible to bg_status/bg_logs/bg_kill and the UI).
 * 4. Guards:
 *    - non-interactive sessions (`pi -p`) never auto-background or kill on
 *      timeout; the command runs to completion;
 *    - standalone `sleep N` (N >= 2s) is rejected before spawn;
 *    - commands whose base command is disallowed (`sleep`) are killed at the
 *      timeout instead of being backgrounded;
 *    - a finished tool call's timer must never affect a concurrent call.
 *
 * These tests are the red phase of TDD: they define the public contract below
 * and fail until `src/core/foreground-bash.ts` lands.
 *
 * Expected public surface of src/core/foreground-bash.ts:
 *   - DEFAULT_AUTO_BACKGROUND_TIMEOUT_MS = 120_000
 *   - FAST_PATH_GRACE_MS = 2_000
 *   - BACKGROUND_HINT_DELAY_MS = 2_000
 *   - isAutoBackgroundAllowed(command: string): boolean
 *   - detectBlockedSleep(command: string): string | undefined
 *   - createForegroundBashExecutor(deps): ForegroundBashController
 *       controller.execute(params, ctx, signal?, onUpdate?): Promise<ToolResult>
 *       controller.triggerBackground(): boolean
 *       controller.hasForegroundProcess(): boolean
 *   - background handoff messages use customType `foreground-bash-backgrounded`
 *     with details { taskId, command, outputPath, reason, timeoutSeconds }
 *   - registerForegroundBashFeature(pi, controller): void
 *       registers the `bash` tool override and the `ctrl+b` shortcut
 */
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { describe, it, mock } from 'node:test';
import {
  BACKGROUND_HINT_DELAY_MS,
  DEFAULT_AUTO_BACKGROUND_TIMEOUT_MS,
  FAST_PATH_GRACE_MS,
  createForegroundBashExecutor,
  detectBlockedSleep,
  isAutoBackgroundAllowed,
  registerForegroundBashFeature,
  type ForegroundBashExecutorDeps,
} from '../../src/core/foreground-bash.js';

// ─── Fakes ──────────────────────────────────────────────────────────

class FakeBashChild extends EventEmitter {
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

interface SpawnRecord {
  child: FakeBashChild;
  file: string;
  args: string[];
  options: Record<string, unknown>;
}

interface AdoptRecord {
  child: FakeBashChild;
  command: string;
  outputPath: string;
  startedAt: number;
  name?: string | undefined;
}

interface MessageRecord {
  message: { customType: string; content: string; display: boolean; details?: unknown };
  options: { deliverAs: string; triggerTurn: boolean };
}

interface NotifyRecord {
  text: string;
  level: string;
}

interface GroupKillRecord {
  pid: number;
  signal: NodeJS.Signals;
}

interface Harness {
  deps: ForegroundBashExecutorDeps;
  spawns: SpawnRecord[];
  adopted: AdoptRecord[];
  messages: MessageRecord[];
  notifications: NotifyRecord[];
  groupKills: GroupKillRecord[];
}

function createHarness(overrides: Partial<ForegroundBashExecutorDeps> = {}): Harness {
  let pid = 9000;
  let adoptSeq = 0;
  const spawns: SpawnRecord[] = [];
  const adopted: AdoptRecord[] = [];
  const messages: MessageRecord[] = [];
  const notifications: NotifyRecord[] = [];
  const groupKills: GroupKillRecord[] = [];
  const deps: ForegroundBashExecutorDeps = {
    spawn: (file: string, args: string[], options: Record<string, unknown>) => {
      const child = new FakeBashChild(++pid);
      spawns.push({ child, file, args: [...args], options: { ...options } });
      return child;
    },
    adoptTask: (input: Omit<AdoptRecord, 'child'> & { child: unknown }) => {
      adopted.push({ ...input, child: input.child as FakeBashChild });
      return { taskId: `task-${String(++adoptSeq).padStart(3, '0')}` };
    },
    sendMessage: (message: MessageRecord['message'], options: MessageRecord['options']) => {
      messages.push({ message, options });
    },
    outputPathForCall: (toolCallId: string) => `/tmp/fg-bash-test/${toolCallId}.output`,
    killProcessGroup: (pidToKill: number, signal: NodeJS.Signals) => {
      groupKills.push({ pid: pidToKill, signal });
    },
    notify: (text: string, level: NotifyRecord['level']) => {
      notifications.push({ text, level });
    },
    ...overrides,
  };
  return { deps, spawns, adopted, messages, notifications, groupKills };
}

/** Flush pending microtasks so promise continuations settle. */
async function flush(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
  }
}

function spawnAt(harness: Harness, index: number): SpawnRecord {
  const record = harness.spawns[index];
  assert.ok(record, `expected spawn record #${String(index)}`);
  return record;
}

function adoptAt(harness: Harness, index: number): AdoptRecord {
  const record = harness.adopted[index];
  assert.ok(record, `expected adopt record #${String(index)}`);
  return record;
}

function messageAt(harness: Harness, index: number): MessageRecord {
  const record = harness.messages[index];
  assert.ok(record, `expected message record #${String(index)}`);
  return record;
}

interface TextResult {
  content: Array<{ type: 'text'; text: string }>;
}

function resultText(result: TextResult): string {
  const first = result.content[0];
  assert.ok(first, 'tool result must contain a first text block');
  return first.text;
}

function enableMockTimers(): void {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000 });
}

function assertExecutorListenersRemoved(child: FakeBashChild, signal?: AbortSignal): void {
  assert.equal(child.listenerCount('error'), 0, 'child error listener must be removed');
  assert.equal(child.listenerCount('close'), 0, 'child close listener must be removed');
  assert.equal(child.stdout.listenerCount('data'), 0, 'stdout listener must be removed');
  assert.equal(child.stderr.listenerCount('data'), 0, 'stderr listener must be removed');
  if (signal !== undefined) {
    assert.equal(getEventListeners(signal, 'abort').length, 0, 'abort listener must be removed');
  }
}

// ─── Constants ──────────────────────────────────────────────────────

void describe('foreground-bash constants', () => {
  void it('defaults to a 120s auto-background timeout', () => {
    assert.equal(DEFAULT_AUTO_BACKGROUND_TIMEOUT_MS, 120_000);
  });

  void it('keeps a 2s fast-path grace and hint delay', () => {
    assert.equal(FAST_PATH_GRACE_MS, 2_000);
    assert.equal(BACKGROUND_HINT_DELAY_MS, 2_000);
  });
});

// ─── Pure helpers ───────────────────────────────────────────────────

void describe('isAutoBackgroundAllowed', () => {
  void it('blocks the sleep base command', () => {
    assert.equal(isAutoBackgroundAllowed('sleep'), false);
    assert.equal(isAutoBackgroundAllowed('sleep 5'), false);
    assert.equal(isAutoBackgroundAllowed('sleep infinity'), false);
    assert.equal(isAutoBackgroundAllowed('   sleep 5'), false);
  });

  void it('allows ordinary commands', () => {
    assert.equal(isAutoBackgroundAllowed('npm test'), true);
    assert.equal(isAutoBackgroundAllowed('echo hi'), true);
    assert.equal(isAutoBackgroundAllowed('sleeper --watch'), true);
    assert.equal(isAutoBackgroundAllowed('make sleep-target'), true);
  });
});

void describe('detectBlockedSleep', () => {
  void it('matches standalone sleep of 2s or more', () => {
    assert.equal(detectBlockedSleep('sleep 2'), 'sleep 2');
    assert.equal(detectBlockedSleep('sleep 5'), 'sleep 5');
    assert.equal(detectBlockedSleep('  sleep 10  '), 'sleep 10');
    assert.equal(detectBlockedSleep('sleep 2.5'), 'sleep 2.5');
  });

  void it('matches sleep leading a compound command', () => {
    assert.equal(detectBlockedSleep('sleep 5 && echo done'), 'sleep 5');
    assert.equal(detectBlockedSleep('sleep 3; echo done'), 'sleep 3');
    assert.equal(detectBlockedSleep('sleep 3 | cat'), 'sleep 3');
  });

  void it('allows sub-2s pacing sleeps', () => {
    assert.equal(detectBlockedSleep('sleep 1'), undefined);
    assert.equal(detectBlockedSleep('sleep 0.5'), undefined);
    assert.equal(detectBlockedSleep('sleep 1.9'), undefined);
  });

  void it('ignores non-sleep commands and non-numeric durations', () => {
    assert.equal(detectBlockedSleep('npm test'), undefined);
    assert.equal(detectBlockedSleep('echo sleep 5'), undefined);
    assert.equal(detectBlockedSleep('echo x | sleep 5'), undefined);
    assert.equal(detectBlockedSleep('sleep'), undefined);
    assert.equal(detectBlockedSleep('sleep infinity'), undefined);
    assert.equal(detectBlockedSleep(''), undefined);
  });
});

// ─── Executor: fast path ────────────────────────────────────────────

void describe('executor fast path', () => {
  void it('returns full output when the command finishes within the grace period', async () => {
    enableMockTimers();
    try {
      const harness = createHarness();
      const executor = createForegroundBashExecutor(harness.deps);
      const pending = executor.execute(
        { command: 'echo hello' },
        { toolCallId: 'call-fast', cwd: '/work' },
      );
      await flush();
      spawnAt(harness, 0).child.writeStdout('hello\n');
      spawnAt(harness, 0).child.close(0);
      const result = await pending;
      assert.match(resultText(result), /hello/);
      assert.equal(harness.adopted.length, 0);
      assert.equal(harness.messages.length, 0);
      assert.equal(harness.groupKills.length, 0);
      assert.equal(executor.hasForegroundProcess(), false);
    } finally {
      mock.timers.reset();
    }
  });

  void it('throws with output when a fast command exits non-zero', async () => {
    enableMockTimers();
    try {
      const harness = createHarness();
      const executor = createForegroundBashExecutor(harness.deps);
      const pending = executor.execute(
        { command: 'false-ish' },
        { toolCallId: 'call-fail', cwd: '/work' },
      );
      await flush();
      spawnAt(harness, 0).child.writeStderr('boom\n');
      spawnAt(harness, 0).child.close(3);
      await assert.rejects(pending, /boom|code 3/);
      assert.equal(harness.adopted.length, 0);
      assert.equal(harness.messages.length, 0);
      assertExecutorListenersRemoved(spawnAt(harness, 0).child);
      mock.timers.tick(DEFAULT_AUTO_BACKGROUND_TIMEOUT_MS * 2);
      await flush();
      assert.equal(harness.notifications.length, 0);
      assert.equal(harness.groupKills.length, 0);
    } finally {
      mock.timers.reset();
    }
  });

  void it('spawns bash -c detached in the caller cwd', async () => {
    enableMockTimers();
    try {
      const harness = createHarness();
      const executor = createForegroundBashExecutor(harness.deps);
      const pending = executor.execute(
        { command: 'pwd' },
        { toolCallId: 'call-spawn', cwd: '/work/project' },
      );
      await flush();
      assert.equal(harness.spawns.length, 1);
      assert.equal(spawnAt(harness, 0).file, 'bash');
      assert.deepEqual(spawnAt(harness, 0).args, ['-c', 'pwd']);
      assert.equal(spawnAt(harness, 0).options['cwd'], '/work/project');
      assert.equal(spawnAt(harness, 0).options['detached'], true);
      spawnAt(harness, 0).child.close(0);
      await pending;
    } finally {
      mock.timers.reset();
    }
  });

  void it('rejects when the process errors before closing', async () => {
    enableMockTimers();
    try {
      const harness = createHarness();
      const executor = createForegroundBashExecutor(harness.deps);
      const pending = executor.execute(
        { command: 'x' },
        { toolCallId: 'call-err', cwd: '/work' },
      );
      await flush();
      spawnAt(harness, 0).child.fail(new Error('spawn bash ENOENT'));
      await assert.rejects(pending, /ENOENT/);
      assert.equal(harness.adopted.length, 0);
      assertExecutorListenersRemoved(spawnAt(harness, 0).child);
      mock.timers.tick(DEFAULT_AUTO_BACKGROUND_TIMEOUT_MS * 2);
      await flush();
      assert.equal(harness.notifications.length, 0);
      assert.equal(harness.groupKills.length, 0);
    } finally {
      mock.timers.reset();
    }
  });
});

// ─── Executor: sleep guard ──────────────────────────────────────────

void describe('executor sleep guard', () => {
  void it('rejects standalone sleep >= 2s before spawning', async () => {
    const harness = createHarness();
    const executor = createForegroundBashExecutor(harness.deps);
    await assert.rejects(
      executor.execute({ command: 'sleep 30' }, { toolCallId: 'call-sleep', cwd: '/work' }),
      /[Bb]locked.*sleep|sleep.*[Bb]locked/,
    );
    assert.equal(harness.spawns.length, 0);
  });

  void it('permits sub-2s sleep to spawn normally', async () => {
    enableMockTimers();
    try {
      const harness = createHarness();
      const executor = createForegroundBashExecutor(harness.deps);
      const pending = executor.execute(
        { command: 'sleep 0.5' },
        { toolCallId: 'call-tiny-sleep', cwd: '/work' },
      );
      await flush();
      assert.equal(harness.spawns.length, 1);
      spawnAt(harness, 0).child.close(0);
      await pending;
    } finally {
      mock.timers.reset();
    }
  });
});

// ─── Executor: 120s auto-background ─────────────────────────────────

void describe('executor auto-background', () => {
  void it('backgrounds a still-running command after 120s and adopts it as a task', async () => {
    enableMockTimers();
    try {
      const harness = createHarness();
      const executor = createForegroundBashExecutor(harness.deps);
      const pending = executor.execute(
        { command: 'npm test' },
        { toolCallId: 'call-auto', cwd: '/work' },
      );
      await flush();
      mock.timers.tick(FAST_PATH_GRACE_MS);
      await flush();
      assert.equal(harness.adopted.length, 0, 'must not background during the fast-path grace');

      mock.timers.tick(DEFAULT_AUTO_BACKGROUND_TIMEOUT_MS - FAST_PATH_GRACE_MS - 1);
      await flush();
      assert.equal(harness.adopted.length, 0, 'must not background before total t=120s');
      mock.timers.tick(1);
      await flush();
      const result = await pending;

      assert.match(resultText(result), /backgrounded/i);
      assert.match(resultText(result), /task-001/);
      assert.equal(harness.adopted.length, 1);
      assert.equal(adoptAt(harness, 0).command, 'npm test');
      assert.equal(adoptAt(harness, 0).outputPath, '/tmp/fg-bash-test/call-auto.output');
      assert.equal(adoptAt(harness, 0).child, spawnAt(harness, 0).child);
      assert.equal(adoptAt(harness, 0).startedAt, 1_000, 'runtime starts when the child spawns');
      assert.equal(harness.groupKills.length, 0, 'backgrounded processes must not be killed');
      assert.equal(executor.hasForegroundProcess(), false);
    } finally {
      mock.timers.reset();
    }
  });

  void it('notifies the agent loop as a followUp turn after auto-background', async () => {
    enableMockTimers();
    try {
      const harness = createHarness();
      const executor = createForegroundBashExecutor(harness.deps);
      const pending = executor.execute(
        { command: 'npm test' },
        { toolCallId: 'call-notify', cwd: '/work' },
      );
      await flush();
      mock.timers.tick(DEFAULT_AUTO_BACKGROUND_TIMEOUT_MS);
      await flush();
      await pending;

      assert.equal(harness.messages.length, 1);
      assert.equal(messageAt(harness, 0).message.customType, 'foreground-bash-backgrounded');
      assert.equal(messageAt(harness, 0).message.display, true);
      assert.equal(messageAt(harness, 0).options.deliverAs, 'followUp');
      assert.equal(messageAt(harness, 0).options.triggerTurn, true);
      assert.deepEqual(messageAt(harness, 0).message.details, {
        taskId: 'task-001',
        command: 'npm test',
        outputPath: '/tmp/fg-bash-test/call-notify.output',
        reason: 'timeout',
        timeoutSeconds: 120,
      });
      assert.match(messageAt(harness, 0).message.content, /backgrounded/i);
      assert.match(messageAt(harness, 0).message.content, /task-001/);
      assert.match(messageAt(harness, 0).message.content, /npm test/);
      assert.match(
        messageAt(harness, 0).message.content,
        /\/tmp\/fg-bash-test\/call-notify\.output/,
      );
      assert.match(messageAt(harness, 0).message.content, /120/);
    } finally {
      mock.timers.reset();
    }
  });

  void it('honours a per-call timeout parameter (seconds) over the 120s default', async () => {
    enableMockTimers();
    try {
      const harness = createHarness();
      const executor = createForegroundBashExecutor(harness.deps);
      const pending = executor.execute(
        { command: 'npm test', timeout: 5 },
        { toolCallId: 'call-custom', cwd: '/work' },
      );
      await flush();
      mock.timers.tick(4_999);
      await flush();
      assert.equal(harness.adopted.length, 0, 'must not background before total t=5s');
      mock.timers.tick(1);
      await flush();
      const result = await pending;
      assert.match(resultText(result), /backgrounded/i);
      assert.equal(harness.adopted.length, 1);
      assert.deepEqual(messageAt(harness, 0).message.details, {
        taskId: 'task-001',
        command: 'npm test',
        outputPath: '/tmp/fg-bash-test/call-custom.output',
        reason: 'timeout',
        timeoutSeconds: 5,
      });
    } finally {
      mock.timers.reset();
    }
  });

  void it('lets an explicit timeout expire before the 2s streaming grace', async () => {
    enableMockTimers();
    try {
      const harness = createHarness();
      const executor = createForegroundBashExecutor(harness.deps);
      const pending = executor.execute(
        { command: 'npm test', timeout: 1 },
        { toolCallId: 'call-short-timeout', cwd: '/work' },
      );
      await flush();
      mock.timers.tick(999);
      await flush();
      assert.equal(harness.adopted.length, 0);
      mock.timers.tick(1);
      await flush();
      const result = await pending;

      assert.match(resultText(result), /backgrounded/i);
      assert.equal(harness.adopted.length, 1);
      assert.equal(
        harness.notifications.filter((entry) => /ctrl\+b/i.test(entry.text)).length,
        0,
        'the hint timer is independent and must not delay auto-backgrounding',
      );
    } finally {
      mock.timers.reset();
    }
  });

  void it('lets completion at the timeout boundary win when close is observed first', async () => {
    enableMockTimers();
    try {
      const harness = createHarness();
      const executor = createForegroundBashExecutor(harness.deps);
      const pending = executor.execute(
        { command: 'npm test' },
        { toolCallId: 'call-boundary-close', cwd: '/work' },
      );
      await flush();

      mock.timers.setTime(1_000 + DEFAULT_AUTO_BACKGROUND_TIMEOUT_MS);
      spawnAt(harness, 0).child.writeStdout('finished at boundary\n');
      spawnAt(harness, 0).child.close(0);
      const result = await pending;
      mock.timers.tick(0);
      await flush();

      assert.match(resultText(result), /finished at boundary/);
      assert.equal(harness.adopted.length, 0);
      assert.equal(harness.messages.length, 0);
      assert.equal(harness.groupKills.length, 0);
    } finally {
      mock.timers.reset();
    }
  });

  void it('does not emit a second agent message when the adopted process later exits', async () => {
    enableMockTimers();
    try {
      const harness = createHarness();
      const executor = createForegroundBashExecutor(harness.deps);
      const pending = executor.execute(
        { command: 'npm test' },
        { toolCallId: 'call-once', cwd: '/work' },
      );
      await flush();
      mock.timers.tick(DEFAULT_AUTO_BACKGROUND_TIMEOUT_MS);
      await flush();
      await pending;
      assert.equal(harness.messages.length, 1);

      // Ownership of completion reporting transfers to the registry via adoptTask.
      spawnAt(harness, 0).child.close(0);
      await flush();
      assert.equal(harness.messages.length, 1, 'executor must not duplicate completion notices');
    } finally {
      mock.timers.reset();
    }
  });
});

// ─── Executor: timeout guards ───────────────────────────────────────

void describe('executor timeout guards', () => {
  void it('never auto-backgrounds or kills in non-interactive sessions', async () => {
    enableMockTimers();
    try {
      const harness = createHarness({ nonInteractive: true });
      const executor = createForegroundBashExecutor(harness.deps);
      const pending = executor.execute(
        { command: 'npm test' },
        { toolCallId: 'call-noninteractive', cwd: '/work' },
      );
      await flush();
      mock.timers.tick(DEFAULT_AUTO_BACKGROUND_TIMEOUT_MS * 3);
      await flush();
      assert.equal(harness.adopted.length, 0);
      assert.equal(harness.groupKills.length, 0);
      assert.equal(harness.messages.length, 0);

      spawnAt(harness, 0).child.writeStdout('done\n');
      spawnAt(harness, 0).child.close(0);
      const result = await pending;
      assert.match(resultText(result), /done/);
    } finally {
      mock.timers.reset();
    }
  });

  void it('kills disallowed commands at the timeout instead of backgrounding them', async () => {
    enableMockTimers();
    try {
      const harness = createHarness();
      const executor = createForegroundBashExecutor(harness.deps);
      // `sleep infinity` slips past detectBlockedSleep (non-numeric) but the
      // base command is disallowed, so the timeout must kill, not background.
      const pending = executor.execute(
        { command: 'sleep infinity' },
        { toolCallId: 'call-disallowed', cwd: '/work' },
      );
      await flush();
      mock.timers.tick(DEFAULT_AUTO_BACKGROUND_TIMEOUT_MS);
      await flush();

      assert.equal(harness.adopted.length, 0, 'disallowed commands must not be adopted');
      assert.equal(harness.messages.length, 0);
      assert.deepEqual(harness.groupKills, [
        { pid: spawnAt(harness, 0).child.pid, signal: 'SIGTERM' },
      ]);

      spawnAt(harness, 0).child.close(143, 'SIGTERM');
      const result = await pending;
      assert.ok(Array.isArray(result.content));
    } finally {
      mock.timers.reset();
    }
  });

  void it('a finished call’s stale timer never backgrounds a concurrent call', async () => {
    enableMockTimers();
    try {
      const harness = createHarness();
      const executor = createForegroundBashExecutor(harness.deps);
      const fast = executor.execute(
        { command: 'echo a' },
        { toolCallId: 'call-a', cwd: '/work' },
      );
      const slow = executor.execute(
        { command: 'npm run build' },
        { toolCallId: 'call-b', cwd: '/work' },
      );
      await flush();
      // A finishes inside the grace period; its timeout timer must be dead.
      spawnAt(harness, 0).child.writeStdout('a\n');
      spawnAt(harness, 0).child.close(0);
      await fast;

      // Just before B's own timeout: nothing may be adopted, and A's stale
      // timer must not leak into B.
      mock.timers.tick(DEFAULT_AUTO_BACKGROUND_TIMEOUT_MS - 1_000);
      await flush();
      assert.equal(harness.adopted.length, 0);

      // Past 120s: A's stale timer fires as a no-op; B backgrounds exactly once.
      mock.timers.tick(2_000);
      await flush();
      await slow;
      assert.equal(harness.adopted.length, 1);
      assert.equal(adoptAt(harness, 0).command, 'npm run build');
    } finally {
      mock.timers.reset();
    }
  });

  void it('rejects a duplicate active toolCallId before a second spawn', async () => {
    enableMockTimers();
    try {
      const harness = createHarness();
      const executor = createForegroundBashExecutor(harness.deps);
      const first = executor.execute(
        { command: 'first-long' },
        { toolCallId: 'call-duplicate', cwd: '/work' },
      );
      await flush();

      const duplicate = assert.rejects(
        executor.execute(
          { command: 'second-long' },
          { toolCallId: 'call-duplicate', cwd: '/work' },
        ),
        /toolCallId|tool call.*active|duplicate/i,
      );
      await flush();
      assert.equal(harness.spawns.length, 1, 'duplicate rejection must happen before spawn');
      await duplicate;

      spawnAt(harness, 0).child.close(0);
      await first;
    } finally {
      mock.timers.reset();
    }
  });
});

// ─── Executor: Ctrl+B manual background ─────────────────────────────

void describe('executor triggerBackground (Ctrl+B)', () => {
  void it('backgrounds immediately when Ctrl+B is pressed before the 2s grace expires', async () => {
    enableMockTimers();
    try {
      const harness = createHarness();
      const executor = createForegroundBashExecutor(harness.deps);
      const pending = executor.execute(
        { command: 'dev-server' },
        { toolCallId: 'call-ctrlb', cwd: '/work' },
      );
      await flush();
      assert.equal(executor.hasForegroundProcess(), true);

      assert.equal(executor.triggerBackground(), true);
      await flush();
      const result = await pending;

      assert.match(resultText(result), /backgrounded/i);
      assert.equal(harness.adopted.length, 1);
      assert.equal(adoptAt(harness, 0).command, 'dev-server');
      assert.equal(harness.groupKills.length, 0);
      assert.equal(harness.messages.length, 1);
      assert.equal(messageAt(harness, 0).message.customType, 'foreground-bash-backgrounded');
      assert.equal(messageAt(harness, 0).message.display, true);
      assert.deepEqual(messageAt(harness, 0).message.details, {
        taskId: 'task-001',
        command: 'dev-server',
        outputPath: '/tmp/fg-bash-test/call-ctrlb.output',
        reason: 'manual',
        timeoutSeconds: 120,
      });
      assert.equal(harness.notifications.length, 0, 'Ctrl+B must not wait for the hint timer');
      // The process outlives the tool call.
      assert.equal(spawnAt(harness, 0).child.killCalls.length, 0);
    } finally {
      mock.timers.reset();
    }
  });

  void it('returns false when nothing is running in the foreground', () => {
    const harness = createHarness();
    const executor = createForegroundBashExecutor(harness.deps);
    assert.equal(executor.triggerBackground(), false);
    assert.equal(executor.hasForegroundProcess(), false);
  });

  void it('targets the most recent foreground call when several run concurrently', async () => {
    enableMockTimers();
    try {
      const harness = createHarness();
      const executor = createForegroundBashExecutor(harness.deps);
      const first = executor.execute(
        { command: 'first-long' },
        { toolCallId: 'call-first', cwd: '/work' },
      );
      const second = executor.execute(
        { command: 'second-long' },
        { toolCallId: 'call-second', cwd: '/work' },
      );
      await flush();
      mock.timers.tick(FAST_PATH_GRACE_MS);
      await flush();

      assert.equal(executor.triggerBackground(), true);
      await flush();
      await second;
      assert.equal(harness.adopted.length, 1);
      assert.equal(adoptAt(harness, 0).command, 'second-long');

      // The first call is still foreground and remains triggerable.
      assert.equal(executor.hasForegroundProcess(), true);
      assert.equal(executor.triggerBackground(), true);
      await flush();
      await first;
      assert.equal(harness.adopted.length, 2);
      assert.equal(adoptAt(harness, 1).command, 'first-long');
    } finally {
      mock.timers.reset();
    }
  });

  void it('settles exactly once when completion races Ctrl+B in either order', async () => {
    enableMockTimers();
    try {
      const manualHarness = createHarness();
      const manualExecutor = createForegroundBashExecutor(manualHarness.deps);
      let manualSettlements = 0;
      const manual = manualExecutor
        .execute(
          { command: 'manual-wins' },
          { toolCallId: 'call-race-manual', cwd: '/work' },
        )
        .finally(() => {
          manualSettlements += 1;
        });
      await flush();
      assert.equal(manualExecutor.triggerBackground(), true);
      spawnAt(manualHarness, 0).child.close(0);
      await manual;
      await flush();
      assert.equal(manualSettlements, 1);
      assert.equal(manualHarness.adopted.length, 1);
      assert.equal(manualHarness.messages.length, 1);

      const closeHarness = createHarness();
      const closeExecutor = createForegroundBashExecutor(closeHarness.deps);
      let closeSettlements = 0;
      const completed = closeExecutor
        .execute(
          { command: 'close-wins' },
          { toolCallId: 'call-race-close', cwd: '/work' },
        )
        .finally(() => {
          closeSettlements += 1;
        });
      await flush();
      spawnAt(closeHarness, 0).child.close(0);
      await completed;
      assert.equal(closeExecutor.triggerBackground(), false);
      await flush();
      assert.equal(closeSettlements, 1);
      assert.equal(closeHarness.adopted.length, 0);
      assert.equal(closeHarness.messages.length, 0);
    } finally {
      mock.timers.reset();
    }
  });

  void it('a timed-out call that was backgrounded cannot be backgrounded twice', async () => {
    enableMockTimers();
    try {
      const harness = createHarness();
      const executor = createForegroundBashExecutor(harness.deps);
      const pending = executor.execute(
        { command: 'npm test' },
        { toolCallId: 'call-double', cwd: '/work' },
      );
      await flush();
      mock.timers.tick(DEFAULT_AUTO_BACKGROUND_TIMEOUT_MS);
      await flush();
      await pending;
      assert.equal(executor.triggerBackground(), false);
      assert.equal(harness.adopted.length, 1);
    } finally {
      mock.timers.reset();
    }
  });
});

// ─── Executor: streaming and hint ───────────────────────────────────

void describe('executor streaming and hint', () => {
  void it('streams output via onUpdate once the fast-path grace has elapsed', async () => {
    enableMockTimers();
    try {
      const harness = createHarness();
      const executor = createForegroundBashExecutor(harness.deps);
      const updates: string[] = [];
      const pending = executor.execute(
        { command: 'npm test' },
        { toolCallId: 'call-stream', cwd: '/work' },
        undefined,
        (update: TextResult) => {
          updates.push(update.content.map((block) => block.text).join('\n'));
        },
      );
      await flush();
      mock.timers.tick(FAST_PATH_GRACE_MS);
      await flush();
      spawnAt(harness, 0).child.writeStdout('tests passing: 5\n');
      await flush();
      assert.ok(
        updates.some((text) => text.includes('tests passing: 5')),
        `expected streamed output, got ${JSON.stringify(updates)}`,
      );
      spawnAt(harness, 0).child.close(0);
      await pending;
    } finally {
      mock.timers.reset();
    }
  });

  void it('shows a Ctrl+B hint while a command runs past the hint delay', async () => {
    enableMockTimers();
    try {
      const harness = createHarness();
      const executor = createForegroundBashExecutor(harness.deps);
      const pending = executor.execute(
        { command: 'npm test' },
        { toolCallId: 'call-hint', cwd: '/work' },
      );
      await flush();
      mock.timers.tick(BACKGROUND_HINT_DELAY_MS);
      await flush();
      assert.ok(
        harness.notifications.some((entry) => /ctrl\+b/i.test(entry.text)),
        `expected a Ctrl+B hint, got ${JSON.stringify(harness.notifications)}`,
      );
      spawnAt(harness, 0).child.close(0);
      await pending;
    } finally {
      mock.timers.reset();
    }
  });

  void it('does not show the hint for commands that finish quickly', async () => {
    enableMockTimers();
    try {
      const harness = createHarness();
      const executor = createForegroundBashExecutor(harness.deps);
      const pending = executor.execute(
        { command: 'echo hi' },
        { toolCallId: 'call-no-hint', cwd: '/work' },
      );
      await flush();
      spawnAt(harness, 0).child.close(0);
      await pending;
      mock.timers.tick(BACKGROUND_HINT_DELAY_MS * 2);
      await flush();
      assert.equal(
        harness.notifications.filter((entry) => /ctrl\+b/i.test(entry.text)).length,
        0,
      );
    } finally {
      mock.timers.reset();
    }
  });
});

// ─── Executor: abort ────────────────────────────────────────────────

void describe('executor abort handling', () => {
  void it('rejects a pre-aborted signal before spawning', async () => {
    enableMockTimers();
    try {
      const harness = createHarness();
      const executor = createForegroundBashExecutor(harness.deps);
      const controller = new AbortController();
      controller.abort(new Error('already aborted'));
      const pending = executor.execute(
        { command: 'must-not-spawn' },
        { toolCallId: 'call-pre-aborted', cwd: '/work' },
        controller.signal,
      );
      const rejected = assert.rejects(pending, /abort/i);

      await flush();
      assert.equal(harness.spawns.length, 0);
      await rejected;
      assert.equal(executor.hasForegroundProcess(), false);
    } finally {
      mock.timers.reset();
    }
  });

  void it('kills the process group and rejects when the abort signal fires', async () => {
    enableMockTimers();
    try {
      const harness = createHarness();
      const executor = createForegroundBashExecutor(harness.deps);
      const controller = new AbortController();
      const pending = executor.execute(
        { command: 'npm test' },
        { toolCallId: 'call-abort', cwd: '/work' },
        controller.signal,
      );
      await flush();
      controller.abort();
      await flush();
      assert.deepEqual(harness.groupKills, [
        { pid: spawnAt(harness, 0).child.pid, signal: 'SIGTERM' },
      ]);
      spawnAt(harness, 0).child.close(143, 'SIGTERM');
      await assert.rejects(pending, /abort/i);
      assert.equal(harness.adopted.length, 0);
      assert.equal(executor.hasForegroundProcess(), false);
      assertExecutorListenersRemoved(spawnAt(harness, 0).child, controller.signal);
      mock.timers.tick(DEFAULT_AUTO_BACKGROUND_TIMEOUT_MS * 2);
      await flush();
      assert.equal(harness.messages.length, 0);
      assert.equal(harness.notifications.length, 0);
    } finally {
      mock.timers.reset();
    }
  });

  void it('does not kill an adopted task when aborted after manual handoff', async () => {
    enableMockTimers();
    try {
      const harness = createHarness();
      const executor = createForegroundBashExecutor(harness.deps);
      const controller = new AbortController();
      const pending = executor.execute(
        { command: 'manual-server' },
        { toolCallId: 'call-manual-abort', cwd: '/work' },
        controller.signal,
      );
      await flush();
      assert.equal(executor.triggerBackground(), true);
      await pending;
      assertExecutorListenersRemoved(spawnAt(harness, 0).child, controller.signal);

      controller.abort();
      mock.timers.tick(DEFAULT_AUTO_BACKGROUND_TIMEOUT_MS * 2);
      await flush();
      assert.equal(harness.adopted.length, 1);
      assert.equal(harness.groupKills.length, 0);
      assert.equal(spawnAt(harness, 0).child.killCalls.length, 0);
      assert.equal(harness.messages.length, 1);
    } finally {
      mock.timers.reset();
    }
  });

  void it('does not kill an adopted task when aborted after automatic handoff', async () => {
    enableMockTimers();
    try {
      const harness = createHarness();
      const executor = createForegroundBashExecutor(harness.deps);
      const controller = new AbortController();
      const pending = executor.execute(
        { command: 'automatic-server', timeout: 5 },
        { toolCallId: 'call-auto-abort', cwd: '/work' },
        controller.signal,
      );
      await flush();
      mock.timers.tick(5_000);
      await flush();
      await pending;
      assertExecutorListenersRemoved(spawnAt(harness, 0).child, controller.signal);

      controller.abort();
      mock.timers.tick(DEFAULT_AUTO_BACKGROUND_TIMEOUT_MS * 2);
      await flush();
      assert.equal(harness.adopted.length, 1);
      assert.equal(harness.groupKills.length, 0);
      assert.equal(spawnAt(harness, 0).child.killCalls.length, 0);
      assert.equal(harness.messages.length, 1);
    } finally {
      mock.timers.reset();
    }
  });

  void it('kills the process group and rejects when adoptTask fails', async () => {
    enableMockTimers();
    try {
      const harness = createHarness({
        adoptTask: () => {
          throw new Error('registry adoption failed');
        },
      });
      const executor = createForegroundBashExecutor(harness.deps);
      const pending = executor.execute(
        { command: 'handoff-failure' },
        { toolCallId: 'call-adopt-failure', cwd: '/work' },
      );
      const rejected = assert.rejects(pending, /registry adoption failed/);
      await flush();

      assert.equal(executor.triggerBackground(), true);
      await rejected;
      assert.deepEqual(harness.groupKills, [
        { pid: spawnAt(harness, 0).child.pid, signal: 'SIGTERM' },
      ]);
      assert.equal(harness.adopted.length, 0);
      assert.equal(harness.messages.length, 0);
      assert.equal(executor.hasForegroundProcess(), false);
      assertExecutorListenersRemoved(spawnAt(harness, 0).child);
      mock.timers.tick(DEFAULT_AUTO_BACKGROUND_TIMEOUT_MS * 2);
      await flush();
      assert.equal(harness.notifications.length, 0);
      assert.equal(harness.groupKills.length, 1);
    } finally {
      mock.timers.reset();
    }
  });
});

// ─── Executor: cleanup ──────────────────────────────────────────────

void describe('executor cleanup', () => {
  void it('removes timers and listeners deterministically after foreground completion', async () => {
    enableMockTimers();
    try {
      const harness = createHarness();
      const executor = createForegroundBashExecutor(harness.deps);
      const controller = new AbortController();
      const updates: string[] = [];
      const pending = executor.execute(
        { command: 'echo clean' },
        { toolCallId: 'call-cleanup', cwd: '/work' },
        controller.signal,
        (update: TextResult) => {
          updates.push(resultText(update));
        },
      );
      await flush();
      const child = spawnAt(harness, 0).child;
      assert.equal(child.listenerCount('error'), 1);
      assert.equal(child.listenerCount('close'), 1);
      assert.equal(child.stdout.listenerCount('data'), 1);
      assert.equal(child.stderr.listenerCount('data'), 1);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 1);

      child.writeStdout('clean\n');
      child.close(0);
      await pending;
      assertExecutorListenersRemoved(child, controller.signal);
      const before = {
        adopted: harness.adopted.length,
        messages: harness.messages.length,
        notifications: harness.notifications.length,
        groupKills: harness.groupKills.length,
        updates: updates.length,
      };

      mock.timers.tick(DEFAULT_AUTO_BACKGROUND_TIMEOUT_MS * 3);
      controller.abort();
      await flush();
      assert.deepEqual(
        {
          adopted: harness.adopted.length,
          messages: harness.messages.length,
          notifications: harness.notifications.length,
          groupKills: harness.groupKills.length,
          updates: updates.length,
        },
        before,
        'cleared timers and listeners must have no observable late effects',
      );
    } finally {
      mock.timers.reset();
    }
  });
});

// ─── Feature registration ───────────────────────────────────────────

interface RegisteredTool {
  name: string;
  description: string;
  execute: (...args: unknown[]) => unknown;
}

interface RegisteredShortcut {
  description: string;
  handler: (ctx: unknown) => unknown;
}

function createFakePi() {
  const tools = new Map<string, RegisteredTool>();
  const shortcuts = new Map<string, RegisteredShortcut>();
  const pi = {
    registerTool: (definition: RegisteredTool) => {
      tools.set(definition.name, definition);
    },
    registerShortcut: (key: string, definition: RegisteredShortcut) => {
      shortcuts.set(key, definition);
    },
  };
  return { pi, tools, shortcuts };
}

void describe('registerForegroundBashFeature', () => {
  void it('overrides the bash tool and documents the 120s auto-background', () => {
    const { pi, tools } = createFakePi();
    const harness = createHarness();
    const controller = createForegroundBashExecutor(harness.deps);
    registerForegroundBashFeature(pi, controller);

    const bash = tools.get('bash');
    assert.ok(bash, 'bash tool override must be registered');
    assert.match(bash.description, /120/);
    assert.match(bash.description, /background/i);
  });

  void it('registers the ctrl+b shortcut for manual backgrounding', () => {
    const { pi, shortcuts } = createFakePi();
    const harness = createHarness();
    const controller = createForegroundBashExecutor(harness.deps);
    registerForegroundBashFeature(pi, controller);

    const shortcut = shortcuts.get('ctrl+b');
    assert.ok(shortcut, 'ctrl+b shortcut must be registered');
    assert.match(shortcut.description, /background/i);
  });

  void it('routes the ctrl+b handler to triggerBackground', async () => {
    const { pi, shortcuts } = createFakePi();
    const harness = createHarness();
    const controller = createForegroundBashExecutor(harness.deps);
    let triggered = 0;
    const wrapped = {
      ...controller,
      triggerBackground: () => {
        triggered += 1;
        return controller.triggerBackground();
      },
      hasForegroundProcess: () => controller.hasForegroundProcess(),
      execute: controller.execute.bind(controller),
    };
    registerForegroundBashFeature(pi, wrapped);

    const shortcut = shortcuts.get('ctrl+b');
    assert.ok(shortcut, 'ctrl+b shortcut must be registered');
    await shortcut.handler({});
    assert.equal(triggered, 1);
  });
});

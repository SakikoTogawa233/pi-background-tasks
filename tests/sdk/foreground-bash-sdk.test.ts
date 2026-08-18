import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ModelRuntime,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionUIContext,
} from '@earendil-works/pi-coding-agent';
import type { BgTaskSnapshot } from '../../src/core/common.js';
import { isolatedTestEnv } from '../helpers/normalize.js';

const extensionPath = resolve('extensions/background-tasks.ts');
const ENV_KEYS = [
  'HOME',
  'XDG_CONFIG_HOME',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'PI_OFFLINE',
  'PI_SKIP_VERSION_CHECK',
  'PI_TELEMETRY',
  'CI',
] as const;

type JsonObject = Record<PropertyKey, unknown>;

interface TestToolResult {
  content: Array<{ type: string; text?: string }>;
  details?: unknown;
}

interface UiNotification {
  message: string;
  type?: 'info' | 'warning' | 'error';
}

type TestExtensionMode = 'tui' | 'rpc' | 'json' | 'print';

interface SdkHarness {
  root: string;
  cwd: string;
  session: AgentSession;
  notifications: UiNotification[];
  shutdownEmitted: boolean;
  restoreEnv: () => void;
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

async function harness(mode: TestExtensionMode = 'tui'): Promise<SdkHarness> {
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-foreground-sdk-'));
  const cwd = join(root, 'project');
  const home = join(root, 'home');
  const agentDir = join(root, 'agent');
  const sessionDir = join(root, 'sessions');
  await mkdir(cwd, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  await mkdir(sessionDir, { recursive: true });

  const previous = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) previous.set(key, process.env[key]);
  Object.assign(process.env, isolatedTestEnv, {
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
  });

  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [extensionPath],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    noThemes: true,
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, 'auth.json'),
    modelsPath: null,
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    modelRuntime,
    noTools: 'builtin',
  });
  const notifications: UiNotification[] = [];
  const baseUi = session.extensionRunner.getUIContext();
  const ui: ExtensionUIContext = {
    ...baseUi,
    notify: (message, type) => {
      const notification: UiNotification = { message };
      if (type !== undefined) notification.type = type;
      notifications.push(notification);
    },
  };
  session.extensionRunner.setUIContext(ui, mode);
  await session.extensionRunner.emit({ type: 'session_start', reason: 'startup' });

  return {
    root,
    cwd,
    session,
    notifications,
    shutdownEmitted: false,
    restoreEnv: () => {
      for (const key of ENV_KEYS) restoreEnvValue(key, previous.get(key));
    },
  };
}

async function disposeHarness(h: SdkHarness): Promise<void> {
  try {
    if (!h.shutdownEmitted) {
      await h.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      h.shutdownEmitted = true;
    }
  } finally {
    h.session.dispose();
    h.restoreEnv();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await rm(h.root, { recursive: true, force: true });
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isToolResult(value: unknown): value is TestToolResult {
  return isJsonObject(value) && Array.isArray(value['content']);
}

function resultText(result: TestToolResult): string {
  return result.content.map((part) => part.text ?? '').join('\n');
}

async function exec(
  session: AgentSession,
  name: string,
  params: unknown,
  options: {
    callId?: string;
    signal?: AbortSignal;
    onUpdate?: (result: TestToolResult) => void;
  } = {},
): Promise<TestToolResult> {
  const tool = session.getToolDefinition(name);
  assert.ok(tool, `real extension entrypoint must register ${name}`);
  const raw: unknown = await tool.execute(
    options.callId ?? `call-${name}`,
    params,
    options.signal,
    options.onUpdate,
    session.extensionRunner.createContext(),
  );
  assert.ok(isToolResult(raw), `${name} must return a tool result`);
  return raw;
}

function taskIdFromReceipt(result: TestToolResult): string {
  const match = /\b(b[0-9a-f]{8,32})\b/u.exec(resultText(result));
  assert.ok(match?.[1], `background handoff receipt must contain a task id: ${resultText(result)}`);
  return match[1];
}

function tasksFromStatus(result: TestToolResult): BgTaskSnapshot[] {
  assert.ok(isJsonObject(result.details), 'bg_status details must be an object');
  const tasks = result.details['tasks'];
  assert.ok(Array.isArray(tasks), 'bg_status details must contain tasks');
  return tasks as BgTaskSnapshot[];
}

function firstTask(result: TestToolResult): BgTaskSnapshot {
  const task = tasksFromStatus(result)[0];
  assert.ok(task, 'bg_status must contain one task');
  return task;
}

function waitForUpdate(
  start: (onUpdate: (result: TestToolResult) => void) => Promise<TestToolResult>,
  sentinel: string,
): { pending: Promise<TestToolResult>; ready: Promise<void> } {
  let resolveReady!: () => void;
  const ready = new Promise<void>((resolveReadyPromise) => {
    resolveReady = resolveReadyPromise;
  });
  const pending = start((update) => {
    if (resultText(update).includes(sentinel)) resolveReady();
  });
  return { pending, ready };
}

async function within<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function waitForTerminal(
  session: AgentSession,
  taskId: string,
  timeoutMs = 5000,
): Promise<BgTaskSnapshot> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const task = firstTask(await exec(session, 'bg_status', { taskId }));
    if (task.status !== 'running') return task;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for adopted task ${taskId}`);
}

function customMessageCount(session: AgentSession): number {
  return session.sessionManager
    .getEntries()
    .filter((entry) => isJsonObject(entry) && entry['type'] === 'custom_message').length;
}

void describe('foreground bash SDK production E2E', { concurrency: false }, () => {
  void it('loads the real entrypoint and registers the bash override plus ctrl+b shortcut', async () => {
    const h = await harness();
    try {
      const extensionBash = h.session.extensionRunner
        .getAllRegisteredTools()
        .find((registered) => registered.definition.name === 'bash');
      assert.ok(extensionBash, 'background-tasks.ts must register a bash override');
      assert.match(extensionBash.definition.description, /120|background/i);
      const shortcuts = h.session.extensionRunner.getShortcuts({});
      const ctrlB = shortcuts.get('ctrl+b');
      assert.ok(ctrlB, 'background-tasks.ts must register ctrl+b');
      assert.match(ctrlB.description ?? '', /background/i);
    } finally {
      await disposeHarness(h);
    }
  });

  void it('keeps a fast bash command foreground with no registry adoption or notification', async () => {
    const h = await harness();
    try {
      const result = await exec(h.session, 'bash', {
        command: `node -e ${JSON.stringify("process.stdout.write('SDK_FAST_DONE')")}`,
      });
      assert.match(resultText(result), /SDK_FAST_DONE/);
      assert.doesNotMatch(resultText(result), /backgrounded/i);
      assert.equal(tasksFromStatus(await exec(h.session, 'bg_status', {})).length, 0);
      assert.equal(customMessageCount(h.session), 0);
      assert.equal(h.notifications.filter((entry) => /ctrl\+b/i.test(entry.message)).length, 0);
    } finally {
      await disposeHarness(h);
    }
  });

  void it('uses public timeout:1 as a total-runtime auto-background threshold and exposes the adopted task', async () => {
    const h = await harness();
    try {
      const started = Date.now();
      const result = await exec(h.session, 'bash', {
        command: `node -e ${JSON.stringify("console.log('SDK_AUTO_READY'); setTimeout(() => console.log('SDK_AUTO_DONE'), 5000)")}`,
        timeout: 1,
      });
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 700, `timeout:1 handed off too early after ${String(elapsed)}ms`);
      assert.ok(elapsed < 2500, `timeout:1 must measure total runtime, got ${String(elapsed)}ms`);
      assert.match(resultText(result), /backgrounded/i);
      const taskId = taskIdFromReceipt(result);

      const status = firstTask(await exec(h.session, 'bg_status', { taskId }));
      assert.equal(status.id, taskId);
      assert.equal(status.status, 'running');
      assert.match(status.command, /SDK_AUTO_READY/);
      const logs = await exec(h.session, 'bg_logs', { taskId, maxBytes: 2000, tail: false });
      assert.match(resultText(logs), /SDK_AUTO_READY/);
      assert.ok(status.outputPath.startsWith('.pi/tasks/'));

      await exec(h.session, 'bg_kill', { taskId });
    } finally {
      await disposeHarness(h);
    }
  });

  void it('routes the registered ctrl+b shortcut handler into a live bash handoff', async () => {
    const h = await harness();
    const abort = new AbortController();
    let pending: Promise<TestToolResult> | undefined;
    try {
      const running = waitForUpdate(
        (onUpdate) =>
          exec(
            h.session,
            'bash',
            {
              command: `node -e ${JSON.stringify("console.log('SDK_SHORTCUT_READY'); setTimeout(() => console.log('SDK_SHORTCUT_DONE'), 5000)")}`,
            },
            { callId: 'call-sdk-shortcut', signal: abort.signal, onUpdate },
          ),
        'SDK_SHORTCUT_READY',
      );
      pending = running.pending;
      await within(running.ready, 2000, 'bash did not expose the running sentinel');
      const shortcut = h.session.extensionRunner.getShortcuts({}).get('ctrl+b');
      assert.ok(shortcut, 'ctrl+b shortcut must be registered');
      await shortcut.handler(h.session.extensionRunner.createContext());
      const result = await within(running.pending, 2000, 'ctrl+b did not resolve the bash tool call');
      assert.match(resultText(result), /backgrounded/i);
      const taskId = taskIdFromReceipt(result);
      assert.equal(firstTask(await exec(h.session, 'bg_status', { taskId })).status, 'running');
      await exec(h.session, 'bg_kill', { taskId });
    } finally {
      abort.abort();
      await pending?.catch(() => undefined);
      await disposeHarness(h);
    }
  });

  void it('ctrl+b adopts the most recently started concurrent foreground bash call first', async () => {
    const h = await harness();
    const firstAbort = new AbortController();
    const secondAbort = new AbortController();
    let firstPending: Promise<TestToolResult> | undefined;
    let secondPending: Promise<TestToolResult> | undefined;
    try {
      const first = waitForUpdate(
        (onUpdate) =>
          exec(
            h.session,
            'bash',
            {
              command: `node -e ${JSON.stringify("console.log('SDK_FIRST_READY'); setTimeout(() => {}, 10000)")}`,
            },
            { callId: 'call-sdk-first', signal: firstAbort.signal, onUpdate },
          ),
        'SDK_FIRST_READY',
      );
      firstPending = first.pending;
      await within(first.ready, 2000, 'first bash sentinel missing');
      const second = waitForUpdate(
        (onUpdate) =>
          exec(
            h.session,
            'bash',
            {
              command: `node -e ${JSON.stringify("console.log('SDK_SECOND_READY'); setTimeout(() => {}, 10000)")}`,
            },
            { callId: 'call-sdk-second', signal: secondAbort.signal, onUpdate },
          ),
        'SDK_SECOND_READY',
      );
      secondPending = second.pending;
      await within(second.ready, 2000, 'second bash sentinel missing');

      const shortcut = h.session.extensionRunner.getShortcuts({}).get('ctrl+b');
      assert.ok(shortcut);
      await shortcut.handler(h.session.extensionRunner.createContext());
      const secondResult = await within(second.pending, 2000, 'newest bash was not handed off');
      const secondTaskId = taskIdFromReceipt(secondResult);
      assert.match(
        firstTask(await exec(h.session, 'bg_status', { taskId: secondTaskId })).command,
        /SDK_SECOND_READY/,
      );

      await shortcut.handler(h.session.extensionRunner.createContext());
      const firstResult = await within(first.pending, 2000, 'older bash was not still triggerable');
      const firstTaskId = taskIdFromReceipt(firstResult);
      assert.match(
        firstTask(await exec(h.session, 'bg_status', { taskId: firstTaskId })).command,
        /SDK_FIRST_READY/,
      );
      await exec(h.session, 'bg_kill', { taskId: secondTaskId });
      await exec(h.session, 'bg_kill', { taskId: firstTaskId });
    } finally {
      firstAbort.abort();
      secondAbort.abort();
      await Promise.all([
        firstPending?.catch(() => undefined),
        secondPending?.catch(() => undefined),
      ]);
      await disposeHarness(h);
    }
  });

  void it('transfers abort ownership after handoff so aborting the tool call cannot kill the adopted task', async () => {
    const h = await harness();
    const abort = new AbortController();
    let pending: Promise<TestToolResult> | undefined;
    try {
      const running = waitForUpdate(
        (onUpdate) =>
          exec(
            h.session,
            'bash',
            {
              command: `node -e ${JSON.stringify("console.log('SDK_ABORT_READY'); setTimeout(() => console.log('SDK_ABORT_OWNED_BY_REGISTRY'), 1800)")}`,
            },
            { callId: 'call-sdk-abort-handoff', signal: abort.signal, onUpdate },
          ),
        'SDK_ABORT_READY',
      );
      pending = running.pending;
      await within(running.ready, 2000, 'abort ownership sentinel missing');
      const shortcut = h.session.extensionRunner.getShortcuts({}).get('ctrl+b');
      assert.ok(shortcut);
      await shortcut.handler(h.session.extensionRunner.createContext());
      const taskId = taskIdFromReceipt(
        await within(running.pending, 2000, 'bash did not hand off before abort'),
      );

      abort.abort();
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(firstTask(await exec(h.session, 'bg_status', { taskId })).status, 'running');
      const terminal = await waitForTerminal(h.session, taskId, 5000);
      assert.equal(terminal.status, 'completed');
      const logs = await exec(h.session, 'bg_logs', { taskId, maxBytes: 2000, tail: true });
      assert.match(resultText(logs), /SDK_ABORT_OWNED_BY_REGISTRY/);
    } finally {
      abort.abort();
      await pending?.catch(() => undefined);
      await disposeHarness(h);
    }
  });

  void it('cleans up an adopted foreground task during session shutdown', async () => {
    const h = await harness();
    const abort = new AbortController();
    let pending: Promise<TestToolResult> | undefined;
    try {
      const running = waitForUpdate(
        (onUpdate) =>
          exec(
            h.session,
            'bash',
            {
              command: `node -e ${JSON.stringify("console.log('SDK_SHUTDOWN_READY'); setTimeout(() => {}, 10000)")}`,
            },
            { callId: 'call-sdk-shutdown', signal: abort.signal, onUpdate },
          ),
        'SDK_SHUTDOWN_READY',
      );
      pending = running.pending;
      await within(running.ready, 2000, 'shutdown sentinel missing');
      const shortcut = h.session.extensionRunner.getShortcuts({}).get('ctrl+b');
      assert.ok(shortcut);
      await shortcut.handler(h.session.extensionRunner.createContext());
      const taskId = taskIdFromReceipt(await running.pending);

      await h.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
      h.shutdownEmitted = true;
      const task = firstTask(await exec(h.session, 'bg_status', { taskId }));
      assert.equal(task.status, 'killed');
      assert.match(task.error ?? '', /shutdown/i);
    } finally {
      abort.abort();
      await pending?.catch(() => undefined);
      await disposeHarness(h);
    }
  });

  void it('keeps timeout:1 foreground in non-interactive print mode', async () => {
    const h = await harness('print');
    try {
      const started = Date.now();
      const result = await exec(h.session, 'bash', {
        command: `node -e ${JSON.stringify("setTimeout(() => console.log('SDK_PRINT_DONE'), 1400)")}`,
        timeout: 1,
      });
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 1200, `print-mode command returned early after ${String(elapsed)}ms`);
      assert.match(resultText(result), /SDK_PRINT_DONE/);
      assert.doesNotMatch(resultText(result), /backgrounded/i);
      assert.equal(tasksFromStatus(await exec(h.session, 'bg_status', {})).length, 0);
      assert.equal(customMessageCount(h.session), 0);
    } finally {
      await disposeHarness(h);
    }
  });
});

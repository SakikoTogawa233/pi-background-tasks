import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ModelRuntime,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import { parseJsonText } from '../../src/core/common.js';
import { isolatedTestEnv } from '../helpers/normalize.js';

const backgroundExtensionPath = resolve('extensions/background-tasks.ts');
const scriptedProviderPath = resolve('tests/scripted-provider/scripted-provider-extension.ts');
const ENV_KEYS = [
  'HOME',
  'XDG_CONFIG_HOME',
  'PI_CODING_AGENT_DIR',
  'PI_CODING_AGENT_SESSION_DIR',
  'PI_BG_SCRIPTED_SCENARIO',
  'PI_BG_SCRIPTED_EVENTS',
  'PI_BG_SCRIPTED_API_KEY',
  'PI_OFFLINE',
  'PI_SKIP_VERSION_CHECK',
  'PI_TELEMETRY',
  'CI',
] as const;

type JsonObject = Record<PropertyKey, unknown>;

interface ProviderEvent extends JsonObject {
  callCount: number;
  summaries: string[];
  timestamp: number;
}

interface CustomNotificationEntry {
  type: 'custom_message';
  customType: 'background-task-notification';
  content: string;
  details: JsonObject;
}

interface Harness {
  root: string;
  eventsPath: string;
  session: AgentSession;
  agentStarts: number;
  restoreEnv: () => void;
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function parseProviderEvent(line: string): ProviderEvent {
  const parsed = parseJsonText(line);
  assert.ok(isJsonObject(parsed), 'provider event must be an object');
  assert.equal(typeof parsed['callCount'], 'number');
  assert.ok(isStringArray(parsed['summaries']), 'provider event summaries must be strings');
  assert.equal(typeof parsed['timestamp'], 'number');
  return parsed as ProviderEvent;
}

async function providerEvents(path: string): Promise<ProviderEvent[]> {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, 'utf8');
  return raw.trim() === '' ? [] : raw.trim().split('\n').map(parseProviderEvent);
}

function isCustomNotification(value: unknown): value is CustomNotificationEntry {
  return (
    isJsonObject(value) &&
    value['type'] === 'custom_message' &&
    value['customType'] === 'background-task-notification' &&
    typeof value['content'] === 'string' &&
    isJsonObject(value['details'])
  );
}

function customNotifications(session: AgentSession): CustomNotificationEntry[] {
  const entries: readonly unknown[] = session.sessionManager.getEntries();
  return entries.filter(isCustomNotification);
}

function assistantToolNames(session: AgentSession): string[] {
  return session.sessionManager.getEntries().flatMap((entry) => {
    if (
      !isJsonObject(entry) ||
      entry['type'] !== 'message' ||
      !isJsonObject(entry['message']) ||
      entry['message']['role'] !== 'assistant' ||
      !Array.isArray(entry['message']['content'])
    )
      return [];
    return entry['message']['content'].flatMap((part: unknown) =>
      isJsonObject(part) && part['type'] === 'toolCall' && typeof part['name'] === 'string'
        ? [part['name']]
        : [],
    );
  });
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 8000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${message}`);
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-foreground-agent-loop-'));
  const cwd = join(root, 'project');
  const home = join(root, 'home');
  const agentDir = join(root, 'agent');
  const sessionDir = join(root, 'sessions');
  const eventsPath = join(root, 'provider-events.jsonl');
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
    PI_BG_SCRIPTED_SCENARIO: 'foreground-bash-follow-up',
    PI_BG_SCRIPTED_EVENTS: eventsPath,
    PI_BG_SCRIPTED_API_KEY: 'scripted-api-key',
  });

  const settingsManager = SettingsManager.inMemory({
    defaultProvider: 'pi-bg-scripted',
    defaultModel: 'scripted-model',
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [scriptedProviderPath, backgroundExtensionPath],
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
  const modelRegistry = new ModelRegistry(modelRuntime);
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    modelRuntime,
    noTools: 'builtin',
  });
  session.extensionRunner.setUIContext(session.extensionRunner.getUIContext(), 'tui');
  const model = modelRegistry.find('pi-bg-scripted', 'scripted-model');
  assert.ok(model, 'scripted provider model must be registered');
  await session.setModel(model);
  const h: Harness = {
    root,
    eventsPath,
    session,
    agentStarts: 0,
    restoreEnv: () => {
      for (const key of ENV_KEYS) restoreEnvValue(key, previous.get(key));
    },
  };
  session.subscribe((event) => {
    if (event.type === 'agent_start') h.agentStarts += 1;
  });
  return h;
}

async function disposeHarness(h: Harness): Promise<void> {
  try {
    await h.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  } finally {
    h.session.dispose();
    h.restoreEnv();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await rm(h.root, { recursive: true, force: true });
  }
}

function requiredString(value: unknown, message: string): string {
  assert.equal(typeof value, 'string', message);
  return value as string;
}

void describe('foreground bash scripted-provider follow-up', { concurrency: false }, () => {
  void it(
    'returns the bash receipt early, then terminal triggerTurn starts exactly one follow-up agent run without polling',
    { timeout: 15_000 },
    async () => {
      const h = await harness();
      try {
        const prompt = h.session.prompt('Run the deterministic foreground bash scenario.');

        await waitFor(async () => (await providerEvents(h.eventsPath)).length >= 2, 'early tool receipt');
        const earlyEvents = await providerEvents(h.eventsPath);
        assert.equal(earlyEvents.length, 2, 'tool receipt must arrive before terminal completion');
        assert.equal(customNotifications(h.session).length, 0, 'terminal notification arrived before receipt');
        const receiptContext = earlyEvents[1]?.summaries.join('\n') ?? '';
        assert.match(receiptContext, /bash/);
        assert.match(receiptContext, /backgrounded/i);
        assert.match(receiptContext, /b[0-9a-f]{8,32}/);
        assert.match(receiptContext, /\.pi\/tasks\//);
        assert.match(receiptContext, /FG_AUTO_RUNNING_SENTINEL/);

        await prompt;
        await waitFor(() => customNotifications(h.session).length === 1, 'terminal notification');
        await waitFor(async () => (await providerEvents(h.eventsPath)).length >= 3, 'completion follow-up');
        await h.session.agent.waitForIdle();
        await new Promise((resolve) => setTimeout(resolve, 300));

        const events = await providerEvents(h.eventsPath);
        assert.equal(events.length, 3, 'terminal completion must cause exactly one provider follow-up');
        assert.equal(h.agentStarts, 2, 'initial tool run plus exactly one completion-triggered agent run');
        assert.ok(events[1]!.timestamp < events[2]!.timestamp);
        assert.deepEqual(
          assistantToolNames(h.session),
          ['bash'],
          'the scripted model must not poll bg_status/bg_logs or invoke any other tool',
        );

        const note = customNotifications(h.session)[0];
        assert.ok(note, 'one terminal notification must be durable in the session');
        const taskId = requiredString(note.details['id'], 'notification details must contain task id');
        const command = requiredString(
          note.details['command'],
          'notification details must contain command',
        );
        const outputPath = requiredString(
          note.details['outputPath'],
          'notification details must contain output path',
        );
        assert.equal(note.details['status'], 'completed');
        assert.equal(note.details['triggerOnCompletion'], true);
        assert.equal(note.details['notified'], true);
        assert.match(note.content, new RegExp(taskId));
        assert.match(note.content, /<status>completed<\/status>/);

        const followUpContext = events[2]!.summaries.join('\n');
        assert.match(followUpContext, new RegExp(taskId));
        assert.ok(
          followUpContext.includes(command) || followUpContext.includes('FG_AUTO_RUNNING_SENTINEL'),
          'completion follow-up context must contain the adopted command',
        );
        assert.match(followUpContext, new RegExp(outputPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(followUpContext, /completed/);
      } finally {
        await disposeHarness(h);
      }
    },
  );
});

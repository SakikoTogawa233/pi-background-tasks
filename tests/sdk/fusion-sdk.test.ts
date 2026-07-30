import { afterEach, describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { AssistantMessage, UserMessage } from '@earendil-works/pi-ai';
import {
  ModelRuntime,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  Theme,
  type AgentSession,
  type ExtensionUIContext,
  type KeybindingsManager,
} from '@earendil-works/pi-coding-agent';
import type { Component, TUI } from '@earendil-works/pi-tui';
import { parseJsonText } from '../../src/core/common.js';
import { resolvePiLaunch } from '../../src/core/pi-launch.js';
import { CURRENT_MODEL_SELECTION, FUSION_MODEL_CONFIG_FILE } from '../../src/core/fusion/config.js';
import {
  FUSION_INPUT_SCHEMA_VERSION,
  FUSION_RESULT_SCHEMA_VERSION,
  type FusionResultDetails,
} from '../../src/core/fusion/types.js';
import { installFusionFakePi } from '../helpers/fusion-fake-pi.js';
import { isolatedTestEnv, stripAnsi } from '../../src/testing/normalize.js';

const backgroundTasksExtensionPath = resolve('extensions/background-tasks.ts');
const roots: string[] = [];
const savedEnv = new Map<string, string | undefined>();
const envKeys = [
  'PATH',
  'PI_CODING_AGENT_DIR',
  'PI_BG_FUSION_TEST_KEY',
  'PI_SESSION_ID',
  'PI_PROVIDER',
  'PI_MODEL',
] as const;

type JsonRecord = Record<string, unknown>;

interface FusionFakeInvocation {
  stage: string;
  provider: string;
  model: string;
  args: string[];
  stdin: string;
  env: {
    PI_SESSION_ID: string | null;
    PI_PROVIDER: string | null;
    PI_MODEL: string | null;
    PI_SKIP_VERSION_CHECK: string | null;
  };
}

interface Harness {
  session: AgentSession;
  cwd: string;
  root: string;
  agentDir: string;
  fakeLogPath: string;
}

interface HarnessOptions {
  fakeDelayMs?: number | undefined;
  fakeFailStage?: 'candidate' | 'evaluation' | 'evaluation-repair' | 'merge' | undefined;
}

function skipWin32FusionChildPathFixture(t: TestContext): boolean {
  if (process.platform !== 'win32') return false;
  t.skip(
    'PATH-based fake Pi child interception is not applicable on win32 because production resolves the Pi package instead of PATH by design',
  );
  return true;
}

function rememberEnv(): void {
  if (savedEnv.size > 0) return;
  for (const key of envKeys) savedEnv.set(key, process.env[key]);
}

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = value;
}

function restoreEnv(): void {
  for (const key of envKeys) restoreEnvValue(key, savedEnv.get(key));
  savedEnv.clear();
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringField(record: JsonRecord, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw new Error(`${key} must be a string`);
  return value;
}

function stringArray(value: unknown): string[] {
  assert.ok(Array.isArray(value), 'expected string array');
  return value.map((entry) => {
    if (typeof entry !== 'string') throw new Error('array entry must be a string');
    return entry;
  });
}

function parseInvocation(line: string): FusionFakeInvocation {
  const parsed = parseJsonText(line);
  assert.ok(isRecord(parsed), 'fake invocation must be an object');
  const env = parsed['env'];
  assert.ok(isRecord(env), 'fake invocation env must be an object');
  return {
    stage: stringField(parsed, 'stage'),
    provider: stringField(parsed, 'provider'),
    model: stringField(parsed, 'model'),
    args: stringArray(parsed['args']),
    stdin: stringField(parsed, 'stdin'),
    env: {
      PI_SESSION_ID: env['PI_SESSION_ID'] === null ? null : stringField(env, 'PI_SESSION_ID'),
      PI_PROVIDER: env['PI_PROVIDER'] === null ? null : stringField(env, 'PI_PROVIDER'),
      PI_MODEL: env['PI_MODEL'] === null ? null : stringField(env, 'PI_MODEL'),
      PI_SKIP_VERSION_CHECK:
        env['PI_SKIP_VERSION_CHECK'] === null ? null : stringField(env, 'PI_SKIP_VERSION_CHECK'),
    },
  };
}

async function invocations(path: string): Promise<FusionFakeInvocation[]> {
  if (!existsSync(path)) return [];
  const raw = await readFile(path, 'utf8');
  return raw.trim() ? raw.trim().split('\n').map(parseInvocation) : [];
}

async function waitForInvocationCount(path: string, minimum: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    if ((await invocations(path)).length >= minimum) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`timed out waiting for ${String(minimum)} fusion child calls`);
}

function isFusionResultDetails(value: unknown): value is FusionResultDetails {
  return (
    isRecord(value) &&
    value['schema_version'] === FUSION_RESULT_SCHEMA_VERSION &&
    typeof value['run_id'] === 'string'
  );
}

function customEntries(session: AgentSession, customType: string): JsonRecord[] {
  const entries: readonly unknown[] = session.sessionManager.getEntries();
  return entries.filter((entry): entry is JsonRecord => {
    return (
      isRecord(entry) && entry['type'] === 'custom_message' && entry['customType'] === customType
    );
  });
}

function assistantMessageCount(session: AgentSession): number {
  return session.sessionManager.getEntries().filter((entry) => {
    return (
      isRecord(entry) && isRecord(entry['message']) && entry['message']['role'] === 'assistant'
    );
  }).length;
}

async function harness(options: HarnessOptions = {}): Promise<Harness> {
  rememberEnv();
  const root = await mkdtemp(join(tmpdir(), 'pi-bg-fusion-sdk-'));
  roots.push(root);
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  await mkdir(cwd, { recursive: true });
  await mkdir(agentDir, { recursive: true });
  process.env['PI_CODING_AGENT_DIR'] = agentDir;
  process.env['PI_BG_FUSION_TEST_KEY'] = 'test-key';
  process.env['PI_SESSION_ID'] = 'stale-session';
  process.env['PI_PROVIDER'] = 'stale-provider';
  process.env['PI_MODEL'] = 'stale-model';
  Object.assign(process.env, isolatedTestEnv);
  const fake = await installFusionFakePi(root, {
    mergedText: 'SDK fused answer.',
    delayMs: options.fakeDelayMs,
    failStage: options.fakeFailStage,
  });
  process.env['PATH'] = fake.env['PATH'];
  const settingsManager = SettingsManager.inMemory({
    defaultProvider: 'pi-bg-fusion',
    defaultModel: 'current-model',
  });
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [backgroundTasksExtensionPath],
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
  modelRegistry.registerProvider('pi-bg-fusion', {
    name: 'Fusion SDK Provider',
    baseUrl: 'https://example.invalid',
    apiKey: 'PI_BG_FUSION_TEST_KEY',
    api: 'openai-responses',
    models: [
      {
        id: 'current-model',
        name: 'Current Model',
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 272000,
        maxTokens: 4096,
      },
      {
        id: 'alt-model',
        name: 'Alt Model',
        reasoning: true,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 272000,
        maxTokens: 4096,
      },
    ],
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
  const model = modelRegistry.find('pi-bg-fusion', 'current-model');
  assert.ok(model, 'fusion model should exist');
  await session.setModel(model);
  assert.equal(session.model?.provider, 'pi-bg-fusion');
  assert.equal(session.model?.id, 'current-model');
  session.setThinkingLevel('low');
  await session.extensionRunner.emit({ type: 'session_start', reason: 'startup' });
  return { session, cwd, root, agentDir, fakeLogPath: fake.logPath };
}

async function disposeHarness(h: Harness): Promise<void> {
  try {
    await h.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'quit' });
  } finally {
    h.session.dispose();
  }
}

function command(session: AgentSession, name: string) {
  const found = session.extensionRunner
    .getRegisteredCommands()
    .find((cmd) => cmd.invocationName === name);
  assert.ok(found, `missing command ${name}`);
  return found;
}

function commandContext(session: AgentSession, mode?: string) {
  const ctx = session.extensionRunner.createCommandContext();
  if (mode !== undefined) Object.defineProperty(ctx, 'mode', { value: mode, configurable: true });
  return ctx;
}

function baseUi(session: AgentSession): ExtensionUIContext {
  return session.extensionRunner.getUIContext();
}

function makeTheme(): Theme {
  return new Theme(
    {
      accent: '#ffffff',
      border: '#ffffff',
      borderAccent: '#ffffff',
      borderMuted: '#ffffff',
      success: '#ffffff',
      error: '#ffffff',
      warning: '#ffffff',
      muted: '#ffffff',
      dim: '#ffffff',
      text: '#ffffff',
      thinkingText: '#ffffff',
      userMessageText: '#ffffff',
      customMessageText: '#ffffff',
      customMessageLabel: '#ffffff',
      toolTitle: '#ffffff',
      toolOutput: '#ffffff',
      mdHeading: '#ffffff',
      mdLink: '#ffffff',
      mdLinkUrl: '#ffffff',
      mdCode: '#ffffff',
      mdCodeBlock: '#ffffff',
      mdCodeBlockBorder: '#ffffff',
      mdQuote: '#ffffff',
      mdQuoteBorder: '#ffffff',
      mdHr: '#ffffff',
      mdListBullet: '#ffffff',
      toolDiffAdded: '#ffffff',
      toolDiffRemoved: '#ffffff',
      toolDiffContext: '#ffffff',
      syntaxComment: '#ffffff',
      syntaxKeyword: '#ffffff',
      syntaxFunction: '#ffffff',
      syntaxVariable: '#ffffff',
      syntaxString: '#ffffff',
      syntaxNumber: '#ffffff',
      syntaxType: '#ffffff',
      syntaxOperator: '#ffffff',
      syntaxPunctuation: '#ffffff',
      thinkingOff: '#ffffff',
      thinkingMinimal: '#ffffff',
      thinkingLow: '#ffffff',
      thinkingMedium: '#ffffff',
      thinkingHigh: '#ffffff',
      thinkingXhigh: '#ffffff',
      thinkingMax: '#ffffff',
      bashMode: '#ffffff',
    },
    {
      selectedBg: '#000000',
      userMessageBg: '#000000',
      customMessageBg: '#000000',
      toolPendingBg: '#000000',
      toolSuccessBg: '#000000',
      toolErrorBg: '#000000',
    },
    'truecolor',
  );
}

function fakeTui(): TUI {
  return { requestRender: () => undefined } as TUI;
}

function fakeKeybindings(): KeybindingsManager {
  return {} as KeybindingsManager;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  restoreEnv();
});

void describe('fusion SDK integration', { concurrency: false }, () => {
  void it('builds a fake Pi package accepted by the win32 launch resolver', async () => {
    rememberEnv();
    const root = await mkdtemp(join(tmpdir(), 'pi-bg-fusion-launch-'));
    roots.push(root);
    const fake = await installFusionFakePi(root);
    const launch = resolvePiLaunch({
      platform: 'win32',
      resolvePackageJson: fake.resolvePackageJson,
      execPath: process.execPath,
    });
    assert.equal(launch.executable, process.execPath);
    assert.deepEqual(launch.argvPrefix, [await realpath(fake.packageCliPath)]);
    assert.equal(launch.kind, 'package-node-cli');
    assert.equal((await readFile(fake.packageCliPath, 'utf8')).startsWith('#!'), false);
  });

  void it('registers real public surfaces and /fusion appends direct custom messages without a parent rewrite', async (t) => {
    if (skipWin32FusionChildPathFixture(t)) return;
    const h = await harness();
    try {
      assert.ok(h.session.getActiveToolNames().includes('fusion_brainstorm'));
      const fusionTool = h.session.getToolDefinition('fusion_brainstorm');
      assert.ok(fusionTool);
      assert.equal(Reflect.get(fusionTool.parameters, 'additionalProperties'), false);
      assert.ok(fusionTool.prepareArguments);
      assert.throws(
        () => fusionTool.prepareArguments?.({ prompt: 'x', extra: true }),
        /only prompt/,
      );
      const commandNames = h.session.extensionRunner
        .getRegisteredCommands()
        .map((cmd) => cmd.invocationName);
      assert.ok(commandNames.includes('fusion'));
      assert.ok(commandNames.includes('fusion-models'));
      const renderer = h.session.extensionRunner.getMessageRenderer('fusion-result');
      assert.ok(renderer, 'fusion result renderer should be registered');
      const base = baseUi(h.session);
      const statuses: string[] = [];
      h.session.extensionRunner.setUIContext({
        ...base,
        setStatus: (key, value) => {
          if (key === 'fusion' && value !== undefined) statuses.push(value);
          base.setStatus(key, value);
        },
      });

      await command(h.session, 'fusion').handler(
        '  command prompt\nwith body  ',
        commandContext(h.session, 'print'),
      );
      const calls = await invocations(h.fakeLogPath);
      assert.equal(calls.length, 5);
      assert.equal(calls.filter((call) => call.stage === 'candidate').length, 3);
      assert.equal(calls.filter((call) => call.stage === 'evaluation').length, 1);
      assert.equal(calls.filter((call) => call.stage === 'merge').length, 1);
      for (const call of calls) {
        for (const flag of [
          '--mode',
          '--no-session',
          '--no-tools',
          '--no-extensions',
          '--no-skills',
          '--no-prompt-templates',
          '--no-themes',
          '--no-context-files',
          '--provider',
          '--model',
          '--thinking',
          '--system-prompt',
        ]) {
          assert.ok(call.args.includes(flag), flag);
        }
        assert.equal(call.provider, 'pi-bg-fusion');
        assert.equal(call.model, 'current-model');
        assert.equal(call.env.PI_SESSION_ID, null);
        assert.equal(call.env.PI_PROVIDER, null);
        assert.equal(call.env.PI_MODEL, null);
        assert.equal(call.env.PI_SKIP_VERSION_CHECK, '1');
      }
      const firstInput = parseJsonText(calls[0]?.stdin ?? '');
      assert.ok(isRecord(firstInput));
      assert.equal(firstInput['schema_version'], FUSION_INPUT_SCHEMA_VERSION);
      const commandRequest = firstInput['request'];
      assert.ok(isRecord(commandRequest), 'canonical request must be an object');
      assert.equal(commandRequest['text'], 'command prompt\nwith body');
      assert.equal(commandRequest['source'], 'command');
      assert.equal(commandRequest['authority'], 'directive_over_projected_conversation');

      const requests = customEntries(h.session, 'fusion-request');
      const results = customEntries(h.session, 'fusion-result');
      assert.equal(requests.length, 1);
      assert.equal(results.length, 1);
      assert.equal(requests[0]?.['display'], false);
      assert.equal(requests[0]?.['content'], 'command prompt\nwith body');
      assert.equal(results[0]?.['display'], true);
      assert.equal(results[0]?.['content'], 'SDK fused answer.');
      const details = results[0]?.['details'];
      assert.ok(isFusionResultDetails(details));
      const rendered = renderer(
        {
          role: 'custom',
          customType: 'fusion-result',
          content: 'SDK fused answer.',
          display: true,
          details,
          timestamp: Date.now(),
        },
        { expanded: true, outputPad: 0 },
        makeTheme(),
      );
      assert.ok(rendered, 'fusion renderer should produce a component');
      assert.match(stripAnsi(rendered.render(100).join('\n')), /fusion complete|SDK fused answer/);
      assert.ok(
        statuses.some((status) => /candidates 3\/3 complete|merging final answer/.test(status)),
      );
      assert.equal(assistantMessageCount(h.session), 0);
    } finally {
      await disposeHarness(h);
    }
  });

  void it('BUG-182 returns exact merged text with host-valid usage and excludes the active tool-call leaf', async (t) => {
    if (skipWin32FusionChildPathFixture(t)) return;
    const h = await harness();
    try {
      const user: UserMessage = {
        role: 'user',
        content: [
          { type: 'text', text: 'prior user context before image ' },
          { type: 'image', data: 'sdk-raw-image-base64', mimeType: 'image/png' },
          { type: 'text', text: ' after image context' },
        ],
        timestamp: Date.now(),
      };
      h.session.sessionManager.appendMessage(user);
      const assistant: AssistantMessage = {
        role: 'assistant',
        api: 'openai-responses',
        provider: 'pi-bg-fusion',
        model: 'current-model',
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'toolUse',
        content: [
          { type: 'text', text: 'partial assistant text that must be excluded' },
          {
            type: 'toolCall',
            id: 'call-fusion',
            name: 'fusion_brainstorm',
            arguments: { prompt: 'tool prompt' },
          },
          { type: 'toolCall', id: 'call-sibling', name: 'bg_status', arguments: {} },
        ],
        timestamp: Date.now(),
      };
      h.session.sessionManager.appendMessage(assistant);
      const tool = h.session.getToolDefinition('fusion_brainstorm');
      assert.ok(tool, 'fusion tool should be registered');
      const updates: string[] = [];
      const result = await tool.execute(
        'call-fusion',
        { prompt: 'tool prompt' },
        undefined,
        (partial) => {
          const text = partial.content[0]?.type === 'text' ? partial.content[0].text : '';
          updates.push(text);
        },
        h.session.extensionRunner.createContext(),
      );
      assert.equal(
        result.content[0]?.type === 'text' ? result.content[0].text : '',
        'SDK fused answer.',
      );
      assert.ok(isFusionResultDetails(result.details));
      const resultUsage = Reflect.get(result, 'usage');
      assert.ok(isRecord(resultUsage));
      assert.equal(resultUsage['totalTokens'], 115);
      assert.equal(resultUsage['costTotal'], undefined);
      const resultCost = resultUsage['cost'];
      assert.ok(isRecord(resultCost), 'tool usage must carry Pi Usage.cost');
      assert.deepEqual(resultCost, {
        input: 0.005,
        output: 0.01,
        cacheRead: 0.015,
        cacheWrite: 0.02,
        total: 0.05,
      });
      assert.ok(updates.some((update) => /candidates 3\/3 complete/.test(update)));
      assert.ok(updates.some((update) => /merging final answer/.test(update)));

      const calls = await invocations(h.fakeLogPath);
      const candidate = calls.find((call) => call.stage === 'candidate');
      assert.ok(candidate, 'candidate invocation should be logged');
      const parsedInput = parseJsonText(candidate.stdin);
      assert.ok(isRecord(parsedInput), 'canonical input should be an object');
      const toolRequest = parsedInput['request'];
      assert.ok(isRecord(toolRequest), 'canonical request must be an object');
      assert.equal(toolRequest['text'], 'tool prompt');
      assert.equal(toolRequest['authority'], 'explicit_text');
      // The exact bytes sent to the child carry the projection, not a raw transcript.
      assert.doesNotMatch(candidate.stdin, /conversation_transcript/);
      assert.match(candidate.stdin, /conversation_projection/);
      // Scope conversation assertions to the projection: the parent system prompt
      // legitimately names package tools such as bg_status.
      const projection = parsedInput['conversation_projection'];
      assert.ok(isRecord(projection), 'projection must be an object');
      const projectionText = JSON.stringify(projection);
      assert.match(projectionText, /prior user context before image/);
      assert.match(projectionText, /after image context/);
      assert.match(projectionText, /\[Image omitted from fusion text transcript: image\/png\]/);
      assert.doesNotMatch(projectionText, /partial assistant text/);
      assert.doesNotMatch(projectionText, /call-sibling|bg_status/);
      // Raw image bytes must not appear anywhere in the child prompt.
      assert.doesNotMatch(candidate.stdin, /sdk-raw-image-base64/);
    } finally {
      await disposeHarness(h);
    }
  });

  void it('reports tool failure stage, slot, attempt, and durable artifact directory', async (t) => {
    if (skipWin32FusionChildPathFixture(t)) return;
    const h = await harness({ fakeFailStage: 'candidate' });
    try {
      const tool = h.session.getToolDefinition('fusion_brainstorm');
      assert.ok(tool, 'fusion tool should be registered');
      await assert.rejects(
        () =>
          tool.execute(
            'call-failure-diagnostics',
            { prompt: 'fail with coordinates' },
            undefined,
            undefined,
            h.session.extensionRunner.createContext(),
          ),
        /Fusion failed \(stage=candidate, slot=[123], attempt=1\):.*exited with code 42.*Artifacts: \.pi\/fusion\//s,
      );
    } finally {
      await disposeHarness(h);
    }
  });

  void it('cancels live fusion children on session shutdown', async (t) => {
    if (skipWin32FusionChildPathFixture(t)) return;
    const h = await harness({ fakeDelayMs: 10000 });
    let disposed = false;
    try {
      const tool = h.session.getToolDefinition('fusion_brainstorm');
      assert.ok(tool, 'fusion tool should be registered');
      const running = tool.execute(
        'call-shutdown',
        { prompt: 'shutdown prompt' },
        undefined,
        undefined,
        h.session.extensionRunner.createContext(),
      );
      const observed = running.then(
        () => ({ type: 'resolved' as const }),
        (error: unknown) => ({ type: 'rejected' as const, error }),
      );
      const ready = await Promise.race([
        waitForInvocationCount(h.fakeLogPath, 3).then(() => ({ type: 'ready' as const })),
        observed,
      ]);
      if (ready.type === 'resolved')
        assert.fail('fusion completed before delayed child invocations were observed');
      if (ready.type === 'rejected')
        throw new Error(
          `fusion rejected before child invocations were observed: ${errorMessage(ready.error)}`,
        );
      await h.session.extensionRunner.emit({ type: 'session_shutdown', reason: 'reload' });
      const outcome = await observed;
      assert.equal(outcome.type, 'rejected');
      if (outcome.type === 'rejected')
        assert.match(errorMessage(outcome.error), /cancelled|SIGTERM|exited/i);
      h.session.dispose();
      disposed = true;
    } finally {
      if (!disposed) await disposeHarness(h);
    }
  });

  void it('rejects /fusion-models without UI instead of using the no-op notifier', async () => {
    const h = await harness();
    try {
      await assert.rejects(
        command(h.session, 'fusion-models').handler('', commandContext(h.session)),
        /requires Pi TUI mode/,
      );
      assert.equal((await invocations(h.fakeLogPath)).length, 0);
    } finally {
      await disposeHarness(h);
    }
  });

  void it('supports no-argument editor flow, editor cancellation, selector save, and invalid config without child calls', async (t) => {
    if (skipWin32FusionChildPathFixture(t)) return;
    const h = await harness();
    try {
      const originalUi = baseUi(h.session);
      h.session.extensionRunner.setUIContext({
        ...originalUi,
        editor: () => Promise.resolve(' editor prompt '),
      });
      await command(h.session, 'fusion').handler('', commandContext(h.session, 'print'));
      assert.equal((await invocations(h.fakeLogPath)).length, 5);

      await writeFile(h.fakeLogPath, '', 'utf8');
      h.session.extensionRunner.setUIContext({
        ...baseUi(h.session),
        editor: () => Promise.resolve(undefined),
      });
      await command(h.session, 'fusion').handler('', commandContext(h.session, 'print'));
      assert.equal((await invocations(h.fakeLogPath)).length, 0);

      const selectorCustom: ExtensionUIContext['custom'] = (factory) => {
        return new Promise((resolvePromise, reject) => {
          Promise.resolve(factory(fakeTui(), makeTheme(), fakeKeybindings(), resolvePromise))
            .then((component: Component & { dispose?(): void }) => {
              component.handleInput?.('\r');
              component.handleInput?.('a');
              component.handleInput?.('l');
              component.handleInput?.('t');
              component.handleInput?.('\r');
              component.handleInput?.('\x1b[B');
              component.handleInput?.('\r');
              component.handleInput?.('a');
              component.handleInput?.('l');
              component.handleInput?.('t');
              component.handleInput?.('\r');
              component.handleInput?.('s');
            })
            .catch((error: unknown) => {
              reject(error);
            });
        });
      };
      // Pi 0.83 takes the run mode as a second setUIContext argument (default
      // "print"); /fusion-models is TUI-only, so the selector needs "tui".
      h.session.extensionRunner.setUIContext(
        {
          ...baseUi(h.session),
          custom: selectorCustom,
        },
        'tui',
      );
      const selectorCtx = h.session.extensionRunner.createCommandContext();
      await command(h.session, 'fusion-models').handler('', selectorCtx);
      const savedConfigText = await readFile(join(h.agentDir, FUSION_MODEL_CONFIG_FILE), 'utf8');
      const savedConfig = parseJsonText(savedConfigText);
      assert.ok(isRecord(savedConfig));
      assert.deepEqual(savedConfig['candidates'], [
        'pi-bg-fusion/alt-model',
        'pi-bg-fusion/alt-model',
        CURRENT_MODEL_SELECTION,
      ]);

      await writeFile(h.fakeLogPath, '', 'utf8');
      await writeFile(join(h.agentDir, FUSION_MODEL_CONFIG_FILE), '{"bad":true}\n', 'utf8');
      const invalidTool = h.session.getToolDefinition('fusion_brainstorm');
      assert.ok(invalidTool, 'fusion tool should remain registered');
      await assert.rejects(
        () =>
          invalidTool.execute(
            'call-invalid',
            { prompt: 'should not spawn' },
            undefined,
            undefined,
            h.session.extensionRunner.createContext(),
          ),
        /schema_version|unknown key|missing key/,
      );
      assert.equal((await invocations(h.fakeLogPath)).length, 0);
    } finally {
      await disposeHarness(h);
    }
  });
});

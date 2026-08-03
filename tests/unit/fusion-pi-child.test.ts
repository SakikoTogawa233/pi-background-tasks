import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SpawnOptions } from 'node:child_process';
import {
  FusionChildRunError,
  FusionPiCompactResultParser,
  assertFusionToolPolicyDisjoint,
  buildFusionPiChildArgv,
  fusionPiChildEnv,
  parseFusionChildStderr,
  parseFusionToolCallLog,
  resolveAnthropicSanitizerExtensionPath,
  runPiChild,
  type FusionChildProcess,
  type FusionChildSpawn,
} from '../../src/core/fusion/pi-child.js';
import type { Usage } from '@earendil-works/pi-ai';
import {
  FUSION_FORBIDDEN_TOOLS,
  FUSION_INSPECT_TOOLS,
  FUSION_TOOL_CALL_LOG_SCHEMA_VERSION,
  FUSION_WEB_FETCH_TOOL_NAME,
  type ResolvedFusionModel,
} from '../../src/core/fusion/types.js';
import fusionChildExtension, {
  FUSION_CHILD_RESULT_PREFIX,
  FUSION_RESEARCH_ENABLED_ENV,
  FUSION_SOURCE_POLICY_PATH_ENV,
  FUSION_SOURCE_POLICY_SHA256_ENV,
  FUSION_TOOL_CALL_LOG_PATH_ENV,
  buildFusionChildResultMetadata,
} from '../../src/fusion-child-extension.js';
import { buildFusionSourcePolicy, sourcePolicyCanonicalBytes } from '../../src/core/fusion/source-policy.js';

class FakeReadable extends EventEmitter {
  emitData(value: Buffer | string): void {
    this.emit('data', value);
  }
}

class FakeStdin extends EventEmitter {
  readonly chunks: Buffer[] = [];
  ended = false;
  writeError: Error | undefined;

  write(data: Buffer, callback: (error?: Error | null) => void): boolean {
    this.chunks.push(data);
    const error = this.writeError;
    queueMicrotask(() => callback(error));
    return true;
  }

  end(callback?: () => void): void {
    this.ended = true;
    if (callback !== undefined) queueMicrotask(callback);
  }
}

class FakeChild extends EventEmitter implements FusionChildProcess {
  readonly stdin = new FakeStdin();
  readonly stdout = new FakeReadable();
  readonly stderr = new FakeReadable();
  readonly killCalls: NodeJS.Signals[] = [];
  pid: number | undefined;

  constructor(pid: number | undefined = 1234) {
    super();
    this.pid = pid;
  }

  kill(signal?: NodeJS.Signals): boolean {
    if (signal !== undefined) this.killCalls.push(signal);
    return true;
  }

  close(code: number | null, signal: NodeJS.Signals | null): void {
    this.emit('close', code, signal);
  }

  fail(error: Error): void {
    this.emit('error', error);
  }
}

interface SpawnRecord {
  command: string;
  args: string[];
  options: SpawnOptions;
  child: FakeChild;
}

function resolvedModel(provider = 'openai-codex', model = 'gpt-5.5'): ResolvedFusionModel {
  return {
    selection: '$current',
    source: 'current',
    provider,
    model,
    qualifiedId: `${provider}/${model}`,
    thinkingLevel: 'high',
    contextWindow: 100000,
  };
}

function makeSpawn(child = new FakeChild()): { records: SpawnRecord[]; spawn: FusionChildSpawn } {
  const records: SpawnRecord[] = [];
  return {
    records,
    spawn: (command, args, options) => {
      records.push({ command, args, options, child });
      return child;
    },
  };
}

function compactFrame(input: {
  provider?: string;
  model?: string;
  text: string;
  stopReason: string;
  usage: Usage;
}): string {
  const record = buildFusionChildResultMetadata({
    provider: input.provider ?? 'openai-codex',
    model: input.model ?? 'gpt-5.5',
    stopReason: input.stopReason,
    content: [{ type: 'text', text: input.text }],
    usage: input.usage,
  });
  return `${FUSION_CHILD_RESULT_PREFIX}${JSON.stringify(record)}\n`;
}

function compactMetadata(provider = 'openai-codex', model = 'gpt-5.5'): string {
  return (
    compactFrame({
      provider,
      model,
      text: 'draft',
      stopReason: 'toolUse',
      usage: {
        input: 1,
        output: 2,
        cacheRead: 3,
        cacheWrite: 4,
        totalTokens: 10,
        cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
      },
    }) +
    compactFrame({
      provider,
      model,
      text: 'final héllo',
      stopReason: 'stop',
      usage: {
        input: 5,
        output: 6,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 11,
        cost: { input: 0.05, output: 0.06, cacheRead: 0.04, cacheWrite: 0.05, total: 0.2 },
      },
    })
  );
}

function piUsage(input: number, output: number, totalTokens = input + output): Usage {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function toolLogLine(ordinal: number, overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    schema_version: FUSION_TOOL_CALL_LOG_SCHEMA_VERSION,
    ordinal,
    tool_name: 'read',
    arguments_sha256: 'a'.repeat(64),
    arguments_bytes: 10,
    result_bytes: 20,
    result_sha256: 'b'.repeat(64),
    status: 'ok',
    duration_ms: 5,
    ...overrides,
  })}\n`;
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

void describe('fusion Pi child runner', () => {
  void it('BUG-182 preserves the complete Pi Usage cost contract in compact metadata', () => {
    const piUsage: Usage = {
      input: 11,
      output: 7,
      cacheRead: 2,
      cacheWrite: 3,
      totalTokens: 23,
      cost: {
        input: 0.001,
        output: 0.002,
        cacheRead: 0.003,
        cacheWrite: 0.004,
        total: 0.01,
      },
    };
    const record = buildFusionChildResultMetadata({
      provider: 'anthropic',
      model: 'claude-opus-5',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'answer' }],
      usage: piUsage,
    });
    const usage: unknown = record.usage;
    assert.deepEqual(usage, piUsage);
    assert.equal(Reflect.get(record.usage, 'costTotal'), undefined);

    const legacyRecord = {
      ...record,
      usage: {
        input: 11,
        output: 7,
        cacheRead: 2,
        cacheWrite: 3,
        totalTokens: 23,
        costTotal: 0.01,
      },
    };
    assert.throws(
      () =>
        parseFusionChildStderr(
          Buffer.from(`${FUSION_CHILD_RESULT_PREFIX}${JSON.stringify(legacyRecord)}\n`),
        ),
      /cost|keys mismatch|unknown key/,
    );
  });

  void it('BUG-180 launches a final-text child with only the private compact metadata extension', () => {
    const argv = buildFusionPiChildArgv(resolvedModel(), 'system');
    assert.deepEqual(argv.slice(0, 8), [
      '--mode',
      'text',
      '--no-session',
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
    ]);
    assert.ok(argv.includes('--no-context-files'));
    assert.ok(argv.includes('--system-prompt'));
    const extensionIndex = argv.indexOf('--extension');
    assert.ok(extensionIndex >= 0, 'private compact metadata extension flag');
    // Normalize separators: the resolved path is native, so Windows uses backslashes.
    assert.match(
      (argv[extensionIndex + 1] ?? '').replaceAll('\\', '/'),
      /extensions\/fusion-child\.ts$/,
    );
    const env = fusionPiChildEnv({
      PI_SESSION_ID: 'old',
      PI_MODEL: 'old-model',
      OPENAI_API_KEY: 'kept',
    });
    assert.equal(env['PI_SESSION_ID'], undefined);
    assert.equal(env['PI_MODEL'], undefined);
    assert.equal(env['OPENAI_API_KEY'], 'kept');
    assert.equal(env[FUSION_TOOL_CALL_LOG_PATH_ENV], undefined);
    assert.equal(env['PI_SKIP_VERSION_CHECK'], '1');
  });

  void it('scrubs inherited fusion tool-call log env var before launch-specific wiring', () => {
    const env = fusionPiChildEnv({
      PI_SESSION_ID: 'old',
      [FUSION_TOOL_CALL_LOG_PATH_ENV]: '/tmp/fusion-tools.jsonl',
    });
    assert.equal(env['PI_SESSION_ID'], undefined);
    assert.equal(env[FUSION_TOOL_CALL_LOG_PATH_ENV], undefined);
  });

  void it('builds byte-identical reasoning argv with no tools', () => {
    assert.deepEqual(buildFusionPiChildArgv(resolvedModel(), 'system', 'extension.js', 'reason'), [
      '--mode',
      'text',
      '--no-session',
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--extension',
      'extension.js',
      '--provider',
      'openai-codex',
      '--model',
      'gpt-5.5',
      '--thinking',
      'high',
      '--system-prompt',
      'system',
    ]);
  });

  void it('builds byte-identical inspect argv with exact read-only allowlist and denylist', () => {
    const argv = buildFusionPiChildArgv(resolvedModel(), 'system', 'extension.js', 'inspect');
    assert.equal(argv.includes('--no-tools'), false);
    assert.deepEqual(argv, [
      '--mode',
      'text',
      '--no-session',
      '--no-builtin-tools',
      '--tools',
      FUSION_INSPECT_TOOLS.join(','),
      '--exclude-tools',
      FUSION_FORBIDDEN_TOOLS.join(','),
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--no-context-files',
      '--extension',
      'extension.js',
      '--provider',
      'openai-codex',
      '--model',
      'gpt-5.5',
      '--thinking',
      'high',
      '--system-prompt',
      'system',
    ]);
  });

  void it('builds research argv with read-only tools plus fusion_web_fetch', () => {
    const argv = buildFusionPiChildArgv(resolvedModel(), 'system', 'extension.js', 'research');
    assert.equal(argv.includes('--no-tools'), false);
    assert.deepEqual(argv.slice(0, 11), [
      '--mode',
      'text',
      '--no-session',
      '--no-builtin-tools',
      '--tools',
      [...FUSION_INSPECT_TOOLS, FUSION_WEB_FETCH_TOOL_NAME].join(','),
      '--exclude-tools',
      FUSION_FORBIDDEN_TOOLS.join(','),
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
    ]);
  });

  void it('appends the Anthropic sanitizer only for Claude routes', () => {
    // Pi's system prompt carries documentation lines Anthropic rejects. The parent gets
    // the sanitizer through extension discovery, but children run --no-extensions and
    // inherit nothing, so a Claude child without it fails at the provider.
    const sanitizer = () => '/pkg/anthropic-sps/index.ts';
    const claude = buildFusionPiChildArgv(
      resolvedModel('anthropic', 'claude-opus-5'),
      'system',
      'extension.js',
      'reason',
      sanitizer,
    );
    const extensionArgs = claude.reduce<string[]>((acc, value, index) => {
      if (value === '--extension') acc.push(claude[index + 1] ?? '');
      return acc;
    }, []);
    assert.deepEqual(extensionArgs, ['extension.js', '/pkg/anthropic-sps/index.ts']);
    // The metadata extension must stay first so its message_end frame is never displaced.
    assert.equal(extensionArgs[0], 'extension.js');
  });

  void it('keeps non-Anthropic child argv byte-identical to the pre-sanitizer form', () => {
    // Adding Claude support must not move a single argv byte on other providers.
    const sanitizer = () => {
      throw new Error('sanitizer must not be resolved for non-Anthropic routes');
    };
    for (const provider of ['openai-codex', 'openai', 'google', 'unknown-provider']) {
      const argv = buildFusionPiChildArgv(
        resolvedModel(provider, 'm1'),
        'system',
        'extension.js',
        'reason',
        sanitizer,
      );
      assert.equal(argv.filter((value) => value === '--extension').length, 1);
      assert.equal(argv[argv.indexOf('--extension') + 1], 'extension.js');
    }
  });

  void it('resolves the sanitizer from the real installed package', () => {
    // The sanitizer package publishes no main/exports, so it must be located through its
    // manifest rather than a direct require. This pins that the real dependency resolves.
    const resolved = resolveAnthropicSanitizerExtensionPath();
    assert.match(resolved, /pi-anthropic-sps/);
    assert.equal(existsSync(resolved), true);
  });

  void it('fails loudly when the sanitizer package or its extension is unusable', () => {
    // Silently dropping the sanitizer would surface later as an opaque provider
    // rejection, so every resolution failure must be explicit here instead.
    assert.throws(
      () =>
        resolveAnthropicSanitizerExtensionPath({
          resolvePackageJson: () => {
            throw new Error('not installed');
          },
        }),
      /could not be resolved.*Claude children cannot be launched without it/s,
    );
    assert.throws(
      () =>
        resolveAnthropicSanitizerExtensionPath({
          resolvePackageJson: () => '/pkg/package.json',
          readManifest: () => '{not json',
        }),
      /is not valid JSON/,
    );
    assert.throws(
      () =>
        resolveAnthropicSanitizerExtensionPath({
          resolvePackageJson: () => '/pkg/package.json',
          readManifest: () => '{"name":"x"}',
        }),
      /has no "pi" section/,
    );
    assert.throws(
      () =>
        resolveAnthropicSanitizerExtensionPath({
          resolvePackageJson: () => '/pkg/package.json',
          readManifest: () => '{"pi":{"extensions":[]}}',
        }),
      /declares no pi.extensions entries/,
    );
    assert.throws(
      () =>
        resolveAnthropicSanitizerExtensionPath({
          resolvePackageJson: () => '/pkg/package.json',
          readManifest: () => '{"pi":{"extensions":["  "]}}',
        }),
      /must be a non-blank string/,
    );
    assert.throws(
      () =>
        resolveAnthropicSanitizerExtensionPath({
          resolvePackageJson: () => '/pkg/package.json',
          readManifest: () => '{"pi":{"extensions":["./index.ts"]}}',
          pathExists: () => false,
        }),
      /Anthropic sanitizer extension is missing/,
    );
  });

  void it('rejects fusion tool policy intersections loudly', () => {
    assert.throws(
      () => assertFusionToolPolicyDisjoint(['read', 'bash'], ['bash']),
      /forbidden tool bash/,
    );
  });

  void it('round-trips and summarizes a complete 3-call tool log', () => {
    const trace = parseFusionToolCallLog(
      Buffer.from(
        toolLogLine(0, { result_bytes: 7 }) +
          toolLogLine(1, { result_bytes: 11, status: 'error' }) +
          toolLogLine(2, { result_bytes: 13 }),
        'utf8',
      ),
    );
    assert.equal(trace.records.length, 3);
    assert.deepEqual(trace.summary, {
      count: 3,
      total_result_bytes: 31,
      trace_complete: true,
    });
  });

  void it('round-trips fusion_web_fetch audit metadata without raw page content', () => {
    const pageContent = 'PAGE CONTENT MUST NOT BE STORED';
    const bytes = Buffer.from(
      toolLogLine(0, {
        tool_name: FUSION_WEB_FETCH_TOOL_NAME,
        result_bytes: 123,
        result_sha256: 'c'.repeat(64),
        url: 'https://example.com/start',
        final_url: 'https://example.com/final',
        http_status: 200,
        response_bytes: 456,
        content_sha256: 'd'.repeat(64),
      }),
      'utf8',
    );
    assert.doesNotMatch(bytes.toString('utf8'), new RegExp(pageContent));
    const trace = parseFusionToolCallLog(bytes);
    const record = trace.records[0];
    assert.equal(record?.tool_name, FUSION_WEB_FETCH_TOOL_NAME);
    assert.equal(record?.url, 'https://example.com/start');
    assert.equal(record?.final_url, 'https://example.com/final');
    assert.equal(record?.http_status, 200);
    assert.equal(record?.response_bytes, 456);
    assert.equal(record?.content_sha256, 'd'.repeat(64));
  });

  void it('rejects a trailing partial tool-log line loudly', () => {
    assert.throws(
      () => parseFusionToolCallLog(Buffer.from(`${toolLogLine(0)}{"schema_version"`, 'utf8')),
      /trailing partial line/,
    );
  });

  void it('rejects tool-log ordinal gaps loudly', () => {
    assert.throws(
      () => parseFusionToolCallLog(Buffer.from(toolLogLine(0) + toolLogLine(2), 'utf8')),
      /ordinal gap: expected 1, observed 2/,
    );
  });

  void it('rejects duplicate tool-log ordinals loudly', () => {
    assert.throws(
      () => parseFusionToolCallLog(Buffer.from(toolLogLine(0) + toolLogLine(0), 'utf8')),
      /duplicate ordinal 0/,
    );
  });

  void it('rejects wrong tool-log schema versions loudly', () => {
    assert.throws(
      () =>
        parseFusionToolCallLog(
          Buffer.from(toolLogLine(0, { schema_version: 'wrong.schema' }), 'utf8'),
        ),
      /schema_version mismatch/,
    );
  });

  void it('logs completed tool calls without raw arguments or results', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-tool-log-extension-'));
    const oldPath = process.env[FUSION_TOOL_CALL_LOG_PATH_ENV];
    try {
      const logPath = join(root, 'tool-calls.jsonl');
      process.env[FUSION_TOOL_CALL_LOG_PATH_ENV] = logPath;
      // Minimal structurally-typed stub. `ExtensionAPI['on']` is a large overload set, so a
      // local recorder interface is declared instead of double-asserting the whole API: the
      // child extension only ever calls `pi.on(name, handler)`.
      type FusionChildPi = Parameters<typeof fusionChildExtension>[0];
      type RecordedHandler = (event: Record<string, unknown>) => unknown;
      interface HandlerRecorder {
        on(event: string, handler: RecordedHandler): void;
      }
      const handlers = new Map<string, RecordedHandler[]>();
      const recorder: HandlerRecorder = {
        on(event, handler) {
          const existing = handlers.get(event) ?? [];
          existing.push(handler);
          handlers.set(event, existing);
        },
      };
      fusionChildExtension(recorder as HandlerRecorder & FusionChildPi);
      const toolCall = handlers.get('tool_call')?.[0];
      const toolResult = handlers.get('tool_result')?.[0];
      assert.ok(toolCall);
      assert.ok(toolResult);
      const secret = 'SECRET_TOKEN_SHOULD_NOT_BE_IN_LOG';
      toolCall({ toolCallId: 'call-1', toolName: 'read', input: { path: secret } });
      toolResult({
        toolCallId: 'call-1',
        toolName: 'read',
        input: { path: secret },
        content: [{ type: 'text', text: `file contents ${secret}` }],
        details: { echoed: secret },
        isError: false,
        usage: piUsage(0, 0),
      });
      const bytes = await readFile(logPath);
      assert.doesNotMatch(bytes.toString('utf8'), new RegExp(secret));
      const trace = parseFusionToolCallLog(bytes);
      assert.equal(trace.summary.count, 1);
      assert.equal(trace.records[0]?.tool_name, 'read');
      assert.equal(trace.records[0]?.status, 'ok');
    } finally {
      if (oldPath === undefined) delete process.env[FUSION_TOOL_CALL_LOG_PATH_ENV];
      else process.env[FUSION_TOOL_CALL_LOG_PATH_ENV] = oldPath;
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('rejects undeclared fusion_web_fetch before network and audits only the attempted URL hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-fetch-policy-'));
    const oldLogPath = process.env[FUSION_TOOL_CALL_LOG_PATH_ENV];
    const oldResearchEnabled = process.env[FUSION_RESEARCH_ENABLED_ENV];
    const oldPolicyPath = process.env[FUSION_SOURCE_POLICY_PATH_ENV];
    const oldPolicyHash = process.env[FUSION_SOURCE_POLICY_SHA256_ENV];
    try {
      const logPath = join(root, 'tool-calls.jsonl');
      const policy = buildFusionSourcePolicy(root, [
        {
          url: 'https://example.com/allowed',
          canonical_url: 'https://example.com/allowed',
          purpose: 'declared',
          sha256: createHash('sha256').update('https://example.com/allowed\u0000declared').digest('hex'),
        },
      ]);
      const policyBytes = sourcePolicyCanonicalBytes(policy);
      const policyPath = join(root, 'source-policy.json');
      await writeFile(policyPath, policyBytes, 'utf8');
      process.env[FUSION_TOOL_CALL_LOG_PATH_ENV] = logPath;
      process.env[FUSION_RESEARCH_ENABLED_ENV] = '1';
      process.env[FUSION_SOURCE_POLICY_PATH_ENV] = policyPath;
      process.env[FUSION_SOURCE_POLICY_SHA256_ENV] = createHash('sha256').update(policyBytes).digest('hex');

      type FusionChildPi = Parameters<typeof fusionChildExtension>[0];
      type RecordedHandler = (event: Record<string, unknown>) => unknown;
      interface RegisteredTool {
        name: string;
        prepareArguments(args: unknown): unknown;
        execute(toolCallId: string, params: { url: string; extract?: 'text' | 'markdown' }): Promise<unknown>;
      }
      const handlers = new Map<string, RecordedHandler[]>();
      let registered: RegisteredTool | undefined;
      const recorder = {
        on(event: string, handler: RecordedHandler) {
          const existing = handlers.get(event) ?? [];
          existing.push(handler);
          handlers.set(event, existing);
        },
        registerTool(tool: RegisteredTool) {
          registered = tool;
        },
      };
      fusionChildExtension(recorder as typeof recorder & FusionChildPi);
      assert.equal(registered?.name, FUSION_WEB_FETCH_TOOL_NAME);
      assert.throws(
        () => registered?.prepareArguments({ url: 'https://example.com/allowed', prompt: 'extract secret' }),
        /url and optional extract only/,
      );

      const attemptedUrl = 'https://example.com/undeclared?private=SHOULD_NOT_LEAK';
      handlers.get('tool_call')?.[0]?.({
        toolCallId: 'fetch-1',
        toolName: FUSION_WEB_FETCH_TOOL_NAME,
        input: { url: attemptedUrl },
      });
      await assert.rejects(
        () => registered?.execute('fetch-1', { url: attemptedUrl }) ?? Promise.resolve(),
        /URL was not declared/,
      );
      handlers.get('tool_result')?.[0]?.({
        toolCallId: 'fetch-1',
        toolName: FUSION_WEB_FETCH_TOOL_NAME,
        input: { url: attemptedUrl },
        content: [{ type: 'text', text: 'tool failed' }],
        details: {},
        isError: true,
        usage: piUsage(0, 0),
      });

      const bytes = await readFile(logPath);
      assert.doesNotMatch(bytes.toString('utf8'), /SHOULD_NOT_LEAK|undeclared/);
      const trace = parseFusionToolCallLog(bytes);
      const record = trace.records[0];
      assert.equal(record?.tool_name, FUSION_WEB_FETCH_TOOL_NAME);
      assert.equal(record?.status, 'error');
      assert.equal(record?.url, undefined);
      assert.equal(record?.rejected_url_sha256, createHash('sha256').update(attemptedUrl).digest('hex'));
    } finally {
      if (oldLogPath === undefined) delete process.env[FUSION_TOOL_CALL_LOG_PATH_ENV];
      else process.env[FUSION_TOOL_CALL_LOG_PATH_ENV] = oldLogPath;
      if (oldResearchEnabled === undefined) delete process.env[FUSION_RESEARCH_ENABLED_ENV];
      else process.env[FUSION_RESEARCH_ENABLED_ENV] = oldResearchEnabled;
      if (oldPolicyPath === undefined) delete process.env[FUSION_SOURCE_POLICY_PATH_ENV];
      else process.env[FUSION_SOURCE_POLICY_PATH_ENV] = oldPolicyPath;
      if (oldPolicyHash === undefined) delete process.env[FUSION_SOURCE_POLICY_SHA256_ENV];
      else process.env[FUSION_SOURCE_POLICY_SHA256_ENV] = oldPolicyHash;
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('keeps reasoning and full response text out of compact child metadata', () => {
    const record = buildFusionChildResultMetadata({
      provider: 'openai-codex',
      model: 'gpt-5.5',
      stopReason: 'stop',
      content: [
        { type: 'thinking', text: 'private reasoning must not cross the child boundary' },
        { type: 'text', text: 'complete final answer' },
      ],
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const serialized = JSON.stringify(record);
    assert.doesNotMatch(serialized, /private reasoning/);
    assert.doesNotMatch(serialized, /complete final answer/);
    assert.deepEqual(
      record.text_blocks.map((block) => block.utf8_bytes),
      [21],
    );
  });

  void it('pipes the prompt through stdin and returns the exact full text with compact metadata', async () => {
    const child = new FakeChild(777);
    const harness = makeSpawn(child);
    const run = runPiChild({
      stage: 'candidate',
      slot: 1,
      attempt: 1,
      cwd: '/tmp/project',
      model: resolvedModel(),
      systemPrompt: 'system prompt',
      userPrompt: 'large prompt with U+2028 \u2028 and U+2029 \u2029',
      spawn: harness.spawn,
      platform: 'linux',
      env: { PI_SESSION_FILE: 'old', ANTHROPIC_API_KEY: 'kept' },
    });
    await tick();
    const record = harness.records[0];
    assert.ok(record, 'spawn record exists');
    assert.equal(record.command, 'pi');
    assert.equal(record.options.shell, false);
    assert.deepEqual(record.options.stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal(record.options.env?.['PI_SESSION_FILE'], undefined);
    assert.equal(record.options.env?.['ANTHROPIC_API_KEY'], 'kept');
    assert.equal(record.options.env?.[FUSION_TOOL_CALL_LOG_PATH_ENV], undefined);
    assert.equal(
      Buffer.concat(child.stdin.chunks).toString('utf8'),
      'large prompt with U+2028 \u2028 and U+2029 \u2029',
    );
    assert.equal(child.stdin.ended, true);

    const response = Buffer.from('final héllo\n', 'utf8');
    child.stdout.emitData(response.subarray(0, 4));
    child.stdout.emitData(response.subarray(4));
    const metadata = Buffer.from(compactMetadata(), 'utf8');
    child.stderr.emitData('diagnostic');
    child.stderr.emitData(metadata.subarray(0, 23));
    child.stderr.emitData(metadata.subarray(23));
    child.close(0, null);
    const result = await run;
    assert.equal(result.text, 'final héllo');
    assert.equal(result.usage.input, 6);
    assert.equal(result.usage.output, 8);
    assert.equal(result.usage.totalTokens, 21);
    assert.deepEqual(result.usage.cost, {
      input: 0.060000000000000005,
      output: 0.08,
      cacheRead: 0.07,
      cacheWrite: 0.09,
      total: 0.30000000000000004,
    });
    assert.equal(result.stderr.toString('utf8'), 'diagnostic');
    assert.equal(result.events.toString('utf8').split('\n').filter(Boolean).length, 2);
    assert.doesNotMatch(result.events.toString('utf8'), /final héllo/);
  });

  void it('passes tool-call audit env vars only for tool-enabled children', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-tool-log-env-'));
    try {
      const child = new FakeChild(778);
      const harness = makeSpawn(child);
      const logPath = join(root, 'candidate-1.attempt-1.tool-calls.jsonl');
      const run = runPiChild({
        stage: 'candidate',
        slot: 1,
        attempt: 1,
        cwd: root,
        model: resolvedModel(),
        capability: 'inspect',
        toolCallLogPath: logPath,
        systemPrompt: 'system prompt',
        userPrompt: 'prompt',
        spawn: harness.spawn,
        platform: 'linux',
      });
      await tick();
      const record = harness.records[0];
      assert.ok(record);
      assert.equal(record.options.env?.[FUSION_TOOL_CALL_LOG_PATH_ENV], logPath);
      assert.equal(record.options.env?.[FUSION_RESEARCH_ENABLED_ENV], undefined);
      // The real child extension creates this file at startup before tools can run. This
      // fake child never loads the extension, so the empty-but-present log is written here
      // to model a genuine zero-tool-call inspect run. An ABSENT file is a different case
      // and must fail loudly - covered by the missing-log test below.
      await writeFile(logPath, '');
      child.stdout.emitData(Buffer.from('final héllo\n', 'utf8'));
      child.stderr.emitData(compactMetadata());
      child.close(0, null);
      const result = await run;
      assert.deepEqual(result.toolCallTrace?.summary, {
        count: 0,
        total_result_bytes: 0,
        trace_complete: true,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('passes the research env var only for research children', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-research-env-'));
    try {
      const child = new FakeChild(782);
      const harness = makeSpawn(child);
      const logPath = join(root, 'candidate-1.attempt-1.tool-calls.jsonl');
      const policy = buildFusionSourcePolicy(root, []);
      const policyPath = join(root, 'source-policy.json');
      const policyBytes = sourcePolicyCanonicalBytes(policy);
      await writeFile(policyPath, policyBytes);
      const run = runPiChild({
        stage: 'candidate',
        slot: 1,
        attempt: 1,
        cwd: root,
        model: resolvedModel(),
        capability: 'research',
        toolCallLogPath: logPath,
        sourcePolicy: { path: policyPath, sha256: createHash('sha256').update(policyBytes).digest('hex') },
        systemPrompt: 'system prompt',
        userPrompt: 'prompt',
        spawn: harness.spawn,
        platform: 'linux',
      });
      await tick();
      const record = harness.records[0];
      assert.ok(record);
      assert.equal(record.options.env?.[FUSION_TOOL_CALL_LOG_PATH_ENV], logPath);
      assert.equal(record.options.env?.[FUSION_RESEARCH_ENABLED_ENV], '1');
      assert.equal(record.options.env?.['PI_FUSION_SOURCE_POLICY_PATH'], policyPath);
      await writeFile(logPath, '');
      child.stdout.emitData(Buffer.from('final héllo\n', 'utf8'));
      child.stderr.emitData(compactMetadata());
      child.close(0, null);
      const result = await run;
      assert.equal(result.toolCallTrace?.summary.count, 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('fails inspect children loudly when their tool-call log was never created', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-tool-log-missing-'));
    try {
      const child = new FakeChild(781);
      const harness = makeSpawn(child);
      // Deliberately never create the log: this models a child whose audit trail was never
      // established. It must be distinguishable from a child that legitimately made zero
      // tool calls, otherwise an unrecorded run could report success.
      const logPath = join(root, 'candidate-1.attempt-1.tool-calls.jsonl');
      const run = runPiChild({
        stage: 'candidate',
        slot: 1,
        attempt: 1,
        cwd: root,
        model: resolvedModel(),
        capability: 'inspect',
        toolCallLogPath: logPath,
        systemPrompt: 'system prompt',
        userPrompt: 'prompt',
        spawn: harness.spawn,
        platform: 'linux',
      });
      await tick();
      child.stdout.emitData(Buffer.from('final héllo\n', 'utf8'));
      child.stderr.emitData(compactMetadata());
      child.close(0, null);
      await assert.rejects(run, (error: unknown) => {
        assert.ok(error instanceof FusionChildRunError);
        assert.equal(error.code, 'child_event_invalid');
        assert.match(error.message, /never initialized its audit trail/);
        return true;
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('fails tool-enabled children when the durable audit names a non-allowlisted tool', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-tool-log-allowlist-'));
    try {
      const child = new FakeChild(783);
      const harness = makeSpawn(child);
      const logPath = join(root, 'candidate-1.attempt-1.tool-calls.jsonl');
      const run = runPiChild({
        stage: 'candidate',
        slot: 1,
        attempt: 1,
        cwd: root,
        model: resolvedModel(),
        capability: 'inspect',
        toolCallLogPath: logPath,
        systemPrompt: 'system prompt',
        userPrompt: 'prompt',
        spawn: harness.spawn,
        platform: 'linux',
      });
      await tick();
      await writeFile(logPath, toolLogLine(0, { tool_name: 'bash' }), 'utf8');
      child.stdout.emitData(Buffer.from('final héllo\n', 'utf8'));
      child.stderr.emitData(compactMetadata());
      child.close(0, null);
      await assert.rejects(run, (error: unknown) => {
        assert.ok(error instanceof FusionChildRunError);
        assert.equal(error.code, 'child_event_invalid');
        assert.match(error.message, /non-allowlisted tool bash/);
        return true;
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('fails research children when a successful fetch audit URL was not declared', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-tool-log-source-policy-'));
    try {
      const child = new FakeChild(784);
      const harness = makeSpawn(child);
      const logPath = join(root, 'candidate-1.attempt-1.tool-calls.jsonl');
      const policy = buildFusionSourcePolicy(root, []);
      const policyPath = join(root, 'source-policy.json');
      const policyBytes = sourcePolicyCanonicalBytes(policy);
      await writeFile(policyPath, policyBytes, 'utf8');
      const run = runPiChild({
        stage: 'candidate',
        slot: 1,
        attempt: 1,
        cwd: root,
        model: resolvedModel(),
        capability: 'research',
        toolCallLogPath: logPath,
        sourcePolicy: { path: policyPath, sha256: createHash('sha256').update(policyBytes).digest('hex') },
        systemPrompt: 'system prompt',
        userPrompt: 'prompt',
        spawn: harness.spawn,
        platform: 'linux',
      });
      await tick();
      await writeFile(
        logPath,
        toolLogLine(0, { tool_name: FUSION_WEB_FETCH_TOOL_NAME, url: 'https://example.com/not-declared' }),
        'utf8',
      );
      child.stdout.emitData(Buffer.from('final héllo\n', 'utf8'));
      child.stderr.emitData(compactMetadata());
      child.close(0, null);
      await assert.rejects(run, (error: unknown) => {
        assert.ok(error instanceof FusionChildRunError);
        assert.equal(error.code, 'child_event_invalid');
        assert.match(error.message, /URL was not declared/);
        return true;
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('fails inspect children loudly when their tool-call log is partial', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-tool-log-partial-'));
    try {
      const child = new FakeChild(779);
      const harness = makeSpawn(child);
      const logPath = join(root, 'candidate-1.attempt-1.tool-calls.jsonl');
      const run = runPiChild({
        stage: 'candidate',
        slot: 1,
        attempt: 1,
        cwd: root,
        model: resolvedModel(),
        capability: 'inspect',
        toolCallLogPath: logPath,
        systemPrompt: 'system prompt',
        userPrompt: 'prompt',
        spawn: harness.spawn,
        platform: 'linux',
      });
      await tick();
      await writeFile(logPath, `${toolLogLine(0)}{"schema_version"`, 'utf8');
      child.stdout.emitData(Buffer.from('final héllo\n', 'utf8'));
      child.stderr.emitData(compactMetadata());
      child.close(0, null);
      await assert.rejects(run, (error: unknown) => {
        assert.ok(error instanceof FusionChildRunError);
        assert.equal(error.code, 'child_event_invalid');
        assert.match(error.message, /tool-call log invalid: .*trailing partial line/);
        return true;
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('fails stalled children with child_timeout and terminates them', async () => {
    const child = new FakeChild(515);
    const harness = makeSpawn(child);
    const run = runPiChild({
      stage: 'candidate',
      slot: 1,
      attempt: 1,
      cwd: '/tmp/project',
      model: resolvedModel(),
      systemPrompt: 'system',
      userPrompt: 'prompt',
      spawn: harness.spawn,
      platform: 'win32',
      idleTimeoutMs: 20,
      timeoutMs: 1000,
      killGraceMs: 10,
      sigkillWaitMs: 10,
    });
    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof FusionChildRunError);
      assert.equal(error.code, 'child_timeout');
      assert.match(error.message, /Pi child produced no output for 20ms \(stalled\)/);
      assert.doesNotMatch(error.message, /timed out after 1000ms/);
      return true;
    });
    assert.deepEqual(child.killCalls, ['SIGTERM', 'SIGKILL']);
  });

  void it('resets the stalled-child watchdog on stderr activity and completes successfully', async () => {
    const child = new FakeChild(516);
    const harness = makeSpawn(child);
    const run = runPiChild({
      stage: 'candidate',
      slot: 2,
      attempt: 1,
      cwd: '/tmp/project',
      model: resolvedModel(),
      systemPrompt: 'system',
      userPrompt: 'prompt',
      spawn: harness.spawn,
      platform: 'win32',
      idleTimeoutMs: 60,
      timeoutMs: 1000,
      killGraceMs: 10,
      sigkillWaitMs: 10,
    });
    await tick();
    await delay(30);
    child.stderr.emitData('diagnostic one\n');
    await delay(30);
    child.stderr.emitData('diagnostic two\n');
    await delay(30);
    child.stdout.emitData('final héllo\n');
    child.stderr.emitData(compactMetadata());
    child.close(0, null);

    const result = await run;
    assert.equal(result.text, 'final héllo');
    assert.equal(result.stderr.toString('utf8'), 'diagnostic one\ndiagnostic two\n');
    assert.deepEqual(child.killCalls, []);
  });

  void it('keeps the absolute timeout distinct from the stalled-child watchdog', async () => {
    const child = new FakeChild(517);
    const harness = makeSpawn(child);
    const run = runPiChild({
      stage: 'merge',
      attempt: 1,
      cwd: '/tmp/project',
      model: resolvedModel(),
      systemPrompt: 'system',
      userPrompt: 'prompt',
      spawn: harness.spawn,
      platform: 'win32',
      idleTimeoutMs: 1000,
      timeoutMs: 20,
      killGraceMs: 10,
      sigkillWaitMs: 10,
    });
    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof FusionChildRunError);
      assert.equal(error.code, 'child_timeout');
      assert.match(error.message, /Pi child timed out after 20ms/);
      assert.doesNotMatch(error.message, /stalled/);
      return true;
    });
    assert.deepEqual(child.killCalls, ['SIGTERM', 'SIGKILL']);
  });

  void it('launches Windows Pi through Node and preserves adversarial argv without a shell', async () => {
    const child = new FakeChild(778);
    const harness = makeSpawn(child);
    const systemPrompt = 'system & echo pwned "%VAR%" C:\\tmp\\space path\\';
    const run = runPiChild({
      stage: 'candidate',
      slot: 1,
      attempt: 1,
      cwd: '/tmp/project',
      model: resolvedModel(),
      systemPrompt,
      userPrompt: 'user prompt',
      spawn: harness.spawn,
      platform: 'win32',
      childExtensionPath: '/tmp/fusion-child.js',
    });
    await tick();
    const record = harness.records[0];
    assert.ok(record, 'spawn record exists');
    assert.equal(record.command, process.execPath);
    assert.equal(record.options.shell, false);
    assert.equal(record.options.detached, false);
    assert.ok(record.args[0]?.endsWith('cli.js'));
    const systemPromptIndex = record.args.indexOf('--system-prompt');
    assert.ok(systemPromptIndex >= 0);
    assert.equal(record.args[systemPromptIndex + 1], systemPrompt);
    assert.equal(Buffer.concat(child.stdin.chunks).toString('utf8'), 'user prompt');

    child.stdout.emitData(Buffer.from('final héllo\n', 'utf8'));
    child.stderr.emitData(compactMetadata());
    child.close(0, null);
    const result = await run;
    assert.equal(result.text, 'final héllo');
  });

  void it('rejects malformed compact metadata loudly', async () => {
    const child = new FakeChild(888);
    const harness = makeSpawn(child);
    const run = runPiChild({
      stage: 'candidate',
      slot: 2,
      attempt: 1,
      cwd: '/tmp/project',
      model: resolvedModel(),
      systemPrompt: 'system',
      userPrompt: 'prompt',
      spawn: harness.spawn,
      platform: 'linux',
      killGraceMs: 50,
      sigkillWaitMs: 50,
    });
    await tick();
    child.stdout.emitData('x\n');
    child.stderr.emitData(`${FUSION_CHILD_RESULT_PREFIX}{broken}\n`);
    child.close(0, null);
    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof FusionChildRunError);
      assert.equal(error.code, 'child_event_invalid');
      return true;
    });
  });

  void it('fails before spawn when Windows Pi launch resolution fails', async () => {
    const harness = makeSpawn();
    await assert.rejects(
      runPiChild({
        stage: 'merge',
        attempt: 1,
        cwd: '/tmp/project',
        model: resolvedModel(),
        systemPrompt: 'system',
        userPrompt: 'prompt',
        spawn: harness.spawn,
        platform: 'win32',
        piLaunchDependencies: {
          resolvePackageJson: () => {
            throw new Error('missing package');
          },
        },
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /pi_executable_resolution_failed/);
        assert.equal(Reflect.get(error, 'childCreated'), false);
        return true;
      },
    );
    assert.equal(harness.records.length, 0);
  });

  void it('fails before spawn when Windows Pi argv exceeds the command line limit', async () => {
    const harness = makeSpawn();
    await assert.rejects(
      runPiChild({
        stage: 'merge',
        attempt: 1,
        cwd: '/tmp/project',
        model: resolvedModel(),
        systemPrompt: 'x'.repeat(40000),
        userPrompt: 'prompt',
        spawn: harness.spawn,
        platform: 'win32',
      }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /pi_command_line_too_long/);
        assert.equal(Reflect.get(error, 'childCreated'), false);
        return true;
      },
    );
    assert.equal(harness.records.length, 0);
  });

  void it('fails before spawn when the abort signal is already set', async () => {
    const controller = new AbortController();
    controller.abort();
    const harness = makeSpawn();
    await assert.rejects(
      runPiChild({
        stage: 'merge',
        attempt: 1,
        cwd: '/tmp/project',
        model: resolvedModel(),
        systemPrompt: 'system',
        userPrompt: 'prompt',
        spawn: harness.spawn,
        signal: controller.signal,
      }),
      /cancelled before spawn/,
    );
    assert.equal(harness.records.length, 0);
  });

  void it('catches an abort that fires during spawn before listener attachment', async () => {
    const controller = new AbortController();
    const child = new FakeChild(333);
    const records: SpawnRecord[] = [];
    const run = runPiChild({
      stage: 'candidate',
      slot: 1,
      attempt: 1,
      cwd: '/tmp/project',
      model: resolvedModel(),
      systemPrompt: 'system',
      userPrompt: 'prompt',
      spawn: (command, args, options) => {
        records.push({ command, args, options, child });
        controller.abort();
        return child;
      },
      signal: controller.signal,
      platform: 'win32',
      killGraceMs: 1000,
      sigkillWaitMs: 1000,
    });
    await tick();
    assert.equal(records.length, 1);
    assert.deepEqual(child.killCalls, ['SIGTERM']);
    child.close(null, 'SIGTERM');
    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof FusionChildRunError);
      assert.equal(error.code, 'child_cancelled');
      return true;
    });
  });

  void it('accepts a multi-message tool loop and sums usage across all records', () => {
    const stderr = Buffer.from(
      compactFrame({
        provider: 'p',
        model: 'm',
        text: 'tool request 1',
        stopReason: 'toolUse',
        usage: piUsage(1, 2, 3),
      }) +
        compactFrame({
          provider: 'p',
          model: 'm',
          text: 'tool request 2',
          stopReason: 'toolUse',
          usage: piUsage(4, 5, 9),
        }) +
        compactFrame({
          provider: 'p',
          model: 'm',
          text: 'final answer',
          stopReason: 'stop',
          usage: piUsage(6, 7, 13),
        }),
      'utf8',
    );

    const parsed = new FusionPiCompactResultParser('p', 'm').finish(
      Buffer.from('final answer\n', 'utf8'),
      stderr,
    );

    assert.equal(parsed.text, 'final answer');
    assert.equal(parsed.usage.input, 11);
    assert.equal(parsed.usage.output, 14);
    assert.equal(parsed.usage.totalTokens, 25);
  });

  void it('rejects invalid transcript stop reasons loudly', () => {
    const parser = new FusionPiCompactResultParser('p', 'm');
    const frame = (stopReason: string, text = stopReason): string =>
      compactFrame({
        provider: 'p',
        model: 'm',
        text,
        stopReason,
        usage: piUsage(1, 1, 2),
      });
    const finish = (frames: string): void => {
      parser.finish(Buffer.from('final\n', 'utf8'), Buffer.from(frames, 'utf8'));
    };

    assert.throws(
      () => finish(frame('stop', 'early') + frame('stop', 'final')),
      /non-final record 0 stop reason is not toolUse: stop/,
    );
    assert.throws(
      () => finish(frame('length', 'early') + frame('stop', 'final')),
      /non-final record 0 stop reason is not toolUse: length .*truncated/,
    );
    assert.throws(
      () => finish(frame('toolUse', 'early') + frame('toolUse', 'final')),
      /final stop reason is not stop: toolUse/,
    );
    assert.throws(
      () => finish(frame('error', 'early') + frame('stop', 'final')),
      /non-final record 0 stop reason is not toolUse: error .*error stop/,
    );
    assert.throws(
      () => finish(frame('toolUse', 'early') + frame('error', 'final')),
      /final stop reason is not stop: error \(Pi reported an error stop\)/,
    );
    assert.throws(
      () => finish(frame('aborted', 'early') + frame('stop', 'final')),
      /non-final record 0 stop reason is not toolUse: aborted .*aborted stop/,
    );
    assert.throws(
      () => finish(frame('toolUse', 'early') + frame('aborted', 'final')),
      /final stop reason is not stop: aborted \(Pi reported an aborted stop\)/,
    );
    assert.throws(
      () => finish(frame('pending', 'early') + frame('stop', 'final')),
      /non-final record 0 stop reason is not toolUse: pending .*pending stop/,
    );
  });

  void it('reconstructs multiple print-mode text blocks without compacting the final answer', () => {
    const record = buildFusionChildResultMetadata({
      provider: 'p',
      model: 'm',
      stopReason: 'stop',
      content: [
        { type: 'text', text: 'first line\n' },
        { type: 'text', text: '世界' },
      ],
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const stderr = Buffer.from(`${FUSION_CHILD_RESULT_PREFIX}${JSON.stringify(record)}\n`, 'utf8');
    const response = Buffer.from('first line\n\n世界\n', 'utf8');
    const parsed = new FusionPiCompactResultParser('p', 'm').finish(response, stderr);
    assert.equal(parsed.text, 'first line\n世界');
  });

  void it('rejects non-stop final reasons, model mismatch, and unterminated metadata', () => {
    const usage = {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
    };
    const parser = new FusionPiCompactResultParser('p', 'm');
    const nonStop = compactFrame({
      provider: 'p',
      model: 'm',
      text: 'x',
      stopReason: 'length',
      usage,
    });
    assert.throws(() => parser.finish(Buffer.from('x\n'), Buffer.from(nonStop)), /not stop/);

    const mismatch = compactFrame({
      provider: 'p',
      model: 'other',
      text: 'x',
      stopReason: 'stop',
      usage,
    });
    assert.throws(() => parser.finish(Buffer.from('x\n'), Buffer.from(mismatch)), /model mismatch/);

    const valid = compactFrame({
      provider: 'p',
      model: 'm',
      text: 'expected',
      stopReason: 'stop',
      usage,
    });
    assert.throws(
      () => parser.finish(Buffer.from('tampered\n'), Buffer.from(valid)),
      /hash mismatch/,
    );
    assert.throws(() => parser.finish(Buffer.from('x\n'), Buffer.alloc(0)), /no compact result/);
    assert.throws(
      () => parseFusionChildStderr(Buffer.from(`${FUSION_CHILD_RESULT_PREFIX}{}`)),
      /newline-terminated/,
    );
  });

  void it('rejects stdin write failures and terminates the child loudly', async () => {
    const child = new FakeChild(456);
    child.stdin.writeError = new Error('EPIPE');
    const harness = makeSpawn(child);
    const run = runPiChild({
      stage: 'candidate',
      slot: 3,
      attempt: 1,
      cwd: '/tmp/project',
      model: resolvedModel(),
      systemPrompt: 'system',
      userPrompt: 'prompt',
      spawn: harness.spawn,
      platform: 'win32',
      killGraceMs: 50,
      sigkillWaitMs: 50,
    });
    await tick();
    child.close(null, 'SIGTERM');
    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof FusionChildRunError);
      assert.equal(error.code, 'child_stdin_failed');
      assert.match(error.message, /EPIPE/);
      return true;
    });
    assert.deepEqual(child.killCalls, ['SIGTERM']);
  });

  void it('surfaces cleanup failures even when child kill fallback succeeds', async () => {
    const child = new FakeChild(321);
    const harness = makeSpawn(child);
    const run = runPiChild({
      stage: 'candidate',
      slot: 2,
      attempt: 1,
      cwd: '/tmp/project',
      model: resolvedModel(),
      systemPrompt: 'system',
      userPrompt: 'prompt',
      spawn: harness.spawn,
      platform: 'linux',
      killProcess: () => false,
      stdoutLimitBytes: 4,
      killGraceMs: 20,
      sigkillWaitMs: 20,
    });
    await tick();
    child.stdout.emitData('abcdef');
    child.close(null, 'SIGTERM');
    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof FusionChildRunError);
      assert.equal(error.code, 'child_output_cap');
      assert.match(error.message, /process cleanup issues/);
      assert.match(error.message, /process group kill returned false/);
      return true;
    });
  });

  void it('fails instead of reporting completion when a killed child never closes', async () => {
    const child = new FakeChild(654);
    const harness = makeSpawn(child);
    const run = runPiChild({
      stage: 'merge',
      attempt: 1,
      cwd: '/tmp/project',
      model: resolvedModel(),
      systemPrompt: 'system',
      userPrompt: 'prompt',
      spawn: harness.spawn,
      platform: 'win32',
      stdoutLimitBytes: 4,
      killGraceMs: 10,
      sigkillWaitMs: 10,
    });
    await tick();
    child.stdout.emitData('abcdef');
    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof FusionChildRunError);
      assert.equal(error.code, 'child_output_cap');
      assert.match(error.message, /did not emit close/);
      return true;
    });
    assert.deepEqual(child.killCalls, ['SIGTERM', 'SIGKILL']);
  });

  void it('carries observed usage on child exit failures', async () => {
    const child = new FakeChild(111);
    const harness = makeSpawn(child);
    const run = runPiChild({
      stage: 'evaluation',
      attempt: 1,
      cwd: '/tmp/project',
      model: resolvedModel(),
      systemPrompt: 'system',
      userPrompt: 'prompt',
      spawn: harness.spawn,
      platform: 'win32',
      killGraceMs: 20,
      sigkillWaitMs: 20,
    });
    await tick();
    child.stdout.emitData('final héllo\n');
    child.stderr.emitData(compactMetadata());
    child.close(42, null);
    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof FusionChildRunError);
      assert.equal(error.code, 'child_exit_failed');
      assert.equal(error.usage.totalTokens, 21);
      assert.equal(error.qualifiedId, 'openai-codex/gpt-5.5');
      return true;
    });
  });

  void it('rejects output caps and keeps captured prefixes', async () => {
    const child = new FakeChild(999);
    const harness = makeSpawn(child);
    const run = runPiChild({
      stage: 'merge',
      attempt: 1,
      cwd: '/tmp/project',
      model: resolvedModel(),
      systemPrompt: 'system',
      userPrompt: 'prompt',
      spawn: harness.spawn,
      platform: 'win32',
      stdoutLimitBytes: 5,
      killGraceMs: 50,
      sigkillWaitMs: 50,
    });
    await tick();
    child.stdout.emitData('abcdef');
    child.close(null, 'SIGTERM');
    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof FusionChildRunError);
      assert.equal(error.code, 'child_output_cap');
      assert.equal(error.response.toString('utf8'), 'abcde');
      return true;
    });
    assert.deepEqual(child.killCalls, ['SIGTERM']);
  });
});

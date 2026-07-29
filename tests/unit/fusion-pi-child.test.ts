import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { SpawnOptions } from 'node:child_process';
import {
  FusionChildRunError,
  FusionPiJsonEventParser,
  buildFusionPiChildArgv,
  fusionPiChildEnv,
  runPiChild,
  type FusionChildProcess,
  type FusionChildSpawn,
} from '../../src/core/fusion/pi-child.js';
import type { ResolvedFusionModel } from '../../src/core/fusion/types.js';

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

function piEvents(provider = 'openai-codex', model = 'gpt-5.5'): string {
  return (
    [
      { type: 'session', id: 's1', cwd: '/tmp/project' },
      { type: 'agent_start' },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          provider,
          model,
          usage: {
            input: 1,
            output: 2,
            cacheRead: 3,
            cacheWrite: 4,
            totalTokens: 10,
            cost: { total: 0.1 },
          },
          content: [{ type: 'text', text: 'draft' }],
          stopReason: 'length',
        },
      },
      { type: 'agent_start' },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          provider,
          model,
          usage: {
            input: 5,
            output: 6,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 11,
            cost: { total: 0.2 },
          },
          content: [{ type: 'text', text: 'final héllo' }],
          stopReason: 'stop',
        },
      },
      { type: 'agent_end' },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n') + '\n'
  );
}

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

void describe('fusion Pi child runner', () => {
  void it('builds isolated argv and sanitizes only stale Pi session env', () => {
    const argv = buildFusionPiChildArgv(resolvedModel(), 'system');
    assert.deepEqual(argv.slice(0, 8), [
      '--mode',
      'json',
      '--no-session',
      '--no-tools',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
    ]);
    assert.ok(argv.includes('--no-context-files'));
    assert.ok(argv.includes('--system-prompt'));
    const env = fusionPiChildEnv({
      PI_SESSION_ID: 'old',
      PI_MODEL: 'old-model',
      OPENAI_API_KEY: 'kept',
    });
    assert.equal(env['PI_SESSION_ID'], undefined);
    assert.equal(env['PI_MODEL'], undefined);
    assert.equal(env['OPENAI_API_KEY'], 'kept');
    assert.equal(env['PI_SKIP_VERSION_CHECK'], '1');
  });

  void it('pipes the prompt through stdin and parses fragmented JSON events', async () => {
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
    assert.equal(
      Buffer.concat(child.stdin.chunks).toString('utf8'),
      'large prompt with U+2028 \u2028 and U+2029 \u2029',
    );
    assert.equal(child.stdin.ended, true);

    const bytes = Buffer.from(piEvents(), 'utf8');
    child.stdout.emitData(bytes.subarray(0, 17));
    child.stdout.emitData(bytes.subarray(17, 101));
    child.stdout.emitData(bytes.subarray(101));
    child.stderr.emitData('diagnostic');
    child.close(0, null);
    const result = await run;
    assert.equal(result.text, 'final héllo');
    assert.equal(result.usage.input, 6);
    assert.equal(result.usage.output, 8);
    assert.equal(result.usage.totalTokens, 21);
    assert.equal(result.usage.costTotal, 0.30000000000000004);
    assert.equal(result.stderr.toString('utf8'), 'diagnostic');
  });

  void it('rejects malformed JSON lines and terminates the process group', async () => {
    const child = new FakeChild(888);
    const harness = makeSpawn(child);
    const kills: Array<{ pid: number; signal: NodeJS.Signals | number | undefined }> = [];
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
      killProcess: (pid, signal) => {
        kills.push({ pid, signal });
        return true;
      },
      killGraceMs: 50,
      sigkillWaitMs: 50,
    });
    await tick();
    child.stdout.emitData('{broken}\n');
    child.close(null, 'SIGTERM');
    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof FusionChildRunError);
      assert.equal(error.code, 'child_event_invalid');
      return true;
    });
    assert.deepEqual(kills[0], { pid: -888, signal: 'SIGTERM' });
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

  void it('rejects non-stop final reasons, model mismatch, and missing newline', () => {
    const parser = new FusionPiJsonEventParser('p', 'm');
    parser.push(
      Buffer.from(
        '{"type":"session","id":"s","cwd":"/tmp"}\n{"type":"message_end","message":{"role":"assistant","provider":"p","model":"m","content":[{"type":"text","text":"x"}],"stopReason":"toolUse"}}\n',
      ),
    );
    assert.throws(() => parser.finish(), /not stop/);

    const mismatch = new FusionPiJsonEventParser('p', 'm');
    assert.throws(() => mismatch.push(Buffer.from(piEvents('p', 'other'))), /model mismatch/);

    const noNewline = new FusionPiJsonEventParser('p', 'm');
    noNewline.push(Buffer.from('{"type":"session","id":"s","cwd":"/tmp"}'));
    assert.throws(() => noNewline.finish(), /newline-terminated/);
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
      killGraceMs: 20,
      sigkillWaitMs: 20,
    });
    await tick();
    child.stdout.emitData('{broken}\n');
    child.close(null, 'SIGTERM');
    await assert.rejects(run, (error: unknown) => {
      assert.ok(error instanceof FusionChildRunError);
      assert.equal(error.code, 'child_event_invalid');
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
    child.stdout.emitData(piEvents());
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
      assert.equal(error.stdout.toString('utf8'), 'abcde');
      return true;
    });
    assert.deepEqual(child.killCalls, ['SIGTERM']);
  });
});

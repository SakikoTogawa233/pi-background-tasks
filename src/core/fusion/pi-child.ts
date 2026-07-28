import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import type { ResolvedFusionModel } from './types.js';
import {
  FusionError,
  type FusionChildRunResult,
  type FusionErrorDetails,
  type FusionStage,
  type FusionUsage,
} from './types.js';
import { isJsonObject, parseJsonText } from '../common.js';

export const FUSION_CHILD_STDOUT_LIMIT_BYTES = 32 * 1024 * 1024;
export const FUSION_CHILD_STDERR_LIMIT_BYTES = 4 * 1024 * 1024;
export const FUSION_CHILD_TIMEOUT_MS = 30 * 60 * 1000;
export const FUSION_CHILD_KILL_GRACE_MS = 3000;
export const FUSION_CHILD_SIGKILL_WAIT_MS = 5000;

export const FUSION_CHILD_REMOVED_ENV_KEYS = [
  'PI_SESSION_ID',
  'PI_SESSION_FILE',
  'PI_PROVIDER',
  'PI_MODEL',
  'PI_REASONING_LEVEL',
] as const;

interface FusionReadableStream {
  on(event: 'data', listener: (data: Buffer | string) => void): unknown;
  off(event: 'data', listener: (data: Buffer | string) => void): unknown;
}

interface FusionWritableStream {
  write(data: Buffer, callback: (error?: Error | null) => void): boolean;
  end(callback?: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
}

export interface FusionChildProcess {
  pid?: number | undefined;
  stdin?: FusionWritableStream | null | undefined;
  stdout?: FusionReadableStream | null | undefined;
  stderr?: FusionReadableStream | null | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
  off(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

export type FusionChildSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => FusionChildProcess;

export type FusionKillProcess = (pid: number, signal?: NodeJS.Signals | number) => boolean;

export interface RunPiChildOptions {
  stage: FusionStage;
  slot?: 1 | 2 | 3;
  attempt: number;
  cwd: string;
  model: ResolvedFusionModel;
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal | undefined;
  spawn?: FusionChildSpawn | undefined;
  killProcess?: FusionKillProcess | undefined;
  platform?: NodeJS.Platform | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  stdoutLimitBytes?: number | undefined;
  stderrLimitBytes?: number | undefined;
  timeoutMs?: number | undefined;
  killGraceMs?: number | undefined;
  sigkillWaitMs?: number | undefined;
}

interface CloseRecord {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface ProcessState {
  primaryError: FusionError | undefined;
  terminationStarted: boolean;
  termTimer: NodeJS.Timeout | undefined;
  waitTimer: NodeJS.Timeout | undefined;
  timeoutTimer: NodeJS.Timeout | undefined;
  settled: boolean;
}

export class FusionChildRunError extends FusionError {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly exitCode: number | null;
  readonly signalName: NodeJS.Signals | null;

  constructor(error: FusionError, stdout: Buffer, stderr: Buffer, close: CloseRecord) {
    const details: FusionErrorDetails = {
      code: error.code,
      transient: error.transient,
      childCreated: error.childCreated,
    };
    if (error.stage !== undefined) details.stage = error.stage;
    if (error.slot !== undefined) details.slot = error.slot;
    if (error.attempt !== undefined) details.attempt = error.attempt;
    if (error.artifactDir !== undefined) details.artifactDir = error.artifactDir;
    super(error.message, details);
    this.name = 'FusionChildRunError';
    this.stdout = stdout;
    this.stderr = stderr;
    this.exitCode = close.code;
    this.signalName = close.signal;
  }
}

export function fusionPiChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of FUSION_CHILD_REMOVED_ENV_KEYS) Reflect.deleteProperty(out, key);
  out['PI_SKIP_VERSION_CHECK'] = '1';
  return out;
}

export function buildFusionPiChildArgv(model: ResolvedFusionModel, systemPrompt: string): string[] {
  return [
    '--mode',
    'json',
    '--no-session',
    '--no-tools',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    '--provider',
    model.provider,
    '--model',
    model.model,
    '--thinking',
    model.thinkingLevel,
    '--system-prompt',
    systemPrompt,
  ];
}

function nonNegativeInteger(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

function readString(record: Record<PropertyKey, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readRecord(record: Record<PropertyKey, unknown>, key: string): Record<PropertyKey, unknown> | undefined {
  const value = record[key];
  return isJsonObject(value) && !Array.isArray(value) ? value : undefined;
}

function normalizeUsage(value: unknown): FusionUsage {
  const usage: FusionUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
  if (!isJsonObject(value) || Array.isArray(value)) return usage;
  usage.input = nonNegativeInteger(value['input']);
  usage.output = nonNegativeInteger(value['output']);
  usage.cacheRead = nonNegativeInteger(value['cacheRead']);
  usage.cacheWrite = nonNegativeInteger(value['cacheWrite']);
  usage.totalTokens = nonNegativeInteger(value['totalTokens']);
  if (usage.totalTokens <= 0) {
    usage.totalTokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  }
  const cost = readRecord(value, 'cost');
  const total = cost === undefined ? undefined : cost['total'];
  if (typeof total === 'number' && Number.isFinite(total) && total >= 0) usage.costTotal = total;
  return usage;
}

function addUsage(target: FusionUsage, delta: FusionUsage): void {
  target.input += delta.input;
  target.output += delta.output;
  target.cacheRead += delta.cacheRead;
  target.cacheWrite += delta.cacheWrite;
  target.totalTokens += delta.totalTokens;
  if (delta.costTotal !== undefined) target.costTotal = (target.costTotal ?? 0) + delta.costTotal;
}

function textBlocks(message: Record<PropertyKey, unknown>): string[] {
  const content = message['content'];
  if (!Array.isArray(content)) return [];
  const out: string[] = [];
  for (const part of content) {
    if (!isJsonObject(part) || Array.isArray(part)) continue;
    if (part['type'] === 'text' && typeof part['text'] === 'string') out.push(part['text']);
  }
  return out;
}

export class FusionPiJsonEventParser {
  private readonly decoder = new StringDecoder('utf8');
  private readonly expectedProvider: string;
  private readonly expectedModel: string;
  private lineBuffer = '';
  private bytesSeen = 0;
  private lastByteWasLf = false;
  private sessionCount = 0;
  private sessionId: string | undefined;
  private sessionCwd: string | undefined;
  private assistantCount = 0;
  private finalProvider: string | undefined;
  private finalModel: string | undefined;
  private finalStopReason: string | undefined;
  private finalText = '';
  private readonly usage: FusionUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };

  constructor(expectedProvider: string, expectedModel: string) {
    this.expectedProvider = expectedProvider;
    this.expectedModel = expectedModel;
  }

  push(chunk: Buffer): void {
    if (chunk.length === 0) return;
    this.bytesSeen += chunk.length;
    this.lastByteWasLf = chunk.at(-1) === 10;
    this.lineBuffer += this.decoder.write(chunk);
    this.consumeLines();
  }

  finish(): { text: string; usage: FusionUsage; provider: string; model: string; qualifiedId: string } {
    const rest = this.decoder.end();
    if (rest.length > 0) this.lineBuffer += rest;
    if (this.bytesSeen > 0 && !this.lastByteWasLf) throw new Error('Pi JSON event stream is not newline-terminated');
    if (this.lineBuffer.length > 0) throw new Error('Pi JSON event stream has an unterminated line');
    if (this.sessionCount !== 1 || this.sessionId === undefined || this.sessionCwd === undefined) {
      throw new Error('Pi JSON events must contain exactly one session header');
    }
    if (this.assistantCount < 1) throw new Error('Pi JSON events contain no assistant message');
    if (this.finalProvider !== this.expectedProvider || this.finalModel !== this.expectedModel) {
      throw new Error(
        `Pi final model mismatch: expected ${this.expectedProvider}/${this.expectedModel}, observed ${this.finalProvider ?? 'missing'}/${this.finalModel ?? 'missing'}`,
      );
    }
    if (this.finalStopReason !== 'stop') {
      throw new Error(`Pi final stop reason is not stop: ${this.finalStopReason ?? 'missing'}`);
    }
    if (this.finalText.trim().length === 0) throw new Error('Pi assistant response is empty');
    return {
      text: this.finalText,
      usage: { ...this.usage },
      provider: this.finalProvider,
      model: this.finalModel,
      qualifiedId: `${this.finalProvider}/${this.finalModel}`,
    };
  }

  private consumeLines(): void {
    let newlineIndex = this.lineBuffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const raw = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.consumeLine(raw.endsWith('\r') ? raw.slice(0, -1) : raw);
      newlineIndex = this.lineBuffer.indexOf('\n');
    }
  }

  private consumeLine(line: string): void {
    if (line.length === 0) throw new Error('Pi JSON event line is blank');
    let parsed: unknown;
    try {
      parsed = parseJsonText(line);
    } catch (error) {
      throw new Error(`Pi JSON event line is invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!isJsonObject(parsed) || Array.isArray(parsed)) throw new Error('Pi JSON event line is not an object');
    const eventType = parsed['type'];
    if (eventType === 'session') {
      this.consumeSession(parsed);
      return;
    }
    if (eventType === 'message_end') this.consumeMessageEnd(parsed);
  }

  private consumeSession(event: Record<PropertyKey, unknown>): void {
    this.sessionCount += 1;
    const id = readString(event, 'id');
    const cwd = readString(event, 'cwd');
    if (id === undefined || id.trim().length === 0) throw new Error('Pi session event lacks id');
    if (cwd === undefined || cwd.trim().length === 0) throw new Error('Pi session event lacks cwd');
    this.sessionId = id;
    this.sessionCwd = cwd;
  }

  private consumeMessageEnd(event: Record<PropertyKey, unknown>): void {
    const message = readRecord(event, 'message');
    if (message === undefined) throw new Error('Pi message_end event lacks message object');
    if (message['role'] !== 'assistant') return;
    const provider = readString(message, 'provider');
    const model = readString(message, 'model');
    if (provider === undefined || provider.trim().length === 0 || model === undefined || model.trim().length === 0) {
      throw new Error('Pi assistant message lacks provider/model');
    }
    if (provider !== this.expectedProvider || model !== this.expectedModel) {
      throw new Error(
        `Pi assistant model mismatch: expected ${this.expectedProvider}/${this.expectedModel}, observed ${provider}/${model}`,
      );
    }
    this.assistantCount += 1;
    this.finalProvider = provider;
    this.finalModel = model;
    const stopReason = readString(message, 'stopReason');
    this.finalStopReason = stopReason;
    this.finalText = textBlocks(message).join('');
    addUsage(this.usage, normalizeUsage(message['usage']));
  }
}

function appendCapped(
  chunks: Buffer[],
  currentBytes: number,
  chunk: Buffer,
  limit: number,
): { bytes: number; accepted: Buffer; exceeded: boolean } {
  if (currentBytes >= limit) return { bytes: currentBytes, accepted: Buffer.alloc(0), exceeded: true };
  const remaining = limit - currentBytes;
  if (chunk.length <= remaining) {
    chunks.push(chunk);
    return { bytes: currentBytes + chunk.length, accepted: chunk, exceeded: false };
  }
  const accepted = chunk.subarray(0, remaining);
  if (accepted.length > 0) chunks.push(accepted);
  return { bytes: limit, accepted, exceeded: true };
}

function codeOf(error: unknown): string | undefined {
  return isJsonObject(error) && typeof error['code'] === 'string' ? error['code'] : undefined;
}

function isTransientSpawnCode(code: string | undefined): boolean {
  return code === 'EAGAIN' || code === 'EMFILE' || code === 'ENFILE';
}

function childError(
  message: string,
  code: FusionError['code'],
  input: Pick<RunPiChildOptions, 'stage' | 'slot' | 'attempt'>,
  transient = false,
  childCreated = true,
): FusionError {
  const details: FusionErrorDetails = {
    code,
    stage: input.stage,
    attempt: input.attempt,
    transient,
    childCreated,
  };
  if (input.slot !== undefined) details.slot = input.slot;
  return new FusionError(message, details);
}

function defaultSpawn(command: string, args: string[], options: SpawnOptions): FusionChildProcess {
  return nodeSpawn(command, args, options);
}

function setUnref(timer: NodeJS.Timeout): NodeJS.Timeout {
  timer.unref();
  return timer;
}

function terminateChild(
  child: FusionChildProcess,
  state: ProcessState,
  platform: NodeJS.Platform,
  killProcess: FusionKillProcess,
  killGraceMs: number,
  sigkillWaitMs: number,
  settleSyntheticClose: (close: CloseRecord) => void,
): void {
  if (state.terminationStarted) return;
  state.terminationStarted = true;
  const termResult = sendSignal(child, platform, killProcess, 'SIGTERM');
  if (!termResult.sent && state.primaryError === undefined) {
    state.primaryError = new FusionError(`Pi child SIGTERM failed: ${termResult.errors.join('; ')}`, {
      code: 'child_exit_failed',
      childCreated: true,
    });
  }
  state.termTimer = setUnref(
    setTimeout(() => {
      const killResult = sendSignal(child, platform, killProcess, 'SIGKILL');
      if (!killResult.sent && state.primaryError === undefined) {
        state.primaryError = new FusionError(`Pi child SIGKILL failed: ${killResult.errors.join('; ')}`, {
          code: 'child_exit_failed',
          childCreated: true,
        });
      }
    }, killGraceMs),
  );
  state.waitTimer = setUnref(
    setTimeout(() => {
      if (state.settled) return;
      if (state.primaryError === undefined) {
        state.primaryError = new FusionError('Pi child did not close after SIGKILL wait', {
          code: 'child_exit_failed',
          childCreated: true,
        });
      }
      settleSyntheticClose({ code: null, signal: 'SIGKILL' });
    }, killGraceMs + sigkillWaitMs),
  );
}

function sendSignal(
  child: FusionChildProcess,
  platform: NodeJS.Platform,
  killProcess: FusionKillProcess,
  signal: NodeJS.Signals,
): { sent: boolean; errors: readonly string[] } {
  const errors: string[] = [];
  const pid = child.pid;
  if (platform !== 'win32' && pid !== undefined) {
    try {
      if (killProcess(-pid, signal)) return { sent: true, errors };
      errors.push('process group kill returned false');
    } catch (error) {
      errors.push(`process group kill failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  try {
    if (child.kill(signal)) return { sent: true, errors };
    errors.push('child kill returned false');
  } catch (error) {
    errors.push(`child kill failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { sent: false, errors };
}

function cleanupTimers(state: ProcessState): void {
  if (state.termTimer !== undefined) clearTimeout(state.termTimer);
  if (state.waitTimer !== undefined) clearTimeout(state.waitTimer);
  if (state.timeoutTimer !== undefined) clearTimeout(state.timeoutTimer);
  state.termTimer = undefined;
  state.waitTimer = undefined;
  state.timeoutTimer = undefined;
}

async function writePromptToStdin(child: FusionChildProcess, prompt: string): Promise<void> {
  const stdin = child.stdin;
  if (stdin === undefined || stdin === null) throw new Error('Pi child stdin pipe is unavailable');
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      stdin.off('error', fail);
      reject(error);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      stdin.off('error', fail);
      resolve();
    };
    stdin.once('error', fail);
    stdin.write(Buffer.from(prompt, 'utf8'), (error?: Error | null) => {
      if (error !== undefined && error !== null) {
        fail(error);
        return;
      }
      stdin.end(finish);
    });
  });
}

export async function runPiChild(options: RunPiChildOptions): Promise<FusionChildRunResult> {
  if (options.signal?.aborted) {
    throw childError('Pi child launch cancelled before spawn', 'child_cancelled', options, false, false);
  }
  const spawnImpl = options.spawn ?? defaultSpawn;
  const killProcess = options.killProcess ?? process.kill.bind(process);
  const platform = options.platform ?? process.platform;
  const env = fusionPiChildEnv(options.env ?? process.env);
  const stdoutLimit = options.stdoutLimitBytes ?? FUSION_CHILD_STDOUT_LIMIT_BYTES;
  const stderrLimit = options.stderrLimitBytes ?? FUSION_CHILD_STDERR_LIMIT_BYTES;
  const timeoutMs = options.timeoutMs ?? FUSION_CHILD_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? FUSION_CHILD_KILL_GRACE_MS;
  const sigkillWaitMs = options.sigkillWaitMs ?? FUSION_CHILD_SIGKILL_WAIT_MS;
  const argv = buildFusionPiChildArgv(options.model, options.systemPrompt);
  const parser = new FusionPiJsonEventParser(options.model.provider, options.model.model);
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const state: ProcessState = {
    primaryError: undefined,
    terminationStarted: false,
    termTimer: undefined,
    waitTimer: undefined,
    timeoutTimer: undefined,
    settled: false,
  };

  let child: FusionChildProcess;
  try {
    child = spawnImpl('pi', argv, {
      cwd: options.cwd,
      detached: platform !== 'win32',
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
      windowsHide: true,
    });
  } catch (error) {
    const code = codeOf(error);
    throw childError(
      `Pi child spawn failed: ${error instanceof Error ? error.message : String(error)}`,
      'child_spawn_failed',
      options,
      isTransientSpawnCode(code),
      false,
    );
  }

  let settleClose: (close: CloseRecord) => void = () => undefined;
  const closePromise = new Promise<CloseRecord>((resolve) => {
    settleClose = (close) => {
      if (state.settled) return;
      state.settled = true;
      resolve(close);
    };
  });

  const abortListener = () => {
    if (state.primaryError === undefined) {
      state.primaryError = childError('Pi child cancelled', 'child_cancelled', options);
    }
    terminateChild(child, state, platform, killProcess, killGraceMs, sigkillWaitMs, settleClose);
  };
  const stdoutListener = (data: Buffer | string) => {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const appended = appendCapped(stdoutChunks, stdoutBytes, chunk, stdoutLimit);
    stdoutBytes = appended.bytes;
    if (state.primaryError === undefined && appended.accepted.length > 0) {
      try {
        parser.push(appended.accepted);
      } catch (error) {
        state.primaryError = childError(
          `Pi child JSON event stream invalid: ${error instanceof Error ? error.message : String(error)}`,
          'child_event_invalid',
          options,
        );
        terminateChild(child, state, platform, killProcess, killGraceMs, sigkillWaitMs, settleClose);
      }
    }
    if (appended.exceeded && state.primaryError === undefined) {
      state.primaryError = childError(
        `Pi child stdout exceeded ${String(stdoutLimit)} bytes`,
        'child_output_cap',
        options,
      );
      terminateChild(child, state, platform, killProcess, killGraceMs, sigkillWaitMs, settleClose);
    }
  };
  const stderrListener = (data: Buffer | string) => {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const appended = appendCapped(stderrChunks, stderrBytes, chunk, stderrLimit);
    stderrBytes = appended.bytes;
    if (appended.exceeded && state.primaryError === undefined) {
      state.primaryError = childError(
        `Pi child stderr exceeded ${String(stderrLimit)} bytes`,
        'child_output_cap',
        options,
      );
      terminateChild(child, state, platform, killProcess, killGraceMs, sigkillWaitMs, settleClose);
    }
  };
  const errorListener = (error: Error) => {
    if (state.primaryError === undefined) {
      const code = codeOf(error);
      const childCreated = child.pid !== undefined;
      state.primaryError = childError(
        `Pi child process error: ${error.message}`,
        'child_spawn_failed',
        options,
        isTransientSpawnCode(code),
        childCreated,
      );
    }
    if (child.pid === undefined) settleClose({ code: null, signal: null });
  };
  const closeListener = (code: number | null, signal: NodeJS.Signals | null) => {
    settleClose({ code, signal });
  };

  child.stdout?.on('data', stdoutListener);
  child.stderr?.on('data', stderrListener);
  child.once('error', errorListener);
  child.once('close', closeListener);
  options.signal?.addEventListener('abort', abortListener, { once: true });
  state.timeoutTimer = setUnref(
    setTimeout(() => {
      if (state.primaryError === undefined) {
        state.primaryError = childError(`Pi child timed out after ${String(timeoutMs)}ms`, 'child_timeout', options);
      }
      terminateChild(child, state, platform, killProcess, killGraceMs, sigkillWaitMs, settleClose);
    }, timeoutMs),
  );

  try {
    try {
      await writePromptToStdin(child, options.userPrompt);
    } catch (error) {
      if (state.primaryError === undefined) {
        state.primaryError = childError(
          `Pi child stdin write failed: ${error instanceof Error ? error.message : String(error)}`,
          'child_stdin_failed',
          options,
        );
      }
      terminateChild(child, state, platform, killProcess, killGraceMs, sigkillWaitMs, settleClose);
    }

    const close = await closePromise;
    const stdout = Buffer.concat(stdoutChunks);
    const stderr = Buffer.concat(stderrChunks);
    const primary = state.primaryError;
    if (primary !== undefined) throw new FusionChildRunError(primary, stdout, stderr, close);
    if (close.code !== 0 || close.signal !== null) {
      throw new FusionChildRunError(
        childError(
          `Pi child exited with code ${close.code === null ? 'null' : String(close.code)}${close.signal === null ? '' : ` (${close.signal})`}`,
          'child_exit_failed',
          options,
        ),
        stdout,
        stderr,
        close,
      );
    }
    let parsed: ReturnType<FusionPiJsonEventParser['finish']>;
    try {
      parsed = parser.finish();
    } catch (error) {
      throw new FusionChildRunError(
        childError(
          `Pi child JSON event stream invalid: ${error instanceof Error ? error.message : String(error)}`,
          'child_event_invalid',
          options,
        ),
        stdout,
        stderr,
        close,
      );
    }
    const result: FusionChildRunResult = {
      stage: options.stage,
      attempt: options.attempt,
      provider: parsed.provider,
      model: parsed.model,
      qualifiedId: parsed.qualifiedId,
      text: parsed.text,
      usage: parsed.usage,
      stdout,
      stderr,
      exitCode: close.code,
      signal: close.signal,
    };
    if (options.slot !== undefined) result.slot = options.slot;
    return result;
  } finally {
    cleanupTimers(state);
    options.signal?.removeEventListener('abort', abortListener);
    child.stdout?.off('data', stdoutListener);
    child.stderr?.off('data', stderrListener);
    child.off('error', errorListener);
    child.off('close', closeListener);
  }
}

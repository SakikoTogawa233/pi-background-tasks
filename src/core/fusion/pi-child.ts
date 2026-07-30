import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FUSION_CHILD_RESULT_PREFIX,
  FUSION_CHILD_RESULT_SCHEMA_VERSION,
  type FusionChildResultMetadata,
} from '../../fusion-child-extension.js';
import {
  FusionError,
  addFusionUsage,
  cloneFusionUsage,
  createEmptyFusionUsage,
  type FusionChildRunResult,
  type FusionErrorDetails,
  type FusionStage,
  type FusionUsage,
  type ResolvedFusionModel,
} from './types.js';
import { isJsonObject, parseJsonText } from '../common.js';
import {
  assertWindowsCommandLineWithinLimit,
  piLaunchArgv,
  resolvePiLaunch,
  type PiLaunchDependencies,
} from '../pi-launch.js';

// The response cap now applies to one final full answer, not cumulative Pi JSON events.
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
  once(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  off(event: 'error', listener: (error: Error) => void): unknown;
  off(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
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
  childExtensionPath?: string | undefined;
  stderrLimitBytes?: number | undefined;
  timeoutMs?: number | undefined;
  killGraceMs?: number | undefined;
  sigkillWaitMs?: number | undefined;
  piLaunchDependencies?: PiLaunchDependencies | undefined;
}

interface CloseRecord {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface ProcessState {
  primaryError: FusionError | undefined;
  cleanupErrors: string[];
  terminationStarted: boolean;
  termTimer: NodeJS.Timeout | undefined;
  waitTimer: NodeJS.Timeout | undefined;
  timeoutTimer: NodeJS.Timeout | undefined;
  settled: boolean;
}

interface ObservedChildSnapshot {
  usage: FusionUsage;
  provider?: string;
  model?: string;
  qualifiedId?: string;
}

export class FusionChildRunError extends FusionError {
  readonly events: Buffer;
  readonly response: Buffer;
  readonly stderr: Buffer;
  readonly exitCode: number | null;
  readonly signalName: NodeJS.Signals | null;
  readonly usage: FusionUsage;
  readonly provider: string | undefined;
  readonly modelName: string | undefined;
  readonly qualifiedId: string | undefined;

  constructor(
    error: FusionError,
    events: Buffer,
    response: Buffer,
    stderr: Buffer,
    close: CloseRecord,
    observed: ObservedChildSnapshot,
  ) {
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
    this.events = events;
    this.response = response;
    this.stderr = stderr;
    this.exitCode = close.code;
    this.signalName = close.signal;
    this.usage = cloneFusionUsage(observed.usage);
    this.provider = observed.provider;
    this.modelName = observed.model;
    this.qualifiedId = observed.qualifiedId;
  }
}

export function fusionPiChildEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const key of FUSION_CHILD_REMOVED_ENV_KEYS) Reflect.deleteProperty(out, key);
  out['PI_SKIP_VERSION_CHECK'] = '1';
  return out;
}

export function resolveFusionChildExtensionPath(
  moduleUrl = import.meta.url,
  pathExists: (path: string) => boolean = existsSync,
): string {
  const modulePath = fileURLToPath(moduleUrl);
  const extension = modulePath.endsWith('.ts') ? 'fusion-child.ts' : 'fusion-child.js';
  const candidate = resolve(dirname(modulePath), '../../../extensions', extension);
  if (!pathExists(candidate)) {
    throw new Error(`Fusion child metadata extension is missing: ${candidate}`);
  }
  return candidate;
}

export function buildFusionPiChildArgv(
  model: ResolvedFusionModel,
  systemPrompt: string,
  childExtensionPath = resolveFusionChildExtensionPath(),
): string[] {
  return [
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
    childExtensionPath,
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

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const FUSION_CHILD_RESULT_PREFIX_BYTES = Buffer.from(FUSION_CHILD_RESULT_PREFIX, 'utf8');

interface ParsedFusionChildStderr {
  records: FusionChildResultMetadata[];
  events: Buffer;
  diagnostics: Buffer;
}

function assertClosedRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<PropertyKey, unknown> {
  if (!isJsonObject(value) || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} keys mismatch: expected ${expected.join(', ')}`);
  }
  return value;
}

function requireNonBlankString(
  record: Record<PropertyKey, unknown>,
  key: string,
  label: string,
): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0)
    throw new Error(`${label}.${key} must be a non-blank string`);
  return value;
}

function requireSha256(record: Record<PropertyKey, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !SHA256_HEX_PATTERN.test(value))
    throw new Error(`${label}.${key} must be a lowercase SHA-256 hex digest`);
  return value;
}

function requireUsageInteger(
  record: Record<PropertyKey, unknown>,
  key: string,
  label: string,
): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error(`${label}.${key} must be a non-negative safe integer`);
  return value;
}

function requireCostNumber(
  record: Record<PropertyKey, unknown>,
  key: string,
  label: string,
): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error(`${label}.${key} must be a non-negative finite number`);
  return value;
}

function parseCompactUsage(value: unknown): FusionUsage {
  const record = assertClosedRecord(
    value,
    ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'cost'],
    'fusion child usage',
  );
  const cost = assertClosedRecord(
    record['cost'],
    ['input', 'output', 'cacheRead', 'cacheWrite', 'total'],
    'fusion child usage.cost',
  );
  return {
    input: requireUsageInteger(record, 'input', 'fusion child usage'),
    output: requireUsageInteger(record, 'output', 'fusion child usage'),
    cacheRead: requireUsageInteger(record, 'cacheRead', 'fusion child usage'),
    cacheWrite: requireUsageInteger(record, 'cacheWrite', 'fusion child usage'),
    totalTokens: requireUsageInteger(record, 'totalTokens', 'fusion child usage'),
    cost: {
      input: requireCostNumber(cost, 'input', 'fusion child usage.cost'),
      output: requireCostNumber(cost, 'output', 'fusion child usage.cost'),
      cacheRead: requireCostNumber(cost, 'cacheRead', 'fusion child usage.cost'),
      cacheWrite: requireCostNumber(cost, 'cacheWrite', 'fusion child usage.cost'),
      total: requireCostNumber(cost, 'total', 'fusion child usage.cost'),
    },
  };
}

function parseChildResultMetadata(value: unknown): FusionChildResultMetadata {
  const record = assertClosedRecord(
    value,
    ['schema_version', 'provider', 'model', 'stop_reason', 'text_blocks', 'text_sha256', 'usage'],
    'fusion child result',
  );
  if (record['schema_version'] !== FUSION_CHILD_RESULT_SCHEMA_VERSION)
    throw new Error('fusion child result schema_version mismatch');
  const textBlocksValue = record['text_blocks'];
  if (!Array.isArray(textBlocksValue))
    throw new Error('fusion child result.text_blocks must be an array');
  const textBlocks = textBlocksValue.map((value, index) => {
    const label = `fusion child result.text_blocks[${String(index)}]`;
    const block = assertClosedRecord(value, ['utf8_bytes', 'sha256'], label);
    return {
      utf8_bytes: requireUsageInteger(block, 'utf8_bytes', label),
      sha256: requireSha256(block, 'sha256', label),
    };
  });
  const usage = parseCompactUsage(record['usage']);
  return {
    schema_version: FUSION_CHILD_RESULT_SCHEMA_VERSION,
    provider: requireNonBlankString(record, 'provider', 'fusion child result'),
    model: requireNonBlankString(record, 'model', 'fusion child result'),
    stop_reason: requireNonBlankString(record, 'stop_reason', 'fusion child result'),
    text_blocks: textBlocks,
    text_sha256: requireSha256(record, 'text_sha256', 'fusion child result'),
    usage,
  };
}

export function parseFusionChildStderr(stderr: Buffer): ParsedFusionChildStderr {
  const records: FusionChildResultMetadata[] = [];
  const diagnostics: Buffer[] = [];
  let cursor = 0;
  for (;;) {
    const frameStart = stderr.indexOf(FUSION_CHILD_RESULT_PREFIX_BYTES, cursor);
    if (frameStart < 0) {
      if (cursor < stderr.length) diagnostics.push(stderr.subarray(cursor));
      break;
    }
    if (frameStart > cursor) diagnostics.push(stderr.subarray(cursor, frameStart));
    const payloadStart = frameStart + FUSION_CHILD_RESULT_PREFIX_BYTES.length;
    const newline = stderr.indexOf(10, payloadStart);
    if (newline < 0) throw new Error('fusion child metadata frame is not newline-terminated');
    const payloadBytes = stderr.subarray(payloadStart, newline);
    const payloadText = payloadBytes.toString('utf8');
    if (!Buffer.from(payloadText, 'utf8').equals(payloadBytes))
      throw new Error('fusion child metadata frame is not valid UTF-8');
    let parsed: unknown;
    try {
      parsed = parseJsonText(payloadText);
    } catch (error) {
      throw new Error(
        `fusion child metadata frame is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    records.push(parseChildResultMetadata(parsed));
    cursor = newline + 1;
  }
  const events = Buffer.from(
    records.length === 0 ? '' : `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
  return { records, events, diagnostics: Buffer.concat(diagnostics) };
}

function sha256Buffer(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function reconstructFinalText(response: Buffer, record: FusionChildResultMetadata): string {
  const blocks: Buffer[] = [];
  let cursor = 0;
  for (const [index, block] of record.text_blocks.entries()) {
    const end = cursor + block.utf8_bytes;
    if (end > response.length)
      throw new Error(`Pi final text block ${String(index)} is shorter than its metadata length`);
    const bytes = response.subarray(cursor, end);
    if (sha256Buffer(bytes) !== block.sha256)
      throw new Error(`Pi final text block ${String(index)} hash mismatch`);
    blocks.push(bytes);
    if (response.at(end) !== 10)
      throw new Error(`Pi final text block ${String(index)} lacks its print-mode newline`);
    cursor = end + 1;
  }
  if (cursor !== response.length)
    throw new Error('Pi final text stdout contains bytes outside declared text blocks');
  const joined = Buffer.concat(blocks);
  if (sha256Buffer(joined) !== record.text_sha256)
    throw new Error('Pi final text aggregate hash mismatch');
  const text = joined.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(joined))
    throw new Error('Pi final text is not valid UTF-8');
  if (text.trim().length === 0) throw new Error('Pi assistant response is empty');
  return text;
}

export class FusionPiCompactResultParser {
  private readonly expectedProvider: string;
  private readonly expectedModel: string;

  constructor(expectedProvider: string, expectedModel: string) {
    this.expectedProvider = expectedProvider;
    this.expectedModel = expectedModel;
  }

  snapshot(stderr: Buffer): ObservedChildSnapshot {
    try {
      const parsed = parseFusionChildStderr(stderr);
      return this.observedFromRecords(parsed.records);
    } catch {
      return { usage: createEmptyFusionUsage() };
    }
  }

  finish(
    response: Buffer,
    stderr: Buffer,
  ): {
    text: string;
    usage: FusionUsage;
    provider: string;
    model: string;
    qualifiedId: string;
    events: Buffer;
    diagnostics: Buffer;
  } {
    const parsed = parseFusionChildStderr(stderr);
    const final = parsed.records.at(-1);
    if (final === undefined) throw new Error('Pi child emitted no compact result metadata');
    for (const record of parsed.records) this.assertModel(record);
    if (final.stop_reason !== 'stop')
      throw new Error(`Pi final stop reason is not stop: ${final.stop_reason}`);
    const observed = this.observedFromRecords(parsed.records);
    return {
      text: reconstructFinalText(response, final),
      usage: observed.usage,
      provider: final.provider,
      model: final.model,
      qualifiedId: `${final.provider}/${final.model}`,
      events: parsed.events,
      diagnostics: parsed.diagnostics,
    };
  }

  private assertModel(record: FusionChildResultMetadata): void {
    if (record.provider !== this.expectedProvider || record.model !== this.expectedModel) {
      throw new Error(
        `Pi assistant model mismatch: expected ${this.expectedProvider}/${this.expectedModel}, observed ${record.provider}/${record.model}`,
      );
    }
  }

  private observedFromRecords(
    records: readonly FusionChildResultMetadata[],
  ): ObservedChildSnapshot {
    const usage = createEmptyFusionUsage();
    for (const record of records) addFusionUsage(usage, record.usage);
    const final = records.at(-1);
    if (final === undefined) return { usage };
    return {
      usage,
      provider: final.provider,
      model: final.model,
      qualifiedId: `${final.provider}/${final.model}`,
    };
  }
}

function appendCapped(
  chunks: Buffer[],
  currentBytes: number,
  chunk: Buffer,
  limit: number,
): { bytes: number; accepted: Buffer; exceeded: boolean } {
  if (currentBytes >= limit)
    return { bytes: currentBytes, accepted: Buffer.alloc(0), exceeded: true };
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

function withCleanupErrors(error: FusionError, cleanupErrors: readonly string[]): FusionError {
  if (cleanupErrors.length === 0) return error;
  const details: FusionErrorDetails = {
    code: error.code,
    transient: error.transient,
    childCreated: error.childCreated,
  };
  if (error.stage !== undefined) details.stage = error.stage;
  if (error.slot !== undefined) details.slot = error.slot;
  if (error.attempt !== undefined) details.attempt = error.attempt;
  if (error.artifactDir !== undefined) details.artifactDir = error.artifactDir;
  return new FusionError(
    `${error.message}; process cleanup issues: ${cleanupErrors.join('; ')}`,
    details,
  );
}

function defaultSpawn(command: string, args: string[], options: SpawnOptions): FusionChildProcess {
  return nodeSpawn(command, args, options);
}

/**
 * Termination timers must keep the event loop alive.
 *
 * The SIGTERM grace, SIGKILL wait, and overall timeout timers are the only
 * things that settle the run promise when a child stops emitting events. An
 * unref'd timer lets the loop drain first, leaving the promise pending forever
 * ("Promise resolution is still pending but the event loop has already
 * resolved"). Every timer stored here is cleared in the `finally` of
 * `runPiChild` via `cleanupTimers`, so keeping them referenced cannot leak.
 */
function trackTimer(timer: NodeJS.Timeout): NodeJS.Timeout {
  return timer;
}

function rememberCleanupErrors(
  state: ProcessState,
  signal: NodeJS.Signals,
  errors: readonly string[],
): void {
  for (const error of errors) state.cleanupErrors.push(`${signal}: ${error}`);
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
  if (state.settled || state.terminationStarted) return;
  state.terminationStarted = true;
  const termResult = sendSignal(child, platform, killProcess, 'SIGTERM');
  rememberCleanupErrors(state, 'SIGTERM', termResult.errors);
  if (!termResult.sent && state.primaryError === undefined) {
    state.primaryError = new FusionError(
      `Pi child SIGTERM failed: ${termResult.errors.join('; ')}`,
      {
        code: 'child_exit_failed',
        childCreated: true,
      },
    );
  }
  state.termTimer = trackTimer(
    setTimeout(() => {
      if (state.settled) return;
      const killResult = sendSignal(child, platform, killProcess, 'SIGKILL');
      rememberCleanupErrors(state, 'SIGKILL', killResult.errors);
      if (!killResult.sent && state.primaryError === undefined) {
        state.primaryError = new FusionError(
          `Pi child SIGKILL failed: ${killResult.errors.join('; ')}`,
          {
            code: 'child_exit_failed',
            childCreated: true,
          },
        );
      }
    }, killGraceMs),
  );
  state.waitTimer = trackTimer(
    setTimeout(() => {
      if (state.settled) return;
      const message = 'Pi child did not emit close after SIGKILL wait';
      state.cleanupErrors.push(message);
      if (state.primaryError === undefined) {
        state.primaryError = new FusionError(message, {
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
      errors.push(
        `process group kill failed: ${error instanceof Error ? error.message : String(error)}`,
      );
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
    throw childError(
      'Pi child launch cancelled before spawn',
      'child_cancelled',
      options,
      false,
      false,
    );
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
  const argv = buildFusionPiChildArgv(
    options.model,
    options.systemPrompt,
    options.childExtensionPath ?? resolveFusionChildExtensionPath(),
  );
  const parser = new FusionPiCompactResultParser(options.model.provider, options.model.model);
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  const state: ProcessState = {
    primaryError: undefined,
    cleanupErrors: [],
    terminationStarted: false,
    termTimer: undefined,
    waitTimer: undefined,
    timeoutTimer: undefined,
    settled: false,
  };

  let child: FusionChildProcess;
  try {
    const launchDeps =
      options.piLaunchDependencies === undefined
        ? { platform }
        : { ...options.piLaunchDependencies, platform };
    const launch = resolvePiLaunch(launchDeps);
    assertWindowsCommandLineWithinLimit(launch, argv, platform, `fusion-${options.stage}`);
    child = spawnImpl(launch.executable, piLaunchArgv(launch, argv), {
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
    if (state.settled) return;
    if (state.primaryError === undefined) {
      state.primaryError = childError('Pi child cancelled', 'child_cancelled', options);
    }
    terminateChild(child, state, platform, killProcess, killGraceMs, sigkillWaitMs, settleClose);
  };
  const stdoutListener = (data: Buffer | string) => {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const appended = appendCapped(stdoutChunks, stdoutBytes, chunk, stdoutLimit);
    stdoutBytes = appended.bytes;
    if (appended.exceeded && state.primaryError === undefined) {
      state.primaryError = childError(
        `Pi child final response exceeded ${String(stdoutLimit)} bytes`,
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
    if (state.settled) return;
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
  if (options.signal?.aborted) abortListener();
  state.timeoutTimer = trackTimer(
    setTimeout(() => {
      if (state.primaryError === undefined) {
        state.primaryError = childError(
          `Pi child timed out after ${String(timeoutMs)}ms`,
          'child_timeout',
          options,
        );
      }
      terminateChild(child, state, platform, killProcess, killGraceMs, sigkillWaitMs, settleClose);
    }, timeoutMs),
  );

  try {
    try {
      if (state.primaryError === undefined) await writePromptToStdin(child, options.userPrompt);
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
    const response = Buffer.concat(stdoutChunks);
    const rawStderr = Buffer.concat(stderrChunks);
    const observed = parser.snapshot(rawStderr);
    let compactEvents: Buffer = Buffer.alloc(0);
    let diagnostics: Buffer = rawStderr;
    try {
      const decoded = parseFusionChildStderr(rawStderr);
      compactEvents = decoded.events;
      diagnostics = decoded.diagnostics;
    } catch {
      // A primary process/cap error remains authoritative; malformed metadata is
      // surfaced below when the child otherwise exits successfully.
    }
    const primary = state.primaryError;
    if (primary !== undefined)
      throw new FusionChildRunError(
        withCleanupErrors(primary, state.cleanupErrors),
        compactEvents,
        response,
        diagnostics,
        close,
        observed,
      );
    if (close.code !== 0 || close.signal !== null) {
      throw new FusionChildRunError(
        withCleanupErrors(
          childError(
            `Pi child exited with code ${close.code === null ? 'null' : String(close.code)}${close.signal === null ? '' : ` (${close.signal})`}`,
            'child_exit_failed',
            options,
          ),
          state.cleanupErrors,
        ),
        compactEvents,
        response,
        diagnostics,
        close,
        observed,
      );
    }
    let parsed: ReturnType<FusionPiCompactResultParser['finish']>;
    try {
      parsed = parser.finish(response, rawStderr);
    } catch (error) {
      throw new FusionChildRunError(
        withCleanupErrors(
          childError(
            `Pi child compact result invalid: ${error instanceof Error ? error.message : String(error)}`,
            'child_event_invalid',
            options,
          ),
          state.cleanupErrors,
        ),
        compactEvents,
        response,
        diagnostics,
        close,
        observed,
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
      events: parsed.events,
      stderr: parsed.diagnostics,
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

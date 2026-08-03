import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants, existsSync, readFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FUSION_CHILD_RESULT_PREFIX,
  FUSION_CHILD_RESULT_SCHEMA_VERSION,
  FUSION_RESEARCH_ENABLED_ENV,
  FUSION_SOURCE_POLICY_PATH_ENV,
  FUSION_SOURCE_POLICY_SHA256_ENV,
  FUSION_TOOL_CALL_LOG_PATH_ENV,
  FUSION_TOOL_CALL_SEAL_SCHEMA_VERSION,
  FUSION_TOOL_CALL_SEAL_SUFFIX,
  FUSION_CHILD_MAX_TOTAL_TOOL_RESULT_BYTES,
  type FusionChildResultMetadata,
} from './child-protocol.js';
import {
  FUSION_FORBIDDEN_TOOLS,
  FUSION_NO_TOOLS_CAPABILITY,
  FUSION_INSPECT_TOOLS,
  FUSION_RESEARCH_TOOLS,
  FUSION_TOOL_CALL_LOG_SCHEMA_VERSION,
  FUSION_WEB_FETCH_TOOL_NAME,
  FusionError,
  addFusionUsage,
  cloneFusionUsage,
  createEmptyFusionUsage,
  type FusionCapability,
  type FusionChildRunResult,
  type FusionErrorDetails,
  type FusionStage,
  type FusionToolCallLogRecord,
  type FusionToolCallTrace,
  type FusionUsage,
  type ResolvedFusionModel,
} from './types.js';
import { isJsonObject, parseJsonText } from '../common.js';
import { canonicalizeFusionPublicUrl, readFusionSourcePolicyFile } from './source-policy.js';
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
/**
 * Stale-action watchdog threshold.
 *
 * Activity is one stdout or stderr byte from the child. The child extension emits its
 * compact metadata frame only at `message_end`, and Pi text mode writes stdout only for
 * the final assistant message, so a single slow model turn is genuinely silent on both
 * streams. The threshold must therefore exceed the longest plausible single turn, not the
 * longest plausible tool call: a value tuned to tool latency would kill healthy children
 * mid-reasoning. 1200s stays inside the 30-minute absolute cap while leaving a wide
 * margin over observed turn latency.
 */
export const FUSION_CHILD_IDLE_TIMEOUT_MS = 20 * 60 * 1000;
export const FUSION_CHILD_KILL_GRACE_MS = 3000;
export const FUSION_CHILD_SIGKILL_WAIT_MS = 5000;
const FUSION_PI_CHILD_O_NOFOLLOW = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;

export const FUSION_CHILD_REMOVED_ENV_KEYS = [
  'PI_SESSION_ID',
  'PI_SESSION_FILE',
  'PI_PROVIDER',
  'PI_MODEL',
  'PI_REASONING_LEVEL',
  'OPENROUTER_API_KEY',
  'OPENROUTER_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_BASE_URL',
  'AZURE_OPENAI_ENDPOINT',
  'AZURE_OPENAI_RESOURCE_NAME',
  'AZURE_OPENAI_API_VERSION',
  'AZURE_OPENAI_DEPLOYMENT_NAME_MAP',
  'AZURE_OPENAI_AD_TOKEN',
  'PI_API_KEY',
  'PI_API_BASE_URL',
  'PI_AUTH_FILE',
  FUSION_TOOL_CALL_LOG_PATH_ENV,
  FUSION_RESEARCH_ENABLED_ENV,
  FUSION_SOURCE_POLICY_PATH_ENV,
  FUSION_SOURCE_POLICY_SHA256_ENV,
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
  capability?: FusionCapability | undefined;
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
  idleTimeoutMs?: number | undefined;
  killGraceMs?: number | undefined;
  sigkillWaitMs?: number | undefined;
  piLaunchDependencies?: PiLaunchDependencies | undefined;
  toolCallLogPath?: string | undefined;
  sourcePolicy?: { path: string; sha256: string } | undefined;
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
  idleTimer: NodeJS.Timeout | undefined;
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
  const removed = new Set<string>(FUSION_CHILD_REMOVED_ENV_KEYS);
  for (const inheritedKey of Object.keys(out)) {
    if (removed.has(inheritedKey.toUpperCase())) Reflect.deleteProperty(out, inheritedKey);
  }
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

/**
 * Provider whose children require the Anthropic system-prompt sanitizer.
 *
 * Pi's own system prompt contains documentation lines that Anthropic rejects, so a
 * Claude child launched without the sanitizer fails at the provider rather than
 * producing an answer. The parent session loads the sanitizer through ordinary
 * extension discovery, but Fusion children run with `--no-extensions` for
 * isolation and therefore inherit nothing; the sanitizer must be re-supplied
 * explicitly per child.
 */
export const FUSION_SANITIZED_PROVIDER = 'anthropic';
export const FUSION_ANTHROPIC_SANITIZER_PACKAGE = '@ravshansbox/pi-anthropic-sps';
const FUSION_ANTHROPIC_SANITIZER_MANIFEST = `${FUSION_ANTHROPIC_SANITIZER_PACKAGE}/package.json`;

export interface FusionSanitizerDependencies {
  resolvePackageJson?: ((specifier: string) => string) | undefined;
  readManifest?: ((path: string) => string) | undefined;
  pathExists?: ((path: string) => boolean) | undefined;
}

function manifestExtensionEntry(manifestText: string, manifestPath: string): string {
  let parsed: unknown;
  try {
    parsed = parseJsonText(manifestText);
  } catch (error) {
    throw new FusionError(
      `Anthropic sanitizer manifest ${manifestPath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { code: 'orchestration_failed', childCreated: false },
    );
  }
  if (!isJsonObject(parsed)) {
    throw new FusionError(`Anthropic sanitizer manifest ${manifestPath} must be an object`, {
      code: 'orchestration_failed',
      childCreated: false,
    });
  }
  const pi = parsed['pi'];
  if (!isJsonObject(pi)) {
    throw new FusionError(
      `Anthropic sanitizer manifest ${manifestPath} has no "pi" section declaring its extension`,
      { code: 'orchestration_failed', childCreated: false },
    );
  }
  const extensions = pi['extensions'];
  if (!Array.isArray(extensions) || extensions.length === 0) {
    throw new FusionError(
      `Anthropic sanitizer manifest ${manifestPath} declares no pi.extensions entries`,
      { code: 'orchestration_failed', childCreated: false },
    );
  }
  const [entry] = extensions;
  if (typeof entry !== 'string' || entry.trim().length === 0) {
    throw new FusionError(
      `Anthropic sanitizer manifest ${manifestPath} pi.extensions[0] must be a non-blank string`,
      { code: 'orchestration_failed', childCreated: false },
    );
  }
  return entry;
}

/**
 * Resolve the sanitizer extension file shipped by the sanitizer package.
 *
 * The package intentionally publishes no `main`/`exports`, so the entry cannot be
 * required directly; its manifest is resolved and the declared `pi.extensions[0]`
 * path is joined against the package root. Every failure is loud: a Claude child
 * launched without the sanitizer would fail at the provider with a far less
 * actionable error, so silently omitting it is never correct.
 */
export function resolveAnthropicSanitizerExtensionPath(
  dependencies: FusionSanitizerDependencies = {},
): string {
  const resolvePackageJson =
    dependencies.resolvePackageJson ?? createRequire(import.meta.url).resolve;
  const readManifest = dependencies.readManifest ?? ((path: string) => readFileSync(path, 'utf8'));
  const pathExists = dependencies.pathExists ?? existsSync;
  let manifestPath: string;
  try {
    manifestPath = resolvePackageJson(FUSION_ANTHROPIC_SANITIZER_MANIFEST);
  } catch (error) {
    throw new FusionError(
      `Anthropic sanitizer package ${FUSION_ANTHROPIC_SANITIZER_PACKAGE} could not be resolved: ${error instanceof Error ? error.message : String(error)}. Claude children cannot be launched without it.`,
      { code: 'orchestration_failed', childCreated: false },
    );
  }
  let manifestText: string;
  try {
    manifestText = readManifest(manifestPath);
  } catch (error) {
    throw new FusionError(
      `Anthropic sanitizer manifest ${manifestPath} could not be read: ${error instanceof Error ? error.message : String(error)}`,
      { code: 'orchestration_failed', childCreated: false },
    );
  }
  const entry = manifestExtensionEntry(manifestText, manifestPath);
  const extensionPath = resolve(dirname(manifestPath), entry);
  if (!pathExists(extensionPath)) {
    throw new FusionError(
      `Anthropic sanitizer extension is missing: ${extensionPath} (declared by ${manifestPath})`,
      { code: 'orchestration_failed', childCreated: false },
    );
  }
  return extensionPath;
}

export function assertFusionToolPolicyDisjoint(
  allowlist: readonly string[] = FUSION_INSPECT_TOOLS,
  denylist: readonly string[] = FUSION_FORBIDDEN_TOOLS,
): void {
  for (const forbidden of denylist) {
    if (allowlist.includes(forbidden)) {
      throw new FusionError(
        `fusion inspect capability would enable the forbidden tool ${forbidden}`,
        { code: 'orchestration_failed', childCreated: false },
      );
    }
  }
}

function researchToolAllowlist(): readonly string[] {
  return FUSION_RESEARCH_TOOLS;
}

function fusionToolArgv(capability: FusionCapability): string[] {
  if (capability === 'reason') return ['--no-tools'];
  if (capability === 'inspect') {
    assertFusionToolPolicyDisjoint(FUSION_INSPECT_TOOLS);
    return [
      '--no-builtin-tools',
      '--tools',
      FUSION_INSPECT_TOOLS.join(','),
      '--exclude-tools',
      FUSION_FORBIDDEN_TOOLS.join(','),
    ];
  }
  if (capability === 'research') {
    const allowlist = researchToolAllowlist();
    assertFusionToolPolicyDisjoint(allowlist);
    return [
      '--no-builtin-tools',
      '--tools',
      allowlist.join(','),
      '--exclude-tools',
      FUSION_FORBIDDEN_TOOLS.join(','),
    ];
  }
  throw new FusionError(`fusion capability ${String(capability)} is not supported`, {
    code: 'orchestration_failed',
    childCreated: false,
  });
}

/**
 * Extensions explicitly loaded into a child, in deterministic order.
 *
 * `--no-extensions` disables discovery but still honours explicit `--extension`
 * paths, so this list is the complete set a child receives. The metadata
 * extension is always present; the Anthropic sanitizer is appended only for
 * Claude routes, keeping non-Anthropic child argv byte-identical to before.
 */
export function fusionChildExtensionPaths(
  model: ResolvedFusionModel,
  childExtensionPath: string,
  resolveSanitizer: () => string = resolveAnthropicSanitizerExtensionPath,
): readonly string[] {
  if (model.provider !== FUSION_SANITIZED_PROVIDER) return [childExtensionPath];
  return [childExtensionPath, resolveSanitizer()];
}

export function buildFusionPiChildArgv(
  model: ResolvedFusionModel,
  systemPrompt: string,
  childExtensionPath = resolveFusionChildExtensionPath(),
  capability: FusionCapability = FUSION_NO_TOOLS_CAPABILITY,
  resolveSanitizer: () => string = resolveAnthropicSanitizerExtensionPath,
): string[] {
  const extensionArgs = fusionChildExtensionPaths(
    model,
    childExtensionPath,
    resolveSanitizer,
  ).flatMap((path) => ['--extension', path]);
  return [
    '--mode',
    'text',
    '--no-session',
    ...fusionToolArgv(capability),
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-themes',
    '--no-context-files',
    ...extensionArgs,
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

function assertClosedRecordWithOptional(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  label: string,
): Record<PropertyKey, unknown> {
  if (!isJsonObject(value) || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const actual = Object.keys(value).sort();
  const missing = requiredKeys.filter((key) => !Object.hasOwn(value, key));
  const unknownKeys = actual.filter((key) => !allowed.has(key));
  if (missing.length > 0 || unknownKeys.length > 0) {
    throw new Error(
      `${label} keys mismatch: required ${[...requiredKeys].sort().join(', ')}; optional ${[
        ...optionalKeys,
      ]
        .sort()
        .join(', ')}`,
    );
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

function parseToolCallLogRecord(value: unknown, label: string): FusionToolCallLogRecord {
  const record = assertClosedRecordWithOptional(
    value,
    [
      'schema_version',
      'ordinal',
      'tool_name',
      'arguments_sha256',
      'arguments_bytes',
      'result_bytes',
      'result_sha256',
      'status',
      'duration_ms',
    ],
    ['url', 'rejected_url_sha256', 'final_url', 'http_status', 'response_bytes', 'content_sha256'],
    label,
  );
  if (record['schema_version'] !== FUSION_TOOL_CALL_LOG_SCHEMA_VERSION) {
    throw new Error(`${label}.schema_version mismatch`);
  }
  const status = record['status'];
  if (status !== 'ok' && status !== 'error') throw new Error(`${label}.status is invalid`);
  const parsedRecord: FusionToolCallLogRecord = {
    schema_version: FUSION_TOOL_CALL_LOG_SCHEMA_VERSION,
    ordinal: requireUsageInteger(record, 'ordinal', label),
    tool_name: requireNonBlankString(record, 'tool_name', label),
    arguments_sha256: requireSha256(record, 'arguments_sha256', label),
    arguments_bytes: requireUsageInteger(record, 'arguments_bytes', label),
    result_bytes: requireUsageInteger(record, 'result_bytes', label),
    result_sha256: requireSha256(record, 'result_sha256', label),
    status,
    duration_ms: requireUsageInteger(record, 'duration_ms', label),
  };
  if (record['url'] !== undefined) parsedRecord.url = requireNonBlankString(record, 'url', label);
  if (record['rejected_url_sha256'] !== undefined)
    parsedRecord.rejected_url_sha256 = requireSha256(record, 'rejected_url_sha256', label);
  if (record['final_url'] !== undefined)
    parsedRecord.final_url = requireNonBlankString(record, 'final_url', label);
  if (record['http_status'] !== undefined)
    parsedRecord.http_status = requireUsageInteger(record, 'http_status', label);
  if (record['response_bytes'] !== undefined)
    parsedRecord.response_bytes = requireUsageInteger(record, 'response_bytes', label);
  if (record['content_sha256'] !== undefined)
    parsedRecord.content_sha256 = requireSha256(record, 'content_sha256', label);
  return parsedRecord;
}

export function parseFusionToolCallLog(bytes: Buffer): FusionToolCallTrace {
  if (bytes.length === 0) {
    return {
      bytes,
      records: [],
      summary: { count: 0, total_result_bytes: 0, trace_complete: true },
    };
  }
  if (bytes.at(-1) !== 10) {
    throw new Error('fusion tool-call log has trailing partial line');
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new Error('fusion tool-call log is not valid UTF-8');
  }
  const lines = text.split('\n');
  lines.pop();
  const records = lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = parseJsonText(line);
    } catch (error) {
      throw new Error(
        `fusion tool-call log line ${String(index)} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return parseToolCallLogRecord(parsed, `fusion tool-call log line ${String(index)}`);
  });
  const seen = new Set<number>();
  for (const [index, record] of records.entries()) {
    if (seen.has(record.ordinal)) {
      throw new Error(`fusion tool-call log duplicate ordinal ${String(record.ordinal)}`);
    }
    seen.add(record.ordinal);
    if (record.ordinal !== index) {
      throw new Error(
        `fusion tool-call log ordinal gap: expected ${String(index)}, observed ${String(record.ordinal)}`,
      );
    }
  }
  return {
    bytes,
    records,
    summary: {
      count: records.length,
      total_result_bytes: records.reduce((sum, record) => sum + record.result_bytes, 0),
      trace_complete: true,
    },
  };
}


async function assertCompletedToolPolicy(
  trace: FusionToolCallTrace,
  capability: FusionCapability,
  sourcePolicy: { path: string; sha256: string } | undefined,
): Promise<void> {
  const allowed = capability === 'inspect' ? FUSION_INSPECT_TOOLS : capability === 'research' ? FUSION_RESEARCH_TOOLS : [];
  const allowedSet = new Set<string>(allowed);
  const declared =
    capability === 'research' && sourcePolicy !== undefined
      ? new Set((await readFusionSourcePolicyFile(sourcePolicy.path, sourcePolicy.sha256)).sources.map((source) => source.canonical_url))
      : undefined;
  for (const record of trace.records) {
    if (!allowedSet.has(record.tool_name)) {
      throw new Error(`fusion child used non-allowlisted tool ${record.tool_name}`);
    }
    if (capability === 'research' && record.tool_name === FUSION_WEB_FETCH_TOOL_NAME) {
      if (sourcePolicy === undefined || declared === undefined) throw new Error('fusion research source policy missing during audit');
      if (record.status === 'ok') {
        if (record.url === undefined) throw new Error('fusion research fetch audit is missing url');
        const canonicalUrl = canonicalizeFusionPublicUrl(record.url);
        if (record.url !== canonicalUrl) throw new Error('fusion research fetch audit URL was not canonical');
        if (!declared.has(canonicalUrl)) throw new Error('fusion research fetch audit URL was not declared');
        if (record.rejected_url_sha256 !== undefined) {
          throw new Error('fusion research successful fetch audit must not include rejected_url_sha256');
        }
        if (record.final_url === undefined) throw new Error('fusion research fetch audit is missing final_url');
        if (record.http_status === undefined) throw new Error('fusion research fetch audit is missing http_status');
        if (record.response_bytes === undefined) throw new Error('fusion research fetch audit is missing response_bytes');
        if (record.content_sha256 === undefined) throw new Error('fusion research fetch audit is missing content_sha256');
      } else {
        if (record.url !== undefined || record.final_url !== undefined) {
          throw new Error('fusion research rejected fetch audit must not persist raw URL');
        }
        if (record.rejected_url_sha256 === undefined) {
          throw new Error('fusion research rejected fetch audit is missing rejected_url_sha256');
        }
      }
    }
  }
}

function isNotFound(error: unknown): boolean {
  return isJsonObject(error) && error['code'] === 'ENOENT';
}

async function readFusionToolCallLog(path: string): Promise<FusionToolCallTrace> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | FUSION_PI_CHILD_O_NOFOLLOW);
  } catch (error) {
    // The child extension creates this file before tools can run, so a missing file
    // means the audit trail was never established - not that zero tools were used. Those
    // must stay distinguishable: silently accepting absence would let a run whose activity
    // was never recorded report success, defeating the purpose of the log.
    if (isNotFound(error)) {
      throw new Error(
        `fusion tool-call log is missing at ${path}; the inspect child never initialized its audit trail`,
      );
    }
    if (isJsonObject(error) && error['code'] === 'ELOOP') {
      throw new Error(
        `fusion tool-call log at ${path} is a symlink; refusing to trust a redirected audit trail`,
      );
    }
    throw error;
  }
  try {
    // The audit trail must be a real file inside the run directory. A symlink here would let
    // anything able to pre-create the path redirect the parent's read elsewhere, so the file
    // is opened with O_NOFOLLOW and then fstat-checked before its bytes are trusted.
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error(
        `fusion tool-call log at ${path} is not a regular file; refusing to trust a redirected audit trail`,
      );
    }
    return parseFusionToolCallLog(await handle.readFile());
  } finally {
    await handle.close();
  }
}

async function assertFusionToolCallLogSeal(
  path: string,
  trace: FusionToolCallTrace,
): Promise<void> {
  const sealPath = `${path}${FUSION_TOOL_CALL_SEAL_SUFFIX}`;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(sealPath, constants.O_RDONLY | FUSION_PI_CHILD_O_NOFOLLOW);
  } catch (error) {
    if (isNotFound(error)) throw new Error('fusion tool-call audit completion seal is missing');
    if (isJsonObject(error) && error['code'] === 'ELOOP') {
      throw new Error('fusion tool-call audit completion seal is a symlink');
    }
    throw error;
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error('fusion tool-call audit completion seal is not a regular file');
    if (stats.size > 4096) throw new Error('fusion tool-call audit completion seal is oversized');
    const bytes = await handle.readFile();
    if (bytes.at(-1) !== 10) throw new Error('fusion tool-call audit completion seal is partial');
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) {
      throw new Error('fusion tool-call audit completion seal is not UTF-8');
    }
    const parsed = parseJsonText(text);
    if (!isJsonObject(parsed) || Array.isArray(parsed)) {
      throw new Error('fusion tool-call audit completion seal must be an object');
    }
    const keys = Object.keys(parsed).sort();
    const expected = ['log_sha256', 'record_count', 'schema_version', 'status', 'total_result_bytes'];
    if (keys.join('\0') !== expected.join('\0')) {
      throw new Error('fusion tool-call audit completion seal keys mismatch');
    }
    if (parsed['schema_version'] !== FUSION_TOOL_CALL_SEAL_SCHEMA_VERSION) {
      throw new Error('fusion tool-call audit completion seal schema mismatch');
    }
    if (parsed['status'] !== 'complete') {
      throw new Error('fusion tool-call audit completion seal reports a failed audit');
    }
    const recordCount = requireUsageInteger(parsed, 'record_count', 'fusion tool-call audit seal');
    const totalResultBytes = requireUsageInteger(
      parsed,
      'total_result_bytes',
      'fusion tool-call audit seal',
    );
    const logSha256 = requireSha256(parsed, 'log_sha256', 'fusion tool-call audit seal');
    if (recordCount !== trace.summary.count) {
      throw new Error('fusion tool-call audit completion seal record count mismatch');
    }
    if (totalResultBytes !== trace.summary.total_result_bytes) {
      throw new Error('fusion tool-call audit completion seal result-byte total mismatch');
    }
    if (logSha256 !== sha256Buffer(trace.bytes)) {
      throw new Error('fusion tool-call audit completion seal log hash mismatch');
    }
    if (totalResultBytes > FUSION_CHILD_MAX_TOTAL_TOOL_RESULT_BYTES) {
      throw new Error(
        `fusion tool-call audit exceeds aggregate result-byte limit ${String(FUSION_CHILD_MAX_TOTAL_TOOL_RESULT_BYTES)}`,
      );
    }
  } finally {
    await handle.close();
  }
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
    this.assertTranscriptStopReasons(parsed.records);
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

  private assertTranscriptStopReasons(records: readonly FusionChildResultMetadata[]): void {
    for (const [index, record] of records.entries()) {
      const isFinal = index === records.length - 1;
      if (isFinal) {
        if (record.stop_reason !== 'stop') {
          throw new Error(this.stopReasonError('final', 'stop', record.stop_reason, true));
        }
      } else if (record.stop_reason !== 'toolUse') {
        throw new Error(
          this.stopReasonError(`non-final record ${index}`, 'toolUse', record.stop_reason, true),
        );
      }
    }
  }

  private stopReasonError(
    position: string,
    expected: string,
    observed: string,
    includeStopDetail: boolean,
  ): string {
    const prefix = `Pi ${position} stop reason is not ${expected}: ${observed}`;
    if (!includeStopDetail) return prefix;
    switch (observed) {
      case 'length':
        return `${prefix} (model output was truncated)`;
      case 'error':
        return `${prefix} (Pi reported an error stop)`;
      case 'aborted':
        return `${prefix} (Pi reported an aborted stop)`;
      case 'pending':
        return `${prefix} (Pi reported a pending stop)`;
      default:
        return prefix;
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
 * The SIGTERM grace, SIGKILL wait, overall timeout, and idle timeout timers
 * are the only things that settle the run promise when a child stops emitting events. An
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
  if (state.idleTimer !== undefined) clearTimeout(state.idleTimer);
  state.termTimer = undefined;
  state.waitTimer = undefined;
  state.timeoutTimer = undefined;
  state.idleTimer = undefined;
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
  const capability = options.capability ?? FUSION_NO_TOOLS_CAPABILITY;
  const env = fusionPiChildEnv(options.env ?? process.env);
  if (capability !== 'reason') {
    if (options.toolCallLogPath === undefined) {
      throw childError(
        `fusion ${capability} child requires a tool-call log path`,
        'orchestration_failed',
        options,
        false,
        false,
      );
    }
    env[FUSION_TOOL_CALL_LOG_PATH_ENV] = options.toolCallLogPath;
    if (capability === 'research') {
      if (options.sourcePolicy === undefined) {
        throw childError('fusion research child requires a source-policy path and hash', 'orchestration_failed', options, false, false);
      }
      env[FUSION_RESEARCH_ENABLED_ENV] = '1';
      env[FUSION_SOURCE_POLICY_PATH_ENV] = options.sourcePolicy.path;
      env[FUSION_SOURCE_POLICY_SHA256_ENV] = options.sourcePolicy.sha256;
    }
  }
  const stdoutLimit = options.stdoutLimitBytes ?? FUSION_CHILD_STDOUT_LIMIT_BYTES;
  const stderrLimit = options.stderrLimitBytes ?? FUSION_CHILD_STDERR_LIMIT_BYTES;
  const timeoutMs = options.timeoutMs ?? FUSION_CHILD_TIMEOUT_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? FUSION_CHILD_IDLE_TIMEOUT_MS;
  const killGraceMs = options.killGraceMs ?? FUSION_CHILD_KILL_GRACE_MS;
  const sigkillWaitMs = options.sigkillWaitMs ?? FUSION_CHILD_SIGKILL_WAIT_MS;
  const argv = buildFusionPiChildArgv(
    options.model,
    options.systemPrompt,
    options.childExtensionPath ?? resolveFusionChildExtensionPath(),
    capability,
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
    idleTimer: undefined,
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

  const resetIdleTimer = () => {
    if (state.settled) return;
    if (state.idleTimer !== undefined) clearTimeout(state.idleTimer);
    state.idleTimer = trackTimer(
      setTimeout(() => {
        if (state.settled) return;
        if (state.primaryError === undefined) {
          state.primaryError = childError(
            `Pi child produced no output for ${String(idleTimeoutMs)}ms (stalled)`,
            'child_timeout',
            options,
          );
        }
        terminateChild(child, state, platform, killProcess, killGraceMs, sigkillWaitMs, settleClose);
      }, idleTimeoutMs),
    );
  };
  const abortListener = () => {
    if (state.settled) return;
    if (state.primaryError === undefined) {
      state.primaryError = childError('Pi child cancelled', 'child_cancelled', options);
    }
    terminateChild(child, state, platform, killProcess, killGraceMs, sigkillWaitMs, settleClose);
  };
  const stdoutListener = (data: Buffer | string) => {
    resetIdleTimer();
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
    resetIdleTimer();
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
  resetIdleTimer();
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
    let toolCallTrace: FusionToolCallTrace | undefined;
    if (capability !== 'reason') {
      // The launch path above refuses to spawn a tool-enabled child without a log path, so
      // this is unreachable. Assert rather than defaulting: a `?? ''` here would silently
      // read an empty path if that guard were ever refactored away, turning a missing
      // audit trail into a successful run.
      const logPath = options.toolCallLogPath;
      if (logPath === undefined) {
        throw childError(
          `fusion ${capability} child completed without a tool-call log path`,
          'orchestration_failed',
          options,
        );
      }
      try {
        toolCallTrace = await readFusionToolCallLog(logPath);
        await assertFusionToolCallLogSeal(logPath, toolCallTrace);
        await assertCompletedToolPolicy(toolCallTrace, capability, options.sourcePolicy);
      } catch (error) {
        throw new FusionChildRunError(
          withCleanupErrors(
            childError(
              `Pi child tool-call log invalid: ${error instanceof Error ? error.message : String(error)}`,
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
    if (toolCallTrace !== undefined) result.toolCallTrace = toolCallTrace;
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

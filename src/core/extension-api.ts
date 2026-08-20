import { randomBytes } from 'node:crypto';
import type { EventBus } from '@earendil-works/pi-coding-agent';
import {
  DEFAULT_LOG_BYTES,
  normalizeMaxBytes,
  type BgLogsDetails,
  type BgTask,
  type BgTaskSnapshot,
  type ExternalTaskCapabilities,
  type JsonObject,
  type StartTaskOptions,
  type UpdateExternalTaskOptions,
} from './common.js';
import type { BackgroundTaskContext, BackgroundTaskRegistry } from './registry.js';

export const BG_REQUEST_CHANNEL = 'pi-background-tasks:request:v1';
export const BG_RESPONSE_CHANNEL = 'pi-background-tasks:response:v1';
export const BG_TERMINAL_CHANNEL = 'pi-background-tasks:terminal:v1';
export const BG_REQUEST_SCHEMA = 'pi-background-tasks.extension-request.v1';
export const BG_RESPONSE_SCHEMA = 'pi-background-tasks.extension-response.v1';
export const BG_TERMINAL_SCHEMA = 'pi-background-tasks.extension-terminal.v1';

export const BG_EXTERNAL_REQUEST_CHANNEL = 'pi-background-tasks:external-request:v2';
export const BG_EXTERNAL_RESPONSE_CHANNEL = 'pi-background-tasks:external-response:v2';
export const BG_EXTERNAL_CANCEL_CHANNEL = 'pi-background-tasks:external-cancel:v2';
export const BG_EXTERNAL_TERMINAL_CHANNEL = 'pi-background-tasks:external-terminal:v2';
export const BG_EXTERNAL_REQUEST_SCHEMA = 'pi-background-tasks.external-request.v2';
export const BG_EXTERNAL_RESPONSE_SCHEMA = 'pi-background-tasks.external-response.v2';
export const BG_EXTERNAL_CANCEL_SCHEMA = 'pi-background-tasks.external-cancel.v2';
export const BG_EXTERNAL_TERMINAL_SCHEMA = 'pi-background-tasks.external-terminal.v2';

const MAX_ERROR_CHARS = 240;
const MAX_REQUEST_ID_CHARS = 200;
const MAX_OWNER_ID_CHARS = 120;
const MAX_OWNER_REF_CHARS = 200;
const installedServices = new WeakMap<EventBus, BackgroundTaskExtensionService>();

export type BackgroundTaskExtensionOperation = 'capabilities' | 'run' | 'status' | 'logs' | 'kill';

export interface BackgroundTaskExtensionCapabilities {
  api_version: 1;
  run: boolean;
  run_is_agent: boolean;
  run_completion_trigger: boolean;
  status: boolean;
  logs: boolean;
  logs_bounded: boolean;
  kill: boolean;
}

export const BG_EXTENSION_CAPABILITIES: BackgroundTaskExtensionCapabilities = Object.freeze({
  api_version: 1,
  run: true,
  run_is_agent: true,
  run_completion_trigger: true,
  status: true,
  logs: true,
  logs_bounded: true,
  kill: true,
});

export interface BackgroundTaskExtensionRunPayload {
  name: string;
  command: string;
  isAgent: boolean;
  timeoutSeconds?: number | undefined;
  notifyOnCompletion: boolean;
  triggerOnCompletion: boolean;
}

export interface BackgroundTaskExtensionStatusPayload {
  taskId?: string | undefined;
}

export interface BackgroundTaskExtensionLogsPayload {
  taskId: string;
  maxBytes?: number | undefined;
  tail?: boolean | undefined;
}

export interface BackgroundTaskExtensionKillPayload {
  taskId: string;
}

export type BackgroundTaskExtensionPayload =
  | Record<PropertyKey, never>
  | BackgroundTaskExtensionRunPayload
  | BackgroundTaskExtensionStatusPayload
  | BackgroundTaskExtensionLogsPayload
  | BackgroundTaskExtensionKillPayload;

export interface BackgroundTaskExtensionRequest {
  schema_version: typeof BG_REQUEST_SCHEMA;
  request_id: string;
  operation: BackgroundTaskExtensionOperation;
  payload: BackgroundTaskExtensionPayload;
}

export type BackgroundTaskExtensionResult =
  | BackgroundTaskExtensionCapabilities
  | BgTaskSnapshot
  | { tasks: BgTaskSnapshot[] }
  | (BgLogsDetails & { text: string })
  | { task: BgTaskSnapshot; message: string };

export type BackgroundTaskExtensionResponse =
  | {
      schema_version: typeof BG_RESPONSE_SCHEMA;
      request_id: string;
      operation: string;
      ok: true;
      result: BackgroundTaskExtensionResult;
    }
  | {
      schema_version: typeof BG_RESPONSE_SCHEMA;
      request_id: string;
      operation: string;
      ok: false;
      error: string;
    };

export interface BackgroundTaskExtensionTerminal {
  schema_version: typeof BG_TERMINAL_SCHEMA;
  task: BgTaskSnapshot;
}

export type ExternalTaskOperation =
  | 'handshake'
  | 'register'
  | 'update'
  | 'log'
  | 'cancel_ack'
  | 'settle'
  | 'status'
  | 'logs'
  | 'kill';

export interface ExternalTaskServiceCapabilities {
  api_version: 2;
  register: true;
  update: true;
  log: true;
  cancel: true;
  cancel_ack: true;
  settle: true;
  status: true;
  logs: true;
  logs_bounded: true;
  kill: true;
  terminal_after_settle: true;
}

export const BG_EXTERNAL_CAPABILITIES: ExternalTaskServiceCapabilities = Object.freeze({
  api_version: 2,
  register: true,
  update: true,
  log: true,
  cancel: true,
  cancel_ack: true,
  settle: true,
  status: true,
  logs: true,
  logs_bounded: true,
  kill: true,
  terminal_after_settle: true,
});

export type ExternalTaskResult =
  | (ExternalTaskServiceCapabilities & {
      service_id: string;
      owner_id: string;
      owner_token: string;
    })
  | { task: BgTaskSnapshot; next_sequence: number }
  | { tasks: BgTaskSnapshot[] }
  | (BgLogsDetails & { text: string })
  | { task: BgTaskSnapshot; message: string };

export type ExternalTaskResponse =
  | {
      schema_version: typeof BG_EXTERNAL_RESPONSE_SCHEMA;
      request_id: string;
      operation: string;
      ok: true;
      result: ExternalTaskResult;
    }
  | {
      schema_version: typeof BG_EXTERNAL_RESPONSE_SCHEMA;
      request_id: string;
      operation: string;
      ok: false;
      error: string;
    };

export interface ExternalTaskCancelFrame {
  schema_version: typeof BG_EXTERNAL_CANCEL_SCHEMA;
  service_id: string;
  owner_id: string;
  owner_ref: string;
  task_id: string;
  cancel_id: string;
  reason: string;
}

export interface ExternalTaskTerminalFrame {
  schema_version: typeof BG_EXTERNAL_TERMINAL_SCHEMA;
  service_id: string;
  task: BgTaskSnapshot;
}

export interface BackgroundTaskExtensionService {
  publishTerminal(task: BgTaskSnapshot): void;
  beginShutdown(): void;
  drainRequests(): Promise<void>;
  close(): void;
}

export interface BackgroundTaskExtensionServiceOptions {
  events: EventBus;
  registry: BackgroundTaskRegistry;
  getContext: () => BackgroundTaskContext | undefined;
  isShuttingDown: () => boolean;
  logger?: Pick<Console, 'error'> | undefined;
}

type JsonRecord = JsonObject;

interface ParsedV1Request {
  requestId: string;
  operationEcho: string;
  request?: BackgroundTaskExtensionRequest | undefined;
  error?: string | undefined;
}

interface ParsedV2Request {
  requestId: string;
  operationEcho: string;
  request?: {
    request_id: string;
    operation: ExternalTaskOperation;
    payload: JsonRecord;
  };
  error?: string | undefined;
}

interface TerminalPublicationGate {
  promise: Promise<void>;
  releaseAfterResponse(): Promise<void>;
}

interface OwnerSession {
  id: string;
  token: string;
  refs: Map<string, string>;
  pendingRefs: Set<string>;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function assertClosed(record: JsonRecord, allowedKeys: readonly string[], label: string): void {
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) throw new Error(`${label} contains unknown key ${key}`);
  }
}

function requireRecord(value: unknown, label: string): JsonRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireNonEmptyString(value: unknown, label: string, maxChars = Number.MAX_SAFE_INTEGER): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value.length > maxChars) throw new Error(`${label} must be at most ${String(maxChars)} characters`);
  return value;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean`);
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function requireV1Operation(value: unknown, label: string): BackgroundTaskExtensionOperation {
  if (value === 'capabilities' || value === 'run' || value === 'status' || value === 'logs' || value === 'kill') return value;
  throw new Error(`${label} must be one of capabilities, run, status, logs, kill`);
}

function requireV2Operation(value: unknown, label: string): ExternalTaskOperation {
  if (
    value === 'handshake' ||
    value === 'register' ||
    value === 'update' ||
    value === 'log' ||
    value === 'cancel_ack' ||
    value === 'settle' ||
    value === 'status' ||
    value === 'logs' ||
    value === 'kill'
  ) return value;
  throw new Error(`${label} is not a supported external task operation`);
}

function operationEcho(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : 'malformed';
}

function requestIdEcho(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : 'malformed';
}

function parseCapabilitiesPayload(value: unknown): Record<PropertyKey, never> {
  const payload = requireRecord(value, 'capabilities.payload');
  assertClosed(payload, [], 'capabilities.payload');
  return {};
}

function parseRunPayload(value: unknown): BackgroundTaskExtensionRunPayload {
  const payload = requireRecord(value, 'run.payload');
  assertClosed(payload, ['name', 'command', 'isAgent', 'timeoutSeconds', 'notifyOnCompletion', 'triggerOnCompletion'], 'run.payload');
  const out: BackgroundTaskExtensionRunPayload = {
    name: requireNonEmptyString(payload['name'], 'run.payload.name'),
    command: requireNonEmptyString(payload['command'], 'run.payload.command'),
    isAgent: requireBoolean(payload['isAgent'], 'run.payload.isAgent'),
    notifyOnCompletion: requireBoolean(payload['notifyOnCompletion'], 'run.payload.notifyOnCompletion'),
    triggerOnCompletion: requireBoolean(payload['triggerOnCompletion'], 'run.payload.triggerOnCompletion'),
  };
  if (hasOwn(payload, 'timeoutSeconds')) out.timeoutSeconds = requirePositiveInteger(payload['timeoutSeconds'], 'run.payload.timeoutSeconds');
  return out;
}

function parseStatusPayload(value: unknown): BackgroundTaskExtensionStatusPayload {
  const payload = requireRecord(value, 'status.payload');
  assertClosed(payload, ['taskId'], 'status.payload');
  const out: BackgroundTaskExtensionStatusPayload = {};
  if (hasOwn(payload, 'taskId')) out.taskId = requireNonEmptyString(payload['taskId'], 'status.payload.taskId');
  return out;
}

function parseLogsPayload(value: unknown): BackgroundTaskExtensionLogsPayload {
  const payload = requireRecord(value, 'logs.payload');
  assertClosed(payload, ['taskId', 'maxBytes', 'tail'], 'logs.payload');
  const out: BackgroundTaskExtensionLogsPayload = { taskId: requireNonEmptyString(payload['taskId'], 'logs.payload.taskId') };
  if (hasOwn(payload, 'maxBytes')) out.maxBytes = requirePositiveInteger(payload['maxBytes'], 'logs.payload.maxBytes');
  if (hasOwn(payload, 'tail')) out.tail = requireBoolean(payload['tail'], 'logs.payload.tail');
  return out;
}

function parseKillPayload(value: unknown): BackgroundTaskExtensionKillPayload {
  const payload = requireRecord(value, 'kill.payload');
  assertClosed(payload, ['taskId'], 'kill.payload');
  return { taskId: requireNonEmptyString(payload['taskId'], 'kill.payload.taskId') };
}

function parseV1Payload(operation: BackgroundTaskExtensionOperation, value: unknown): BackgroundTaskExtensionPayload {
  switch (operation) {
    case 'capabilities': return parseCapabilitiesPayload(value);
    case 'run': return parseRunPayload(value);
    case 'status': return parseStatusPayload(value);
    case 'logs': return parseLogsPayload(value);
    case 'kill': return parseKillPayload(value);
  }
}

function parseV1Request(data: unknown): ParsedV1Request {
  if (!isRecord(data)) return { requestId: 'malformed', operationEcho: 'malformed', error: 'request frame must be an object' };
  const requestId = requestIdEcho(data['request_id']);
  const opEcho = operationEcho(data['operation']);
  try {
    assertClosed(data, ['schema_version', 'request_id', 'operation', 'payload'], 'request');
    if (data['schema_version'] !== BG_REQUEST_SCHEMA) throw new Error('request schema_version mismatch');
    const parsedRequestId = requireNonEmptyString(data['request_id'], 'request.request_id', MAX_REQUEST_ID_CHARS);
    const operation = requireV1Operation(data['operation'], 'request.operation');
    if (!hasOwn(data, 'payload')) throw new Error('request.payload is required');
    return {
      requestId: parsedRequestId,
      operationEcho: operation,
      request: { schema_version: BG_REQUEST_SCHEMA, request_id: parsedRequestId, operation, payload: parseV1Payload(operation, data['payload']) },
    };
  } catch (error) {
    return { requestId, operationEcho: opEcho, error: errorText(error) };
  }
}

function parseV2Request(data: unknown): ParsedV2Request {
  if (!isRecord(data)) return { requestId: 'malformed', operationEcho: 'malformed', error: 'external request frame must be an object' };
  const requestId = requestIdEcho(data['request_id']);
  const opEcho = operationEcho(data['operation']);
  try {
    assertClosed(data, ['schema_version', 'request_id', 'operation', 'payload'], 'external request');
    if (data['schema_version'] !== BG_EXTERNAL_REQUEST_SCHEMA) throw new Error('external request schema_version mismatch');
    const parsedRequestId = requireNonEmptyString(data['request_id'], 'external request.request_id', MAX_REQUEST_ID_CHARS);
    const operation = requireV2Operation(data['operation'], 'external request.operation');
    const payload = requireRecord(data['payload'], `${operation}.payload`);
    return { requestId: parsedRequestId, operationEcho: operation, request: { request_id: parsedRequestId, operation, payload } };
  } catch (error) {
    return { requestId, operationEcho: opEcho, error: errorText(error) };
  }
}

function createTerminalPublicationGate(): TerminalPublicationGate {
  let resolveGate!: () => void;
  const promise = new Promise<void>((resolve) => { resolveGate = resolve; });
  return {
    promise,
    async releaseAfterResponse() {
      await Promise.resolve();
      resolveGate();
    },
  };
}

function combineTerminalPublicationGates(existing: Promise<void> | undefined, next: Promise<void> | undefined): Promise<void> | undefined {
  if (existing === undefined) return next;
  if (next === undefined) return existing;
  return Promise.all([existing, next]).then(() => undefined);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function boundedBackgroundTaskError(error: unknown): string {
  const text = errorText(error).replace(/\s+/gu, ' ').trim();
  if (text.length <= MAX_ERROR_CHARS) return text;
  return `${text.slice(0, MAX_ERROR_CHARS - 1)}…`;
}

function v1ErrorResponse(requestId: string, operation: string, error: unknown): BackgroundTaskExtensionResponse {
  return { schema_version: BG_RESPONSE_SCHEMA, request_id: requestId, operation, ok: false, error: boundedBackgroundTaskError(error) };
}

function v1SuccessResponse(request: BackgroundTaskExtensionRequest, result: BackgroundTaskExtensionResult): BackgroundTaskExtensionResponse {
  return { schema_version: BG_RESPONSE_SCHEMA, request_id: request.request_id, operation: request.operation, ok: true, result };
}

function v2ErrorResponse(requestId: string, operation: string, error: unknown): ExternalTaskResponse {
  return { schema_version: BG_EXTERNAL_RESPONSE_SCHEMA, request_id: requestId, operation, ok: false, error: boundedBackgroundTaskError(error) };
}

function v2SuccessResponse(requestId: string, operation: ExternalTaskOperation, result: ExternalTaskResult): ExternalTaskResponse {
  return { schema_version: BG_EXTERNAL_RESPONSE_SCHEMA, request_id: requestId, operation, ok: true, result };
}

function externalCapabilities(value: unknown, label: string): ExternalTaskCapabilities {
  const capabilities = requireRecord(value, label);
  assertClosed(capabilities, ['cancellable', 'rerunnable'], label);
  return {
    cancellable: requireBoolean(capabilities['cancellable'], `${label}.cancellable`),
    rerunnable: requireBoolean(capabilities['rerunnable'], `${label}.rerunnable`),
  };
}

class InstalledBackgroundTaskExtensionService implements BackgroundTaskExtensionService {
  private readonly events: EventBus;
  private readonly registry: BackgroundTaskRegistry;
  private readonly getContext: () => BackgroundTaskContext | undefined;
  private readonly isShuttingDown: () => boolean;
  private readonly logger: Pick<Console, 'error'>;
  private readonly serviceId = `bgv2-${randomBytes(12).toString('hex')}`;
  private readonly owners = new Map<string, OwnerSession>();
  private readonly seenV1RequestIds = new Set<string>();
  private readonly seenV2RequestIds = new Set<string>();
  private readonly requestPromises = new Set<Promise<void>>();
  private readonly unsubscribeV1: () => void;
  private readonly unsubscribeV2: () => void;
  private acceptingV1 = true;
  private settlingV2Only = false;
  private closed = false;

  constructor(options: BackgroundTaskExtensionServiceOptions) {
    this.events = options.events;
    this.registry = options.registry;
    this.getContext = options.getContext;
    this.isShuttingDown = options.isShuttingDown;
    this.logger = options.logger ?? console;
    this.unsubscribeV1 = this.events.on(BG_REQUEST_CHANNEL, (data) => this.track(this.handleV1(data)));
    this.unsubscribeV2 = this.events.on(BG_EXTERNAL_REQUEST_CHANNEL, (data) => this.track(this.handleV2(data)));
  }

  publishTerminal(task: BgTaskSnapshot): void {
    if (this.closed) throw new Error('pi-background-tasks EventBus service is closed');
    this.events.emit(BG_TERMINAL_CHANNEL, { schema_version: BG_TERMINAL_SCHEMA, task } satisfies BackgroundTaskExtensionTerminal);
    if (task.owner !== undefined) {
      this.events.emit(BG_EXTERNAL_TERMINAL_CHANNEL, {
        schema_version: BG_EXTERNAL_TERMINAL_SCHEMA,
        service_id: this.serviceId,
        task,
      } satisfies ExternalTaskTerminalFrame);
    }
  }

  beginShutdown(): void {
    if (!this.acceptingV1) throw new Error('pi-background-tasks EventBus request intake is already closed');
    this.acceptingV1 = false;
    this.settlingV2Only = true;
    this.unsubscribeV1();
  }

  async drainRequests(): Promise<void> {
    if (this.acceptingV1) throw new Error('cannot drain pi-background-tasks EventBus requests while intake is open');
    while (this.requestPromises.size > 0) await Promise.all([...this.requestPromises]);
  }

  close(): void {
    if (this.acceptingV1) throw new Error('cannot close pi-background-tasks EventBus service while request intake is open');
    if (this.requestPromises.size !== 0) throw new Error('cannot close pi-background-tasks EventBus service with requests in flight');
    this.unsubscribeV2();
    this.closed = true;
    installedServices.delete(this.events);
  }

  private track(request: Promise<void>): void {
    this.requestPromises.add(request);
    void request.then(
      () => this.requestPromises.delete(request),
      (error: unknown) => {
        this.requestPromises.delete(request);
        this.logger.error('[background-tasks] EventBus request handling failed:', error);
      },
    );
  }

  private async handleV1(data: unknown): Promise<void> {
    const parsed = parseV1Request(data);
    if (parsed.error !== undefined || parsed.request === undefined) {
      this.emitV1(v1ErrorResponse(parsed.requestId, parsed.operationEcho, parsed.error ?? 'malformed request'));
      return;
    }
    const request = parsed.request;
    if (this.seenV1RequestIds.has(request.request_id)) {
      this.emitV1(v1ErrorResponse(request.request_id, request.operation, `duplicate request_id ${request.request_id}`));
      return;
    }
    this.seenV1RequestIds.add(request.request_id);
    const terminalGate = request.operation === 'run' || request.operation === 'kill' ? createTerminalPublicationGate() : undefined;
    try {
      this.assertGeneralAvailability();
      const ctx = this.requireContext();
      this.emitV1(v1SuccessResponse(request, await this.executeV1(ctx, request, terminalGate?.promise)));
    } catch (error) {
      this.emitV1(v1ErrorResponse(request.request_id, request.operation, error));
    } finally {
      await terminalGate?.releaseAfterResponse();
    }
  }

  private async executeV1(
    ctx: BackgroundTaskContext,
    request: BackgroundTaskExtensionRequest,
    terminalPublicationGate: Promise<void> | undefined,
  ): Promise<BackgroundTaskExtensionResult> {
    switch (request.operation) {
      case 'capabilities': return { ...BG_EXTENSION_CAPABILITIES };
      case 'run': {
        const payload = request.payload as BackgroundTaskExtensionRunPayload;
        const options: StartTaskOptions = {
          name: payload.name,
          isAgent: payload.isAgent,
          notifyOnCompletion: payload.notifyOnCompletion,
          triggerOnCompletion: payload.triggerOnCompletion,
          terminalPublicationGate,
        };
        if (payload.timeoutSeconds !== undefined) options.timeoutSeconds = payload.timeoutSeconds;
        return this.registry.snapshot(await this.registry.startTask(ctx, payload.command, options));
      }
      case 'status': {
        const payload = request.payload as BackgroundTaskExtensionStatusPayload;
        const tasks = payload.taskId ? [this.registry.resolveTask(payload.taskId)] : this.registry.allTasks();
        return { tasks: tasks.map((task) => this.registry.snapshot(task)) };
      }
      case 'logs': {
        const payload = request.payload as BackgroundTaskExtensionLogsPayload;
        const task = this.registry.resolveTask(payload.taskId);
        const logs = await this.registry.getTaskLogs(task, normalizeMaxBytes(payload.maxBytes, DEFAULT_LOG_BYTES), payload.tail ?? true);
        return { ...logs.details, text: logs.text };
      }
      case 'kill': {
        const payload = request.payload as BackgroundTaskExtensionKillPayload;
        const task = this.registry.resolveTask(payload.taskId);
        task.terminalPublicationGate = combineTerminalPublicationGates(task.terminalPublicationGate, terminalPublicationGate);
        await this.registry.stopTask(task, 'user');
        const snapshot = this.registry.snapshot(task);
        return { task: snapshot, message: `Killed background task ${snapshot.name ?? snapshot.id} (${snapshot.id}). Output: ${snapshot.outputPath}` };
      }
    }
  }

  private async handleV2(data: unknown): Promise<void> {
    const parsed = parseV2Request(data);
    if (parsed.error !== undefined || parsed.request === undefined) {
      this.emitV2(v2ErrorResponse(parsed.requestId, parsed.operationEcho, parsed.error ?? 'malformed external request'));
      return;
    }
    const request = parsed.request;
    if (this.seenV2RequestIds.has(request.request_id)) {
      this.emitV2(v2ErrorResponse(request.request_id, request.operation, `duplicate request_id ${request.request_id}`));
      return;
    }
    this.seenV2RequestIds.add(request.request_id);
    const terminalGate = request.operation === 'settle' || request.operation === 'kill' ? createTerminalPublicationGate() : undefined;
    try {
      if (this.closed) throw new Error('pi-background-tasks EventBus service is closed');
      if (this.settlingV2Only && request.operation !== 'cancel_ack' && request.operation !== 'settle') {
        throw new Error('pi-background-tasks EventBus service is shutting down');
      }
      if (!this.settlingV2Only && (this.isShuttingDown() || this.registry.isShuttingDown())) {
        throw new Error('pi-background-tasks EventBus service is shutting down');
      }
      const result = await this.executeV2(request.operation, request.payload, terminalGate?.promise);
      this.emitV2(v2SuccessResponse(request.request_id, request.operation, result));
    } catch (error) {
      this.emitV2(v2ErrorResponse(request.request_id, request.operation, error));
    } finally {
      await terminalGate?.releaseAfterResponse();
    }
  }

  private async executeV2(
    operation: ExternalTaskOperation,
    payload: JsonRecord,
    terminalPublicationGate: Promise<void> | undefined,
  ): Promise<ExternalTaskResult> {
    if (operation === 'handshake') {
      assertClosed(payload, ['protocol_version', 'owner_id'], 'handshake.payload');
      if (payload['protocol_version'] !== 2) throw new Error('handshake.payload.protocol_version must be 2');
      const ownerId = requireNonEmptyString(payload['owner_id'], 'handshake.payload.owner_id', MAX_OWNER_ID_CHARS);
      if (this.owners.has(ownerId)) throw new Error(`owner ${ownerId} already completed a handshake`);
      const owner: OwnerSession = { id: ownerId, token: randomBytes(24).toString('hex'), refs: new Map(), pendingRefs: new Set() };
      this.owners.set(ownerId, owner);
      return { ...BG_EXTERNAL_CAPABILITIES, service_id: this.serviceId, owner_id: owner.id, owner_token: owner.token };
    }

    const owner = this.authenticateOwner(payload, operation);
    if (operation === 'register') {
      assertClosed(payload, ['service_id', 'owner_id', 'owner_token', 'owner_ref', 'name', 'description', 'capabilities', 'notify_on_completion', 'trigger_on_completion', 'stop_wait_ms'], 'register.payload');
      const ownerRef = requireNonEmptyString(payload['owner_ref'], 'register.payload.owner_ref', MAX_OWNER_REF_CHARS);
      if (owner.refs.has(ownerRef) || owner.pendingRefs.has(ownerRef)) throw new Error(`owner reference ${ownerRef} is already registered`);
      const name = requireNonEmptyString(payload['name'], 'register.payload.name');
      const description = hasOwn(payload, 'description') ? requireNonEmptyString(payload['description'], 'register.payload.description') : undefined;
      const capabilities = externalCapabilities(payload['capabilities'], 'register.payload.capabilities');
      const notifyOnCompletion = requireBoolean(payload['notify_on_completion'], 'register.payload.notify_on_completion');
      const triggerOnCompletion = requireBoolean(payload['trigger_on_completion'], 'register.payload.trigger_on_completion');
      const stopWaitMs = hasOwn(payload, 'stop_wait_ms') ? requirePositiveInteger(payload['stop_wait_ms'], 'register.payload.stop_wait_ms') : undefined;
      const ctx = this.requireContext();
      owner.pendingRefs.add(ownerRef);
      let task!: BgTask;
      try {
        task = await this.registry.registerExternalTask(ctx, {
          name,
          description,
          owner: { id: owner.id, ref: ownerRef },
          capabilities,
          notifyOnCompletion,
          triggerOnCompletion,
          stopWaitMs,
          cancel: () => this.publishCancellation(task),
        });
      } catch (error) {
        owner.pendingRefs.delete(ownerRef);
        throw error;
      }
      owner.pendingRefs.delete(ownerRef);
      owner.refs.set(ownerRef, task.id);
      return { task: this.registry.snapshot(task), next_sequence: task.externalSequence ?? 1 };
    }

    const task = this.authenticateTask(owner, payload, operation);
    if (operation === 'status') {
      assertClosed(payload, ['service_id', 'owner_id', 'owner_token', 'task_id'], 'status.payload');
      return { tasks: [this.registry.snapshot(task)] };
    }
    if (operation === 'logs') {
      assertClosed(payload, ['service_id', 'owner_id', 'owner_token', 'task_id', 'max_bytes', 'tail'], 'logs.payload');
      const maxBytes = hasOwn(payload, 'max_bytes') ? requirePositiveInteger(payload['max_bytes'], 'logs.payload.max_bytes') : DEFAULT_LOG_BYTES;
      const tail = hasOwn(payload, 'tail') ? requireBoolean(payload['tail'], 'logs.payload.tail') : true;
      const logs = await this.registry.getTaskLogs(task, normalizeMaxBytes(maxBytes, DEFAULT_LOG_BYTES), tail);
      return { ...logs.details, text: logs.text };
    }
    if (operation === 'kill') {
      assertClosed(payload, ['service_id', 'owner_id', 'owner_token', 'task_id'], 'kill.payload');
      if (task.capabilities?.cancellable !== true) throw new Error(`Task ${task.id} is not cancellable`);
      task.terminalPublicationGate = combineTerminalPublicationGates(task.terminalPublicationGate, terminalPublicationGate);
      await this.registry.stopTask(task, 'user');
      const snapshot = this.registry.snapshot(task);
      return { task: snapshot, message: `Killed background task ${snapshot.name ?? snapshot.id} (${snapshot.id}). Output: ${snapshot.outputPath}` };
    }

    const sequence = requirePositiveInteger(payload['sequence'], `${operation}.payload.sequence`);

    // Pure per-op validation first, so malformed frames never consume a sequence.
    let action: () => Promise<void>;
    if (operation === 'log') {
      assertClosed(payload, ['service_id', 'owner_id', 'owner_token', 'task_id', 'sequence', 'text'], 'log.payload');
      const text = requireNonEmptyString(payload['text'], 'log.payload.text');
      action = () => this.registry.appendExternalLog(task, text);
    } else if (operation === 'update') {
      assertClosed(payload, ['service_id', 'owner_id', 'owner_token', 'task_id', 'sequence', 'name', 'description', 'capabilities'], 'update.payload');
      if (!hasOwn(payload, 'name') && !hasOwn(payload, 'description') && !hasOwn(payload, 'capabilities')) {
        throw new Error('update.payload must contain at least one update field');
      }
      const update: UpdateExternalTaskOptions = {};
      if (hasOwn(payload, 'name')) update.name = requireNonEmptyString(payload['name'], 'update.payload.name');
      if (hasOwn(payload, 'description')) update.description = requireNonEmptyString(payload['description'], 'update.payload.description');
      if (hasOwn(payload, 'capabilities')) update.capabilities = externalCapabilities(payload['capabilities'], 'update.payload.capabilities');
      action = () => this.registry.updateExternalTask(task, update);
    } else if (operation === 'cancel_ack') {
      assertClosed(payload, ['service_id', 'owner_id', 'owner_token', 'task_id', 'sequence', 'cancel_id'], 'cancel_ack.payload');
      const cancelId = requireNonEmptyString(payload['cancel_id'], 'cancel_ack.payload.cancel_id');
      action = () => Promise.resolve(this.registry.acknowledgeExternalCancellation(task, cancelId));
    } else if (operation === 'settle') {
      assertClosed(payload, ['service_id', 'owner_id', 'owner_token', 'task_id', 'sequence', 'status', 'error'], 'settle.payload');
      const status = payload['status'];
      if (status !== 'completed' && status !== 'failed' && status !== 'killed') throw new Error('settle.payload.status must be completed, failed, or killed');
      const error = hasOwn(payload, 'error') ? requireNonEmptyString(payload['error'], 'settle.payload.error') : undefined;
      if (status === 'failed' && error === undefined) throw new Error('settle.payload.error is required for failed status');
      if (status !== 'failed' && error !== undefined) throw new Error('settle.payload.error is allowed only for failed status');
      action = () => this.registry.settleExternalTask(task, status, error, terminalPublicationGate);
    } else {
      throw new Error(`Unsupported external task operation ${operation}`);
    }

    // Reservation commit point: the sequence check and advance are one
    // synchronous step, so a duplicate-sequence frame pipelined in the same
    // tick observes the committed sequence and fails loudly. A sequence is
    // consumed only by fully validated frames; a registry failure after the
    // reservation still consumes it.
    const expectedSequence = task.externalSequence ?? 1;
    if (sequence !== expectedSequence) throw new Error(`Task ${task.id} expected sequence ${String(expectedSequence)}, received ${String(sequence)}`);
    task.externalSequence = expectedSequence + 1;

    await action();
    return { task: this.registry.snapshot(task), next_sequence: task.externalSequence };
  }

  private authenticateOwner(payload: JsonRecord, operation: ExternalTaskOperation): OwnerSession {
    const serviceId = requireNonEmptyString(payload['service_id'], `${operation}.payload.service_id`);
    if (serviceId !== this.serviceId) throw new Error('service_id mismatch');
    const ownerId = requireNonEmptyString(payload['owner_id'], `${operation}.payload.owner_id`);
    const owner = this.owners.get(ownerId);
    if (owner === undefined) throw new Error(`unknown owner ${ownerId}`);
    const token = requireNonEmptyString(payload['owner_token'], `${operation}.payload.owner_token`);
    if (token !== owner.token) throw new Error(`owner token mismatch for ${ownerId}`);
    return owner;
  }

  private authenticateTask(owner: OwnerSession, payload: JsonRecord, operation: ExternalTaskOperation): BgTask {
    const taskId = requireNonEmptyString(payload['task_id'], `${operation}.payload.task_id`);
    const task = this.registry.resolveTask(taskId);
    if (task.owner?.id !== owner.id) throw new Error(`Task ${task.id} is not owned by ${owner.id}`);
    if (owner.refs.get(task.owner.ref) !== task.id) throw new Error(`Task ${task.id} owner reference is stale`);
    return task;
  }

  private publishCancellation(task: BgTask): void {
    if (task.owner === undefined || task.externalCancelId === undefined) throw new Error(`Task ${task.id} cancellation frame is incomplete`);
    const frame: ExternalTaskCancelFrame = {
      schema_version: BG_EXTERNAL_CANCEL_SCHEMA,
      service_id: this.serviceId,
      owner_id: task.owner.id,
      owner_ref: task.owner.ref,
      task_id: task.id,
      cancel_id: task.externalCancelId,
      reason: task.error ?? 'Cancellation requested by background task service',
    };
    this.events.emit(BG_EXTERNAL_CANCEL_CHANNEL, frame);
  }

  private assertGeneralAvailability(): void {
    if (this.closed) throw new Error('pi-background-tasks EventBus service is closed');
    if (this.isShuttingDown() || this.registry.isShuttingDown()) throw new Error('pi-background-tasks EventBus service is shutting down');
  }

  private requireContext(): BackgroundTaskContext {
    const ctx = this.getContext();
    if (ctx === undefined) throw new Error('pi-background-tasks EventBus service is unavailable before session_start');
    return ctx;
  }

  private emitV1(response: BackgroundTaskExtensionResponse): void {
    try { this.events.emit(BG_RESPONSE_CHANNEL, response); }
    catch (error) { this.logger.error('[background-tasks] EventBus response emit failed:', error); }
  }

  private emitV2(response: ExternalTaskResponse): void {
    try { this.events.emit(BG_EXTERNAL_RESPONSE_CHANNEL, response); }
    catch (error) { this.logger.error('[background-tasks] external EventBus response emit failed:', error); }
  }
}

export function installBackgroundTaskExtensionApi(options: BackgroundTaskExtensionServiceOptions): BackgroundTaskExtensionService {
  if (installedServices.has(options.events)) throw new Error('pi-background-tasks EventBus service is already installed on this EventBus');
  const service = new InstalledBackgroundTaskExtensionService(options);
  installedServices.set(options.events, service);
  return service;
}

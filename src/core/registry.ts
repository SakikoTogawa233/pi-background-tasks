import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { formatSize } from '@earendil-works/pi-coding-agent';
import {
  boundedRead,
  deriveTaskNameFromCommand,
  escapeXml,
  formatDuration,
  normalizeTaskName,
  sanitizePathSegment,
  shellInvocation,
  snapshot,
  taskDisplayName,
  type BgLogsDetails,
  type BgTask,
  type BgTaskSnapshot,
  type KillKind,
  type RegisterExternalTaskOptions,
  type StartTaskOptions,
  type TaskStatus,
  type UpdateExternalTaskOptions,
} from './common.js';
import { replaceFileDurable } from './durable-fs.js';
import {
  runWindowsTaskkill,
  type TaskkillOutcome,
  type WindowsKillPhase,
  type WindowsTaskkillOptions,
} from './windows-taskkill.js';

export const MAX_OUTPUT_BYTES = Number(process.env['PI_BG_MAX_OUTPUT_BYTES'] ?? 20 * 1024 * 1024);
export const KILL_GRACE_MS = 3000;
export const STOP_WAIT_MS = KILL_GRACE_MS + 1500;
export const MAX_RECENT_TASKS = 100;
export interface BackgroundTaskContext {
  cwd: string;
  sessionId?: string;
  modelRegistry: Pick<ExtensionContext['modelRegistry'], 'getAll'>;
  model?: ExtensionContext['model'] | undefined;
}

interface OutputEventSource {
  on(event: 'data', listener: (data: Buffer | string) => void): unknown;
}

interface ChildStdin {
  write(data: Buffer, callback: (error?: Error | null) => void): boolean;
  end(callback?: () => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
}

export interface BackgroundTaskChildProcess {
  pid?: number | undefined;
  stdin?: ChildStdin | null | undefined;
  stdout?: OutputEventSource | null | undefined;
  stderr?: OutputEventSource | null | undefined;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

export type BackgroundTaskSpawn = (
  command: string,
  args: string[],
  options: SpawnOptions,
) => BackgroundTaskChildProcess;

type KillProcessFn = (pid: number, signal?: NodeJS.Signals | number) => boolean;
type KillTreeFn = (
  pid: number,
  phase: WindowsKillPhase,
  signal?: AbortSignal,
) => Promise<TaskkillOutcome>;

interface WindowsKillState {
  softController?: AbortController | undefined;
  softPromise?: Promise<void> | undefined;
  forceController?: AbortController | undefined;
  forcePromise?: Promise<void> | undefined;
  forceFailure?: Error | undefined;
  forceFailureListeners?: Array<(error: Error) => void> | undefined;
  retiring?: boolean | undefined;
}

export interface CompletionNotificationMessage {
  customType: 'background-task-notification';
  content: string;
  display: true;
  details: BgTaskSnapshot;
}

export interface CompletionNotificationOptions {
  deliverAs: 'followUp';
  triggerTurn: boolean;
}

export type CompletionNotificationSender = (
  message: CompletionNotificationMessage,
  options: CompletionNotificationOptions,
) => void;

export interface AdoptRunningChildOptions {
  command: string;
  name?: string | undefined;
  startedAt?: number | undefined;
  notifyOnCompletion?: boolean | undefined;
  triggerOnCompletion?: boolean | undefined;
  /** Existing foreground output file whose append ownership transfers to the registry. */
  outputPath?: string | undefined;
}

export type BackgroundTaskLaunchKind = 'task' | 'external';

export interface BackgroundTaskRegistryOptions {
  onChange?: () => void;
  sendCompletionNotification: CompletionNotificationSender;
  /** Test/dependency seam entered after launch ownership is acquired and before launch work begins. */
  beforeLaunch?: (kind: BackgroundTaskLaunchKind) => Promise<void>;
  publishTerminal?: (task: BgTaskSnapshot) => void;
  writeJsonAtomic?: (path: string, value: unknown) => Promise<void>;
  spawn?: BackgroundTaskSpawn;
  killProcess?: KillProcessFn;
  killTree?: KillTreeFn;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  makeTaskId?: () => string;
  now?: () => number;
  maxOutputBytes?: number;
  maxRecentTasks?: number;
  killGraceMs?: number;
  stopWaitMs?: number;
  logger?: Pick<Console, 'error'>;
}

interface RuntimeDir {
  abs: string;
  display: string;
}

function defaultTaskId(): string {
  return `b${randomBytes(4).toString('hex')}`;
}

function noopOnChange(): void {
  return undefined;
}

function noopBeforeLaunch(_kind: BackgroundTaskLaunchKind): Promise<void> {
  return Promise.resolve();
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await replaceFileDurable(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function closeOutputStream(stream: NodeJS.WritableStream | undefined): Promise<void> {
  if (stream === undefined) return;
  await new Promise<void>((resolve, reject) => {
    const finish = () => {
      stream.off('error', fail);
      stream.off('close', finish);
      stream.off('finish', finish);
      resolve();
    };
    const fail = (error: Error) => {
      stream.off('close', finish);
      stream.off('finish', finish);
      reject(error);
    };
    stream.once('close', finish);
    stream.once('finish', finish);
    stream.once('error', fail);
    stream.end();
  });
}

function combinePublicationGates(
  existing: Promise<void> | undefined,
  next: Promise<void> | undefined,
): Promise<void> | undefined {
  if (existing === undefined) return next;
  if (next === undefined) return existing;
  return Promise.all([existing, next]).then(() => undefined);
}

export class BackgroundTaskRegistry {
  private readonly tasks = new Map<string, BgTask>();
  private runtimeDir: RuntimeDir | undefined;
  private shuttingDown = false;
  private readonly spawn: BackgroundTaskSpawn;
  private readonly killProcess: KillProcessFn;
  private readonly killTree: KillTreeFn;
  private readonly platform: NodeJS.Platform;
  private readonly env: NodeJS.ProcessEnv;
  private readonly makeTaskIdFn: () => string;
  private readonly now: () => number;
  private readonly maxOutputBytes: number;
  private readonly maxRecentTasks: number;
  private readonly killGraceMs: number;
  private readonly stopWaitMs: number;
  private readonly logger: Pick<Console, 'error'>;
  private readonly onChange: () => void;
  private readonly sendCompletionNotification: CompletionNotificationSender;
  private readonly beforeLaunch: (kind: BackgroundTaskLaunchKind) => Promise<void>;
  private readonly publishTerminalSnapshot: (task: BgTaskSnapshot) => void;
  private readonly writeJsonAtomic: (path: string, value: unknown) => Promise<void>;
  private readonly launchOperations = new Set<Promise<void>>();
  private readonly terminalPublications = new Set<Promise<void>>();
  private readonly windowsKillStates = new WeakMap<BgTask, WindowsKillState>();

  constructor(options: BackgroundTaskRegistryOptions) {
    this.spawn =
      options.spawn ?? ((command, args, spawnOptions) => nodeSpawn(command, args, spawnOptions));
    this.killProcess = options.killProcess ?? process.kill.bind(process);
    this.platform = options.platform ?? process.platform;
    this.env = options.env ?? process.env;
    this.killTree =
      options.killTree ??
      ((pid, phase, signal) => {
        const taskkillOptions: WindowsTaskkillOptions =
          signal === undefined ? { env: this.env } : { env: this.env, signal };
        return runWindowsTaskkill(pid, phase, taskkillOptions);
      });
    this.makeTaskIdFn = options.makeTaskId ?? defaultTaskId;
    this.now = options.now ?? Date.now;
    this.maxOutputBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES;
    this.maxRecentTasks = options.maxRecentTasks ?? MAX_RECENT_TASKS;
    this.killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
    this.stopWaitMs = options.stopWaitMs ?? STOP_WAIT_MS;
    this.logger = options.logger ?? console;
    this.onChange = options.onChange ?? noopOnChange;
    this.sendCompletionNotification = options.sendCompletionNotification;
    this.beforeLaunch = options.beforeLaunch ?? noopBeforeLaunch;
    this.publishTerminalSnapshot = options.publishTerminal ?? noopOnChange;
    this.writeJsonAtomic = options.writeJsonAtomic ?? writeJsonAtomic;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  setShuttingDown(value: boolean): void {
    this.shuttingDown = value;
  }

  private ownLaunchOperation<T>(
    kind: BackgroundTaskLaunchKind,
    shutdownError: string,
    work: () => Promise<T>,
  ): Promise<T> {
    if (this.shuttingDown) return Promise.reject(new Error(shutdownError));

    let settleOwnership!: () => void;
    const ownership = new Promise<void>((resolve) => {
      settleOwnership = resolve;
    });
    this.launchOperations.add(ownership);

    const launch = (async () => {
      await this.beforeLaunch(kind);
      return work();
    })();
    void launch.then(
      () => {
        this.launchOperations.delete(ownership);
        settleOwnership();
      },
      () => {
        this.launchOperations.delete(ownership);
        settleOwnership();
      },
    );
    return launch;
  }

  /** Await every launch operation that acquired ownership before shutdown closed admission. */
  async waitForLaunchOperations(): Promise<void> {
    while (this.launchOperations.size > 0) {
      await Promise.all([...this.launchOperations]);
    }
  }

  allTasks(): BgTask[] {
    return [...this.tasks.values()];
  }

  snapshot(task: BgTask): BgTaskSnapshot {
    return snapshot(task);
  }

  private runtimeDirForContext(ctx: BackgroundTaskContext): RuntimeDir {
    const sessionId = sanitizePathSegment(ctx.sessionId ?? `session-${String(process.pid)}`);
    const runId = `${sessionId}-${String(process.pid)}`;
    return {
      abs: join(ctx.cwd, '.pi', 'tasks', runId),
      display: join('.pi', 'tasks', runId),
    };
  }

  private ensureRuntimeDirSync(ctx: BackgroundTaskContext): RuntimeDir {
    if (this.runtimeDir) return this.runtimeDir;
    const dir = this.runtimeDirForContext(ctx);
    mkdirSync(dir.abs, { recursive: true });
    this.runtimeDir = dir;
    return dir;
  }

  async ensureRuntimeDir(ctx: BackgroundTaskContext): Promise<RuntimeDir> {
    if (this.runtimeDir) return this.runtimeDir;
    const dir = this.runtimeDirForContext(ctx);
    await mkdir(dir.abs, { recursive: true });
    this.runtimeDir = dir;
    return dir;
  }

  adoptRunningChild(
    ctx: BackgroundTaskContext,
    child: BackgroundTaskChildProcess,
    options: AdoptRunningChildOptions,
  ): BgTask {
    const normalizedCommand = options.command.trim();
    if (!normalizedCommand) throw new Error('Background command is empty');
    if (this.shuttingDown)
      throw new Error('Cannot adopt a background task while Pi is shutting down');

    const dir = this.ensureRuntimeDirSync(ctx);
    const id = this.makeTaskIdFn();
    const defaultOutputAbsPath = join(dir.abs, `${id}.output`);
    const outputAbsPath =
      options.outputPath === undefined
        ? defaultOutputAbsPath
        : isAbsolute(options.outputPath)
          ? options.outputPath
          : join(ctx.cwd, options.outputPath);
    const outputPath = options.outputPath ?? join(dir.display, `${id}.output`);
    writeFileSync(outputAbsPath, '', { flag: 'a', encoding: 'utf8' });
    const task: BgTask = {
      id,
      name: normalizeTaskName(options.name) ?? deriveTaskNameFromCommand(normalizedCommand),
      command: normalizedCommand,
      status: 'running',
      outputPath,
      outputAbsPath,
      metadataAbsPath: join(dir.abs, `${id}.json`),
      cwd: ctx.cwd,
      startTime: options.startedAt ?? this.now(),
      exitCode: undefined,
      pid: child.pid,
      bytesWritten: statSync(outputAbsPath).size,
      isAgent: false,
      notified: false,
      notifyOnCompletion: options.notifyOnCompletion ?? true,
      triggerOnCompletion: options.triggerOnCompletion ?? true,
      child,
      finalizationSettled: false,
      waiters: [],
    };
    this.tasks.set(id, task);

    const stream = createWriteStream(outputAbsPath, { flags: 'a', encoding: 'utf8' });
    task.stream = stream;
    stream.on('error', (error) => {
      task.error = `Output file write failed: ${error.message}`;
      if (task.status === 'running') {
        task.killKind = 'output_cap';
        try {
          this.requestKill(task, 'SIGTERM');
        } catch (killError) {
          this.finalizeTaskFromCallback(
            task,
            'failed',
            null,
            undefined,
            `${task.error}; kill failed: ${BackgroundTaskRegistry.errorMessage(killError)}`,
          );
        }
      }
    });

    child.stdout?.on('data', (data) => {
      this.appendChildOutput(task, data, 'stdout');
    });
    child.stderr?.on('data', (data) => {
      this.appendChildOutput(task, data, 'stderr');
    });
    child.on('error', (error) => {
      this.writeNotice(task, `\n[background task child error: ${error.message}]\n`);
      this.finalizeTaskFromCallback(task, 'failed', null, undefined, error.message);
    });
    child.on('close', (code, signalName) => {
      let status: TaskStatus;
      let error: string | undefined;
      if (task.killKind === 'user' || task.killKind === 'shutdown') {
        status = 'killed';
      } else if (task.killKind === 'output_cap') {
        status = 'failed';
        error = task.error ?? `Output exceeded cap of ${formatSize(this.maxOutputBytes)}`;
      } else if ((code ?? 0) === 0) {
        status = 'completed';
      } else {
        status = 'failed';
        const exitCode = code === null ? 'null' : String(code);
        error = `Exited with code ${exitCode}${signalName ? ` (${signalName})` : ''}`;
      }
      this.finalizeTaskFromCallback(task, status, code, signalName, error);
    });

    void this.writeMetadata(task).catch((error: unknown) => {
      this.logger.error(
        `[background-tasks] failed to write initial metadata for adopted task ${task.id}:`,
        error,
      );
    });
    this.onChange();
    return task;
  }

  async startTask(
    ctx: BackgroundTaskContext,
    command: string,
    options: StartTaskOptions = {},
  ): Promise<BgTask> {
    return this.ownLaunchOperation(
      'task',
      'Cannot start a background task while Pi is shutting down',
      () => this.performStartTask(ctx, command, options),
    );
  }

  private async performStartTask(
    ctx: BackgroundTaskContext,
    command: string,
    options: StartTaskOptions,
  ): Promise<BgTask> {
    const normalizedCommand = command.trim();
    if (!normalizedCommand) throw new Error('Background command is empty');

    const isAgent = options.isAgent ?? false;
    const invocation = shellInvocation(normalizedCommand, this.platform, this.env);

    const dir = await this.ensureRuntimeDir(ctx);
    const id = this.makeTaskIdFn();
    const outputAbsPath = join(dir.abs, `${id}.output`);
    const metadataAbsPath = join(dir.abs, `${id}.json`);
    const outputPath = join(dir.display, `${id}.output`);
    const timeoutSeconds =
      typeof options.timeoutSeconds === 'number' &&
      Number.isFinite(options.timeoutSeconds) &&
      options.timeoutSeconds > 0
        ? Math.floor(options.timeoutSeconds)
        : undefined;
    const taskName =
      normalizeTaskName(options.name) ??
      normalizeTaskName(options.description) ??
      deriveTaskNameFromCommand(normalizedCommand);
    const trimmedDescription = options.description?.trim();
    const description =
      trimmedDescription && trimmedDescription.length > 0 ? trimmedDescription : undefined;

    const task: BgTask = {
      id,
      name: taskName,
      command: normalizedCommand,
      description,
      status: 'running',
      outputPath,
      outputAbsPath,
      metadataAbsPath,
      cwd: ctx.cwd,
      startTime: this.now(),
      exitCode: undefined,
      pid: undefined,
      bytesWritten: 0,
      isAgent,
      notified: false,
      notifyOnCompletion: options.notifyOnCompletion ?? true,
      triggerOnCompletion: options.triggerOnCompletion ?? false,
      timeoutSeconds,
      terminalPublicationGate: options.terminalPublicationGate,
      completionDeliveryGate: options.terminalPublicationGate,
      finalizationSettled: false,
      waiters: [],
    };
    this.tasks.set(id, task);

    const stream = createWriteStream(outputAbsPath, { flags: 'a', encoding: 'utf8' });
    task.stream = stream;
    stream.on('error', (error) => {
      task.error = `Output file write failed: ${error.message}`;
      if (task.status === 'running') {
        task.killKind = 'output_cap';
        try {
          this.requestKill(task, 'SIGTERM');
        } catch (killError) {
          this.finalizeTaskFromCallback(
            task,
            'failed',
            null,
            undefined,
            `${task.error}; kill failed: ${killError instanceof Error ? killError.message : String(killError)}`,
          );
        }
      }
    });

    try {
      const child = this.spawn(invocation.shell, invocation.args, {
        cwd: ctx.cwd,
        detached: this.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: this.env,
        windowsHide: true,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      });

      task.child = child;
      task.pid = child.pid;

      child.stdout?.on('data', (data) => {
        this.appendChildOutput(task, data, 'stdout');
      });
      child.stderr?.on('data', (data) => {
        this.appendChildOutput(task, data, 'stderr');
      });

      child.on('error', (error) => {
        this.writeNotice(task, `\n[background task spawn error: ${error.message}]\n`);
        this.finalizeTaskFromCallback(
          task,
          'failed',
          null,
          undefined,
          task.startupError ?? error.message,
        );
      });

      child.on('close', (code, signalName) => {
        let status: TaskStatus;
        let error: string | undefined;
        if (task.startupError !== undefined) {
          status = 'failed';
          error = task.startupError;
        } else if (task.killKind === 'user' || task.killKind === 'shutdown') {
          status = 'killed';
        } else if (task.killKind === 'timeout') {
          status = 'failed';
          error = task.error ?? `Timed out after ${String(timeoutSeconds)}s`;
        } else if (task.killKind === 'output_cap') {
          status = 'failed';
          error = task.error ?? `Output exceeded cap of ${formatSize(this.maxOutputBytes)}`;
        } else if ((code ?? 0) === 0) {
          status = 'completed';
        } else {
          status = 'failed';
          const exitCode = code === null ? 'null' : String(code);
          error = `Exited with code ${exitCode}${signalName ? ` (${signalName})` : ''}`;
        }
        this.finalizeTaskFromCallback(task, status, code, signalName, error);
      });

      if (timeoutSeconds !== undefined) {
        task.timeoutHandle = setTimeout(() => {
          if (task.status !== 'running') return;
          task.killKind = 'timeout';
          task.error = `Timed out after ${String(timeoutSeconds)}s`;
          this.writeNotice(task, `\n[background task timeout: ${task.error}]\n`);
          try {
            this.requestKill(task, 'SIGTERM');
          } catch (error) {
            this.finalizeTaskFromCallback(
              task,
              'failed',
              null,
              undefined,
              `${task.error}; kill failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }, timeoutSeconds * 1000);
      }

      await this.writeMetadata(task);
      this.onChange();
      return task;
    } catch (error) {
      return this.rejectFailedLaunch(
        task,
        error,
        'Failed to start background task',
        'background task spawn exception',
      );
    }
  }

  private async rejectFailedLaunch(
    task: BgTask,
    error: unknown,
    launchErrorPrefix: string,
    noticePrefix: string,
  ): Promise<never> {
    const message = BackgroundTaskRegistry.errorMessage(error);
    task.error = message;
    task.completionDeliveryGate = undefined;
    this.writeNotice(task, `\n[${noticePrefix}: ${message}]\n`);

    let cleanupFailure: unknown;
    try {
      if (task.child === undefined) {
        await this.finalizeTask(task, 'failed', null, undefined, message);
      } else {
        task.startupError = message;
        if (task.finalizationPromise === undefined) {
          await this.stopTask(task, 'user', message);
        } else {
          await this.waitForFinalization(task);
        }
      }
    } catch (cleanupError) {
      cleanupFailure = cleanupError;
      task.error = BackgroundTaskRegistry.appendTaskError(task.error, message);
    }

    const launchMessage = `${launchErrorPrefix}: ${message}`;
    if (cleanupFailure !== undefined) {
      throw new Error(
        `${launchMessage}; startup cleanup failed: ${BackgroundTaskRegistry.errorMessage(cleanupFailure)}`,
        { cause: error },
      );
    }
    throw new Error(launchMessage, { cause: error });
  }

  async registerExternalTask(
    ctx: BackgroundTaskContext,
    request: RegisterExternalTaskOptions,
  ): Promise<BgTask> {
    return this.ownLaunchOperation(
      'external',
      'Cannot register an external background task while Pi is shutting down',
      () => this.performRegisterExternalTask(ctx, request),
    );
  }

  private async performRegisterExternalTask(
    ctx: BackgroundTaskContext,
    request: RegisterExternalTaskOptions,
  ): Promise<BgTask> {
    const id = this.makeTaskIdFn();
    if (!/^[a-zA-Z0-9_.-]+$/u.test(id)) {
      throw new Error(`Generated external background task id is invalid: ${id}`);
    }
    if (this.tasks.has(id)) throw new Error(`Background task id already exists: ${id}`);

    const dir = await this.ensureRuntimeDir(ctx);
    const outputAbsPath = join(dir.abs, `${id}.output`);
    const metadataAbsPath = join(dir.abs, `${id}.json`);
    const outputPath = join(dir.display, `${id}.output`);
    const name = normalizeTaskName(request.name) ?? 'External background task';
    const task: BgTask = {
      id,
      name,
      command: request.description ?? name,
      description: request.description,
      status: 'running',
      outputPath,
      outputAbsPath,
      metadataAbsPath,
      cwd: ctx.cwd,
      startTime: this.now(),
      exitCode: undefined,
      pid: undefined,
      bytesWritten: 0,
      isAgent: false,
      notified: false,
      notifyOnCompletion: request.notifyOnCompletion,
      triggerOnCompletion: request.triggerOnCompletion,
      owner: { ...request.owner },
      capabilities: { ...request.capabilities },
      externalCancel: request.cancel,
      externalSequence: 1,
      externalStopWaitMs: request.stopWaitMs,
      terminalPublicationGate: request.terminalPublicationGate,
      completionDeliveryGate: request.terminalPublicationGate,
      finalizationSettled: false,
      waiters: [],
    };
    this.tasks.set(id, task);
    const stream = createWriteStream(outputAbsPath, { flags: 'a', encoding: 'utf8' });
    task.stream = stream;
    stream.on('error', (error) => {
      task.error = `Output file write failed: ${error.message}`;
      if (task.status === 'running' && task.externalCancelRequested !== true) {
        try {
          this.requestKill(task, 'SIGTERM');
        } catch (cancelError) {
          task.error = BackgroundTaskRegistry.appendTaskError(
            task.error,
            `cancellation failed: ${BackgroundTaskRegistry.errorMessage(cancelError)}`,
          );
        }
      }
    });

    try {
      await this.writeMetadata(task);
      this.onChange();
      return task;
    } catch (error) {
      this.tasks.delete(id);
      if (!stream.destroyed) stream.destroy();
      throw new Error(
        `Failed to register external background task: ${BackgroundTaskRegistry.errorMessage(error)}`,
      );
    }
  }

  async appendExternalLog(task: BgTask, text: string): Promise<void> {
    this.assertExternalRunning(task);
    this.writeNotice(task, text);
    await this.writeMetadata(task);
    this.onChange();
  }

  async updateExternalTask(task: BgTask, update: UpdateExternalTaskOptions): Promise<void> {
    this.assertExternalRunning(task);
    if (update.name !== undefined) task.name = normalizeTaskName(update.name) ?? task.name;
    if (update.description !== undefined) {
      task.description = update.description;
      task.command = update.description;
    }
    if (update.capabilities !== undefined) task.capabilities = { ...update.capabilities };
    if (update.line !== undefined) this.writeNotice(task, update.line);
    await this.writeMetadata(task);
    this.onChange();
  }

  acknowledgeExternalCancellation(task: BgTask, cancelId: string): void {
    this.assertExternalRunning(task);
    if (task.externalCancelId === undefined) {
      throw new Error(`Task ${task.id} has no cancellation request`);
    }
    if (task.externalCancelId !== cancelId) {
      throw new Error(`Task ${task.id} cancellation id mismatch`);
    }
    if (task.externalCancelAcknowledged === true) {
      throw new Error(`Task ${task.id} cancellation was already acknowledged`);
    }
    task.externalCancelAcknowledged = true;
  }

  settleExternalTask(
    task: BgTask,
    status: 'completed' | 'failed' | 'killed',
    error: string | undefined,
    terminalPublicationGate: Promise<void> | undefined,
  ): Promise<void> {
    this.assertExternalRunning(task);
    if (task.externalCancelRequested === true) {
      if (task.externalCancelAcknowledged !== true) {
        throw new Error(`Task ${task.id} cancellation must be acknowledged before settlement`);
      }
      if (status !== 'killed') {
        throw new Error(`Task ${task.id} cancellation settlement status must be killed`);
      }
    }
    task.terminalPublicationGate = combinePublicationGates(
      task.terminalPublicationGate,
      terminalPublicationGate,
    );
    const exitCode = status === 'completed' ? 0 : null;
    return this.finalizeTask(task, status, exitCode, undefined, error);
  }

  private assertExternalRunning(task: BgTask): void {
    if (task.owner === undefined || task.externalCancel === undefined) {
      throw new Error(`Task ${task.id} is not an external task`);
    }
    if (task.status !== 'running') {
      throw new Error(`Task ${task.id} is ${task.status}, not running`);
    }
  }

  private observeCallbackFinalization(task: BgTask, finalization: Promise<void>): void {
    void finalization.catch((error: unknown) => {
      this.logger.error(
        `[background-tasks] callback-owned finalization failed for ${task.id}:`,
        error,
      );
    });
  }

  private trackFinalization(task: BgTask, work: Promise<void>): Promise<void> {
    const tracked = work.then(
      () => {
        task.finalizationSettled = true;
        this.pruneOldTasks();
      },
      (error: unknown) => {
        task.finalizationSettled = true;
        this.pruneOldTasks();
        throw error;
      },
    );
    task.finalizationPromise = tracked;
    return tracked;
  }

  resolveTask(idOrPrefix: string): BgTask {
    const id = idOrPrefix.trim();
    if (!id) throw new Error('Task ID is required');
    const exact = this.tasks.get(id);
    if (exact) return exact;
    const matches = [...this.tasks.values()].filter((task) => task.id.startsWith(id));
    const onlyMatch = matches[0];
    if (matches.length === 1 && onlyMatch) return onlyMatch;
    if (matches.length > 1)
      throw new Error(
        `Ambiguous task ID prefix "${id}": ${matches.map((task) => task.id).join(', ')}`,
      );
    throw new Error(`Unknown background task ID: ${id}`);
  }

  stopTask(task: BgTask, kind: KillKind, reason?: string): Promise<BgTask> {
    if (task.stopPromise !== undefined) return task.stopPromise;
    if (task.finalizationPromise !== undefined) {
      return Promise.reject(
        new Error(
          `Task ${task.id} finalization is already in progress and is not running; cannot apply ${kind} stop`,
        ),
      );
    }
    if (task.status !== 'running') {
      return Promise.reject(new Error(`Task ${task.id} is ${task.status}, not running`));
    }

    if (task.stopIntentOwned !== true) {
      if (task.killKind === undefined) {
        task.killKind = kind;
        if (reason !== undefined) task.error = reason;
      }
      task.stopIntentOwned = true;
    }

    const stop = this.performStopTask(task);
    task.stopPromise = stop;
    void stop.then(
      () => {
        if (task.stopPromise === stop) task.stopPromise = undefined;
      },
      () => {
        if (task.stopPromise === stop) task.stopPromise = undefined;
      },
    );
    return stop;
  }

  private async performStopTask(task: BgTask): Promise<BgTask> {
    try {
      const previousWindowsState = this.windowsKillStates.get(task);
      if (previousWindowsState !== undefined) {
        await this.retireWindowsKillState(task, previousWindowsState);
        if (task.finalizationPromise !== undefined) {
          throw new Error(`Task ${task.id} entered finalization before termination retry`);
        }
        if (task.status !== 'running') {
          throw new Error(`Task ${task.id} is ${task.status}, not running`);
        }
      } else {
        this.clearKillEscalationTimer(task);
      }
      task.killSignalSent = false;
      this.requestKill(task, 'SIGTERM');
      const stopWaitMs = task.externalStopWaitMs ?? this.stopWaitMs;
      const stopped =
        this.platform === 'win32' && task.externalCancel === undefined
          ? await this.waitForEndOrWindowsForceFailure(task, stopWaitMs)
          : await this.waitForEnd(task, stopWaitMs);
      const forceFailure = this.windowsKillStates.get(task)?.forceFailure;
      if (forceFailure !== undefined) throw forceFailure;
      if (!stopped) {
        throw new Error(
          `Task ${task.id} did not exit within ${formatDuration(stopWaitMs)} after cancellation; the first stop intent remains authoritative`,
        );
      }
      await this.waitForFinalization(task);
      return task;
    } catch (error) {
      if (task.status === 'running' && task.finalizationPromise === undefined) {
        this.clearKillEscalationTimer(task);
        const windowsState = this.windowsKillStates.get(task);
        if (windowsState !== undefined) await this.retireWindowsKillState(task, windowsState);
        task.killSignalSent = false;
      }
      throw error;
    }
  }

  /** Await phase B after a task has entered its once-only finalizer. */
  waitForFinalization(task: BgTask): Promise<void> {
    const finalization = task.finalizationPromise;
    if (finalization !== undefined) return finalization;
    if (task.status === 'running') {
      throw new Error(`Task ${task.id} has not entered finalization`);
    }
    throw new Error(
      `Task ${task.id} is terminal without an assigned finalization promise`,
    );
  }

  /** Drain every terminal EventBus publication currently owned by the registry. */
  async waitForTerminalPublications(): Promise<void> {
    while (this.terminalPublications.size > 0) {
      await Promise.all([...this.terminalPublications]);
    }
  }

  async stopAllRunning(
    kind: KillKind,
    reason?: string,
  ): Promise<{ stopped: number; failures: string[] }> {
    const running = this.allTasks().filter((task) => task.status === 'running');
    const failures: string[] = [];
    let stopped = 0;
    await Promise.all(
      running.map(async (task) => {
        try {
          await this.stopTask(task, kind, reason);
          stopped++;
        } catch (error) {
          failures.push(
            `${taskDisplayName(task)} (${task.id}): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
    return { stopped, failures };
  }

  async getTaskLogs(
    task: BgTask,
    maxBytes: number,
    tail: boolean,
  ): Promise<{ text: string; details: BgLogsDetails }> {
    if (!existsSync(task.outputAbsPath)) {
      throw new Error(`Output file does not exist for ${task.id}: ${task.outputPath}`);
    }
    const read = await boundedRead(task.outputAbsPath, maxBytes, tail);
    const direction = tail ? 'tail' : 'head';
    let text = read.content.length > 0 ? read.content : '(no output yet)';
    if (read.truncated) {
      const omitted = read.totalBytes - read.bytesRead;
      const notice = `\n\n[Showing ${direction} ${formatSize(read.bytesRead)} of ${formatSize(read.totalBytes)}; ${formatSize(omitted)} omitted. Full output: ${task.outputPath}]`;
      text = tail ? `${notice}\n\n${text}` : `${text}${notice}`;
    } else {
      text += `\n\n[Full output: ${task.outputPath}]`;
    }
    return {
      text,
      details: {
        task: snapshot(task),
        path: task.outputPath,
        bytesRead: read.bytesRead,
        truncated: read.truncated,
        tail,
      },
    };
  }

  private async writeMetadata(task: BgTask): Promise<void> {
    await this.writeMetadataSnapshot(task, snapshot(task));
  }

  private async writeMetadataSnapshot(task: BgTask, value: BgTaskSnapshot): Promise<void> {
    const write = async () => {
      await this.writeJsonAtomic(task.metadataAbsPath, value);
    };
    const previous = task.metadataWriteChain ?? Promise.resolve();
    const next = previous.then(write, write);
    task.metadataWriteChain = next.catch(() => undefined);
    await next;
  }

  /** Cap-enforcing sink for all persisted task output; terminates the task once the byte cap is exceeded. */
  private writeToStream(task: BgTask, buffer: Buffer): void {
    if (!task.stream || task.stream.destroyed) return;
    if (buffer.length === 0) return;

    const nextBytes = task.bytesWritten + buffer.length;
    if (nextBytes <= this.maxOutputBytes) {
      task.stream.write(buffer);
      task.bytesWritten = nextBytes;
      return;
    }

    const remaining = Math.max(0, this.maxOutputBytes - task.bytesWritten);
    if (remaining > 0) {
      task.stream.write(buffer.subarray(0, remaining));
      task.bytesWritten += remaining;
    }

    if (!task.capExceeded) {
      task.capExceeded = true;
      task.error = `Output exceeded cap of ${formatSize(this.maxOutputBytes)}; terminating task`;
      const notice = `\n\n[background task error: ${task.error}]\n`;
      task.stream.write(notice);
      task.bytesWritten += Buffer.byteLength(notice, 'utf8');
      task.killKind = 'output_cap';
      try {
        this.requestKill(task, 'SIGTERM');
      } catch (error) {
        task.error = `${task.error}; kill failed: ${error instanceof Error ? error.message : String(error)}`;
        this.finalizeTaskFromCallback(task, 'failed', null, undefined, task.error);
      }
    }
  }

  /** Persist an internally generated notice (spawn/timeout/cap diagnostics) verbatim. */
  private writeNotice(task: BgTask, text: string): void {
    if (!text) return;
    this.writeToStream(task, Buffer.from(text, 'utf8'));
  }

  private appendChildOutput(
    task: BgTask,
    data: Buffer | string,
    _source: 'stdout' | 'stderr',
  ): void {
    if (task.stream === undefined || task.stream.destroyed) return;
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    this.writeToStream(task, buffer);
  }

  private getWindowsKillState(task: BgTask): WindowsKillState {
    let state = this.windowsKillStates.get(task);
    if (state === undefined) {
      state = {};
      this.windowsKillStates.set(task, state);
    }
    return state;
  }

  private static errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private static appendTaskError(existing: string | undefined, next: string): string {
    if (existing === undefined || existing.length === 0) return next;
    if (existing.includes(next)) return existing;
    return `${existing}; ${next}`;
  }

  private static describeTaskkillOutcome(outcome: TaskkillOutcome): string {
    const exitCode = outcome.exitCode === null ? 'null' : String(outcome.exitCode);
    const signal = outcome.signal === null ? 'null' : outcome.signal;
    const stdout = outcome.stdout.length > 0 ? ` stdout=${JSON.stringify(outcome.stdout)}` : '';
    const stderr = outcome.stderr.length > 0 ? ` stderr=${JSON.stringify(outcome.stderr)}` : '';
    const stdoutTruncated = outcome.stdoutTruncated ? ' stdout_truncated=true' : '';
    const stderrTruncated = outcome.stderrTruncated ? ' stderr_truncated=true' : '';
    return `exit=${exitCode} signal=${signal}${stdout}${stderr}${stdoutTruncated}${stderrTruncated}`;
  }

  private isWindowsTaskkillTerminalRace(task: BgTask): boolean {
    return task.status !== 'running' || task.finalized === true;
  }

  private clearKillEscalationTimer(task: BgTask): void {
    if (task.killEscalationTimer !== undefined) {
      clearTimeout(task.killEscalationTimer);
      task.killEscalationTimer = undefined;
    }
  }

  private recordWindowsTaskkillNotice(task: BgTask, message: string): void {
    this.writeNotice(task, `\n[background task Windows termination: ${message}]\n`);
  }

  private recordWindowsSoftFailure(task: BgTask, pid: number, detail: string): void {
    const message =
      `Windows taskkill /T logical termination request failed for task ${task.id} pid ${String(pid)}: ` +
      `${detail}; force escalation remains scheduled`;
    task.error = BackgroundTaskRegistry.appendTaskError(task.error, message);
    this.recordWindowsTaskkillNotice(task, message);
    this.onChange();
    void this.writeMetadata(task).catch((metadataError: unknown) => {
      this.logger.error(
        `[background-tasks] failed to write Windows taskkill soft-failure metadata for ${task.id}:`,
        metadataError,
      );
    });
  }

  private makeWindowsForceFailure(task: BgTask, pid: number, detail: string): Error {
    return new Error(
      `Windows taskkill /T /F force termination failed for task ${task.id} pid ${String(pid)}: ${detail}. Descendant processes may have leaked.`,
    );
  }

  private recordWindowsForceFailure(task: BgTask, error: Error): void {
    const state = this.getWindowsKillState(task);
    state.forceFailure = error;
    task.error = BackgroundTaskRegistry.appendTaskError(task.error, error.message);
    this.recordWindowsTaskkillNotice(task, error.message);
    this.onChange();
    void this.writeMetadata(task).catch((metadataError: unknown) => {
      this.logger.error(
        `[background-tasks] failed to write Windows taskkill force-failure metadata for ${task.id}:`,
        metadataError,
      );
    });
    const listeners = state.forceFailureListeners;
    if (listeners !== undefined) {
      delete state.forceFailureListeners;
      for (const listener of listeners) listener(error);
    }
  }

  private evaluateWindowsTaskkillOutcome(
    task: BgTask,
    pid: number,
    phase: WindowsKillPhase,
    outcome: TaskkillOutcome,
  ): Error | undefined {
    if (outcome.exitCode === 0) return undefined;
    const detail = BackgroundTaskRegistry.describeTaskkillOutcome(outcome);
    if (outcome.exitCode === 128) {
      this.recordWindowsTaskkillNotice(
        task,
        `taskkill ${phase} reported process not found for pid ${String(pid)} (${detail}); treating as an already-exited race`,
      );
      return undefined;
    }
    if (this.isWindowsTaskkillTerminalRace(task)) {
      this.recordWindowsTaskkillNotice(
        task,
        `taskkill ${phase} finished after the task became terminal for pid ${String(pid)} (${detail}); treating as a terminal race`,
      );
      return undefined;
    }
    if (phase === 'terminate') {
      this.recordWindowsSoftFailure(task, pid, detail);
      return undefined;
    }
    return this.makeWindowsForceFailure(task, pid, detail);
  }

  private handleWindowsSoftException(
    task: BgTask,
    pid: number,
    error: unknown,
    state: WindowsKillState,
  ): void {
    const message = BackgroundTaskRegistry.errorMessage(error);
    if (
      state.retiring === true ||
      state.forcePromise !== undefined ||
      this.isWindowsTaskkillTerminalRace(task)
    )
      return;
    this.recordWindowsSoftFailure(task, pid, message);
  }

  private async retireWindowsKillState(task: BgTask, state: WindowsKillState): Promise<void> {
    state.retiring = true;
    this.clearKillEscalationTimer(task);
    state.softController?.abort();
    state.forceController?.abort();
    const settlements: Promise<void>[] = [];
    if (state.softPromise !== undefined) settlements.push(state.softPromise);
    if (state.forcePromise !== undefined) settlements.push(state.forcePromise);
    await Promise.allSettled(settlements);
    if (this.windowsKillStates.get(task) === state) this.windowsKillStates.delete(task);
  }

  private startWindowsSoftKill(task: BgTask, pid: number): Promise<void> {
    const state = this.getWindowsKillState(task);
    if (state.softPromise !== undefined) return state.softPromise;
    const controller = new AbortController();
    state.softController = controller;

    let launched: Promise<TaskkillOutcome>;
    try {
      launched = this.killTree(pid, 'terminate', controller.signal);
    } catch (error) {
      delete state.softController;
      throw new Error(
        `Could not kill task ${task.id}: Windows taskkill /T failed to start: ${BackgroundTaskRegistry.errorMessage(error)}`,
      );
    }

    const promise = launched
      .then((outcome) => {
        if (state.forcePromise !== undefined || this.isWindowsTaskkillTerminalRace(task)) return;
        const failure = this.evaluateWindowsTaskkillOutcome(task, pid, 'terminate', outcome);
        if (failure !== undefined) throw failure;
      })
      .catch((error: unknown) => {
        this.handleWindowsSoftException(task, pid, error, state);
      })
      .finally(() => {
        if (state.softController === controller) delete state.softController;
      });
    state.softPromise = promise;
    return promise;
  }

  private startWindowsForceKill(task: BgTask, pid: number): Promise<void> {
    const state = this.getWindowsKillState(task);
    if (state.forcePromise !== undefined) return state.forcePromise;

    let resolveForce: (() => void) | undefined;
    let rejectForce: ((error: unknown) => void) | undefined;
    const forcePromise = new Promise<void>((resolve, reject) => {
      resolveForce = resolve;
      rejectForce = reject;
    });
    if (resolveForce === undefined || rejectForce === undefined) {
      throw new Error('Windows force termination promise could not be initialized');
    }
    const resolveForceReady = resolveForce;
    const rejectForceReady = rejectForce;
    state.forcePromise = forcePromise;
    void forcePromise.catch((error: unknown) => {
      this.logger.error(
        `[background-tasks] Windows force tree termination failed for ${task.id}:`,
        error,
      );
    });

    this.clearKillEscalationTimer(task);
    state.softController?.abort();
    const controller = new AbortController();
    state.forceController = controller;

    let launched: Promise<TaskkillOutcome>;
    try {
      launched = this.killTree(pid, 'force', controller.signal);
    } catch (error) {
      delete state.forceController;
      const failure = this.makeWindowsForceFailure(
        task,
        pid,
        `helper failed to start: ${BackgroundTaskRegistry.errorMessage(error)}`,
      );
      delete state.forcePromise;
      this.recordWindowsForceFailure(task, failure);
      rejectForceReady(failure);
      throw failure;
    }

    launched.then(
      (outcome) => {
        if (state.forceController === controller) delete state.forceController;
        if (state.retiring === true) {
          resolveForceReady();
          return;
        }
        const failure = this.evaluateWindowsTaskkillOutcome(task, pid, 'force', outcome);
        if (failure !== undefined) {
          this.recordWindowsForceFailure(task, failure);
          rejectForceReady(failure);
          return;
        }
        resolveForceReady();
      },
      (error: unknown) => {
        if (state.forceController === controller) delete state.forceController;
        if (state.retiring === true) {
          resolveForceReady();
          return;
        }
        if (this.isWindowsTaskkillTerminalRace(task)) {
          this.recordWindowsTaskkillNotice(
            task,
            `taskkill force rejected after the task became terminal for pid ${String(pid)} (${BackgroundTaskRegistry.errorMessage(error)}); treating as a terminal race`,
          );
          resolveForceReady();
          return;
        }
        const failure = this.makeWindowsForceFailure(
          task,
          pid,
          BackgroundTaskRegistry.errorMessage(error),
        );
        this.recordWindowsForceFailure(task, failure);
        rejectForceReady(failure);
      },
    );

    return forcePromise;
  }

  private requestWindowsKill(task: BgTask, pid: number, signal: NodeJS.Signals): void {
    if (signal === 'SIGKILL') {
      this.startWindowsForceKill(task, pid);
      task.killSignalSent = true;
      return;
    }

    this.startWindowsSoftKill(task, pid);
    task.killSignalSent = true;
    if (task.killEscalationTimer !== undefined) return;
    task.killEscalationTimer = setTimeout(() => {
      task.killEscalationTimer = undefined;
      if (task.status !== 'running') return;
      try {
        this.requestKill(task, 'SIGKILL');
      } catch (error) {
        task.error = BackgroundTaskRegistry.appendTaskError(
          task.error,
          `SIGKILL failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        void this.writeMetadata(task).catch((metadataError: unknown) => {
          this.logger.error(
            `[background-tasks] failed to write metadata for ${task.id}:`,
            metadataError,
          );
        });
      }
    }, this.killGraceMs).unref();
  }

  private requestKill(task: BgTask, signal: NodeJS.Signals = 'SIGTERM'): void {
    if (task.status !== 'running') {
      throw new Error(`Task ${task.id} is ${task.status}, not running`);
    }
    if (task.externalCancel !== undefined) {
      if (task.externalCancelRequested === true) return;
      task.externalCancelRequested = true;
      task.externalCancelId = randomBytes(12).toString('hex');
      try {
        task.externalCancel();
      } catch (error) {
        throw new Error(
          `Could not cancel external task ${task.id}: ${BackgroundTaskRegistry.errorMessage(error)}`,
        );
      }
      task.killSignalSent = true;
      return;
    }
    if (!task.child) {
      throw new Error(`Task ${task.id} has no child process handle`);
    }
    if (!task.pid) {
      throw new Error(`Task ${task.id} has no process id`);
    }
    if (task.killSignalSent && signal === 'SIGTERM') return;

    if (this.platform === 'win32') {
      this.requestWindowsKill(task, task.pid, signal);
      return;
    }

    const errors: string[] = [];
    let killed = false;

    try {
      this.killProcess(-task.pid, signal);
      killed = true;
    } catch (error) {
      errors.push(
        `process group kill failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!killed) {
      try {
        task.child.kill(signal);
        killed = true;
      } catch (error) {
        errors.push(`child kill failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (!killed) {
      throw new Error(`Could not kill task ${task.id}: ${errors.join('; ')}`);
    }

    task.killSignalSent = true;
    // SIGKILL is the terminal escalation; it must never schedule a further one.
    if (signal === 'SIGKILL') return;
    // Only one escalation timer may be outstanding. Concurrent stop requests
    // previously each scheduled their own, producing duplicate SIGKILLs.
    if (task.killEscalationTimer !== undefined) return;
    task.killEscalationTimer = setTimeout(() => {
      task.killEscalationTimer = undefined;
      if (task.status !== 'running') return;
      try {
        this.requestKill(task, 'SIGKILL');
      } catch (error) {
        task.error = `SIGKILL failed: ${error instanceof Error ? error.message : String(error)}`;
        void this.writeMetadata(task).catch((metadataError: unknown) => {
          this.logger.error(
            `[background-tasks] failed to write metadata for ${task.id}:`,
            metadataError,
          );
        });
      }
    }, this.killGraceMs).unref();
  }

  private waitForEnd(task: BgTask, timeoutMs: number): Promise<boolean> {
    if (task.status !== 'running') return Promise.resolve(true);
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        const idx = task.waiters.indexOf(done);
        if (idx >= 0) task.waiters.splice(idx, 1);
        resolve(false);
      }, timeoutMs);
      const done = () => {
        clearTimeout(timeout);
        resolve(true);
      };
      task.waiters.push(done);
    });
  }

  private waitForEndOrWindowsForceFailure(task: BgTask, timeoutMs: number): Promise<boolean> {
    const state = this.getWindowsKillState(task);
    if (state.forceFailure !== undefined) return Promise.reject(state.forceFailure);
    if (task.status !== 'running') return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        const waiterIndex = task.waiters.indexOf(done);
        if (waiterIndex >= 0) task.waiters.splice(waiterIndex, 1);
        const listeners = state.forceFailureListeners;
        if (listeners !== undefined) {
          const listenerIndex = listeners.indexOf(failed);
          if (listenerIndex >= 0) listeners.splice(listenerIndex, 1);
          if (listeners.length === 0) delete state.forceFailureListeners;
        }
      };
      const timeout = setTimeout(() => {
        cleanup();
        resolve(false);
      }, timeoutMs);
      const done = () => {
        cleanup();
        resolve(true);
      };
      const failed = (error: Error) => {
        cleanup();
        reject(error);
      };
      task.waiters.push(done);
      if (state.forceFailureListeners === undefined) state.forceFailureListeners = [];
      state.forceFailureListeners.push(failed);
    });
  }

  private async awaitWindowsForceBeforeTerminal(task: BgTask): Promise<Error | undefined> {
    const state = this.windowsKillStates.get(task);
    if (state === undefined) return undefined;
    const forcePromise = state.forcePromise;
    if (forcePromise === undefined) return state.forceFailure;
    try {
      await forcePromise;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
    return state.forceFailure;
  }

  private publishTerminal(task: BgTask): void {
    if (task.terminalPublicationPromise !== undefined) return;
    const publication = Promise.resolve(task.terminalPublicationGate).then(() => {
      this.publishTerminalSnapshot(snapshot(task));
      task.terminalPublished = true;
      this.pruneOldTasks();
    });
    task.terminalPublicationPromise = publication;
    this.terminalPublications.add(publication);
    void publication.then(
      () => {
        this.terminalPublications.delete(publication);
      },
      (error: unknown) => {
        this.logger.error(`[background-tasks] terminal publication failed for ${task.id}:`, error);
      },
    );
  }

  private notifyCompletion(task: BgTask): void {
    if (!task.notifyOnCompletion || task.notified || this.shuttingDown) return;
    task.notified = true;
    const exit =
      task.exitCode === undefined ? '' : `\n  <exit-code>${String(task.exitCode)}</exit-code>`;
    const error = task.error ? `\n  <error>${escapeXml(task.error)}</error>` : '';
    const taskName = taskDisplayName(task);
    const guidance =
      'Terminal state and output metadata are durable. Do not call bg_status to reconfirm; use bg_logs only if output is needed.';
    const content = [
      '<background-task-notification>',
      `  <task-id>${task.id}</task-id>`,
      `  <task-name>${escapeXml(taskName)}</task-name>`,
      `  <status>${task.status}</status>`,
      exit,
      error,
      `  <output-file>${escapeXml(task.outputPath)}</output-file>`,
      `  <summary>${escapeXml(`Background task ${JSON.stringify(taskName)} ${task.status}`)}</summary>`,
      `  <guidance>${escapeXml(guidance)}</guidance>`,
      '</background-task-notification>',
    ]
      .filter(Boolean)
      .join('\n');

    try {
      this.sendCompletionNotification(
        {
          customType: 'background-task-notification',
          content,
          display: true,
          details: snapshot(task),
        },
        { deliverAs: 'followUp', triggerTurn: task.triggerOnCompletion },
      );
    } catch (error) {
      task.notified = false;
      throw new Error(
        `Failed to send background task notification for ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private finalizeTaskFromCallback(
    task: BgTask,
    status: TaskStatus,
    exitCode: number | null,
    signal?: string | null,
    error?: string,
  ): void {
    this.observeCallbackFinalization(
      task,
      this.finalizeTask(task, status, exitCode, signal, error),
    );
  }

  private finalizeTask(
    task: BgTask,
    status: TaskStatus,
    exitCode: number | null,
    signal?: string | null,
    error?: string,
  ): Promise<void> {
    if (task.finalizationPromise !== undefined) return task.finalizationPromise;
    return this.trackFinalization(
      task,
      this.performTaskFinalization(task, status, exitCode, signal, error),
    );
  }

  private async performTaskFinalization(
    task: BgTask,
    status: TaskStatus,
    exitCode: number | null,
    signal?: string | null,
    error?: string,
  ): Promise<void> {
    task.finalized = true;
    if (task.timeoutHandle) clearTimeout(task.timeoutHandle);
    if (task.killEscalationTimer !== undefined) {
      clearTimeout(task.killEscalationTimer);
      task.killEscalationTimer = undefined;
    }
    let finalStatus = status;
    let finalError = error;
    const forceFailure = await this.awaitWindowsForceBeforeTerminal(task);
    if (forceFailure !== undefined) {
      finalStatus = 'failed';
      finalError = BackgroundTaskRegistry.appendTaskError(finalError, forceFailure.message);
    }
    task.exitCode = exitCode;
    task.signal = signal ?? null;

    try {
      if (task.stream && !task.stream.destroyed) await closeOutputStream(task.stream);
    } catch (finalizeError) {
      finalStatus = 'failed';
      const message =
        finalizeError instanceof Error ? finalizeError.message : String(finalizeError);
      finalError = finalError
        ? `${finalError}; final output durability failed: ${message}`
        : `Final output durability failed: ${message}`;
    }

    if (task.startupError !== undefined) {
      finalStatus = 'failed';
      finalError = task.startupError;
    }
    task.endTime = this.now();
    if (finalError) task.error = finalError;
    try {
      await this.writeMetadataSnapshot(task, { ...snapshot(task), status: finalStatus });
      task.status = finalStatus;
    } catch (metadataError) {
      finalStatus = 'failed';
      task.status = 'failed';
      task.error = BackgroundTaskRegistry.appendTaskError(
        task.error,
        `Terminal metadata write failed: ${metadataError instanceof Error ? metadataError.message : String(metadataError)}`,
      );
      this.logger.error(
        `[background-tasks] failed to write metadata for ${task.id}:`,
        metadataError,
      );
      await this.writeMetadata(task).catch((retryError: unknown) => {
        this.logger.error(
          `[background-tasks] failed to write failed terminal metadata for ${task.id}:`,
          retryError,
        );
      });
    }

    for (const waiter of task.waiters.splice(0)) waiter();
    this.onChange();
    this.publishTerminal(task);
    let deliveryGateReady = true;
    if (task.completionDeliveryGate !== undefined) {
      try {
        await task.completionDeliveryGate;
      } catch (error) {
        deliveryGateReady = false;
        this.logger.error(
          `[background-tasks] completion delivery gate failed for ${task.id}:`,
          error,
        );
      }
    }
    if (deliveryGateReady) {
      try {
        this.notifyCompletion(task);
      } catch (notificationError) {
        this.logger.error(
          `[background-tasks] notification failed for ${task.id}:`,
          notificationError,
        );
      }
    }
    try {
      await this.writeMetadata(task);
    } catch (metadataError) {
      this.logger.error(
        `[background-tasks] failed to update notification metadata for ${task.id}:`,
        metadataError,
      );
    }
  }

  private pruneOldTasks(): void {
    if (this.tasks.size <= this.maxRecentTasks) return;
    const removable = [...this.tasks.values()]
      .filter(
        (task) => task.finalizationSettled === true && task.terminalPublished === true,
      )
      .sort((a, b) => (a.endTime ?? a.startTime) - (b.endTime ?? b.startTime));
    while (this.tasks.size > this.maxRecentTasks && removable.length > 0) {
      const task = removable.shift();
      if (task) this.tasks.delete(task.id);
    }
  }
}

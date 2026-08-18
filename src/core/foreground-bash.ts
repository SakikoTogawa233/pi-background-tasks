import { spawn as nodeSpawn, type SpawnOptions } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  createBashTool,
  formatSize,
  truncateTail,
  type BashToolDetails,
  type BashToolInput,
  type ExtensionAPI,
  type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import type { KeyId } from '@earendil-works/pi-tui';

export const DEFAULT_AUTO_BACKGROUND_TIMEOUT_MS = 120_000;
export const FAST_PATH_GRACE_MS = 2_000;
export const BACKGROUND_HINT_DELAY_MS = 2_000;

const MAX_TIMEOUT_MS = 2_147_483_647;
const FOREGROUND_BACKGROUND_MESSAGE_TYPE = 'foreground-bash-backgrounded';

type BackgroundReason = 'manual' | 'timeout';
type InvocationStatus = 'foreground' | 'backgrounding' | 'aborting' | 'timeout-killing' | 'settled';

interface ForegroundBashOutputStream {
  on(event: 'data', listener: (data: Buffer | string) => void): unknown;
  removeListener(event: 'data', listener: (data: Buffer | string) => void): unknown;
}

export interface ForegroundBashChildProcess {
  readonly pid: number;
  readonly stdout: ForegroundBashOutputStream;
  readonly stderr: ForegroundBashOutputStream;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'error', listener: (error: Error) => void): unknown;
  on(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  removeListener(event: 'error', listener: (error: Error) => void): unknown;
  removeListener(
    event: 'close',
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
}

export interface ForegroundBashSpawnOptions extends Record<string, unknown> {
  cwd: string;
  detached: true;
  env: NodeJS.ProcessEnv;
  stdio: ['ignore', 'pipe', 'pipe'];
  windowsHide: true;
}

export interface ForegroundBashExecutionContext {
  toolCallId: string;
  cwd: string;
  env?: NodeJS.ProcessEnv | undefined;
  nonInteractive?: boolean | undefined;
  extensionContext?: ExtensionContext | undefined;
}

export interface ForegroundBashAdoptInput {
  child: ForegroundBashChildProcess;
  command: string;
  outputPath: string;
  startedAt: number;
  context: ForegroundBashExecutionContext;
  notifyOnCompletion: true;
  triggerOnCompletion: true;
  name?: string | undefined;
}

export interface ForegroundBashAdoptResult {
  taskId: string;
}

export interface ForegroundBashBackgroundedDetails {
  taskId: string;
  command: string;
  outputPath: string;
  reason: BackgroundReason;
  timeoutSeconds: number;
}

export interface ForegroundBashMessage {
  customType: typeof FOREGROUND_BACKGROUND_MESSAGE_TYPE;
  content: string;
  display: true;
  details: ForegroundBashBackgroundedDetails;
}

export interface ForegroundBashToolResult {
  content: [{ type: 'text'; text: string }];
  details: BashToolDetails | undefined;
}

export interface ForegroundBashExecutorDeps {
  spawn?: (
    file: string,
    args: string[],
    options: ForegroundBashSpawnOptions,
  ) => ForegroundBashChildProcess;
  adoptTask(input: ForegroundBashAdoptInput): ForegroundBashAdoptResult;
  sendMessage(
    message: ForegroundBashMessage,
    options: { deliverAs: 'followUp'; triggerTurn: true },
  ): void;
  outputPathForCall(toolCallId: string, sequence: number): string;
  killProcessGroup(pid: number, signal: NodeJS.Signals): void | Promise<void>;
  notify?: (
    text: string,
    level: 'info' | 'warning' | 'error',
    context: ForegroundBashExecutionContext,
  ) => void;
  nonInteractive?: boolean | ((context: ForegroundBashExecutionContext) => boolean) | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  now?: (() => number) | undefined;
}

export interface ForegroundBashController {
  execute(
    params: BashToolInput,
    context: ForegroundBashExecutionContext,
    signal?: AbortSignal,
    onUpdate?: (result: ForegroundBashToolResult) => void,
  ): Promise<ForegroundBashToolResult>;
  triggerBackground(): boolean;
  hasForegroundProcess(): boolean;
}

interface ActiveInvocation {
  readonly sequence: number;
  readonly command: string;
  readonly context: ForegroundBashExecutionContext;
  readonly child: ForegroundBashChildProcess;
  readonly outputPath: string;
  readonly outputAbsPath: string;
  readonly startedAt: number;
  readonly timeoutMs: number;
  readonly timeoutSeconds: number;
  readonly nonInteractive: boolean;
  readonly signal: AbortSignal | undefined;
  readonly onUpdate: ((result: ForegroundBashToolResult) => void) | undefined;
  readonly resolve: (result: ForegroundBashToolResult) => void;
  readonly reject: (error: Error) => void;
  status: InvocationStatus;
  output: string;
  streamingEnabled: boolean;
  graceTimer: NodeJS.Timeout | undefined;
  hintTimer: NodeJS.Timeout | undefined;
  timeoutTimer: NodeJS.Timeout | undefined;
  abortListener: (() => void) | undefined;
  stdoutListener: (data: Buffer | string) => void;
  stderrListener: (data: Buffer | string) => void;
  errorListener: (error: Error) => void;
  closeListener: (code: number | null, signalName: NodeJS.Signals | null) => void;
}

export function isAutoBackgroundAllowed(command: string): boolean {
  return !/^\s*sleep(?:\s|$)/u.test(command);
}

export function detectBlockedSleep(command: string): string | undefined {
  const match = /^\s*sleep\s+([0-9]+(?:\.[0-9]+)?)(?=\s*(?:$|&&|&|;|\|))/u.exec(command);
  if (!match?.[1]) return undefined;
  const seconds = Number(match[1]);
  return seconds >= 2 ? `sleep ${match[1]}` : undefined;
}

function timeoutMsFor(params: BashToolInput): number {
  if (params.timeout === undefined) return DEFAULT_AUTO_BACKGROUND_TIMEOUT_MS;
  if (!Number.isFinite(params.timeout) || params.timeout <= 0) {
    throw new Error('Invalid timeout: must be a finite number of seconds');
  }
  const timeoutMs = params.timeout * 1000;
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(`Invalid timeout: maximum is ${String(MAX_TIMEOUT_MS / 1000)} seconds`);
  }
  return timeoutMs;
}

function textResult(text: string, details?: BashToolDetails): ForegroundBashToolResult {
  return { content: [{ type: 'text', text }], details };
}

function formattedOutput(
  output: string,
  outputPath: string,
  emptyText: string,
): ForegroundBashToolResult {
  const truncation = truncateTail(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  let text = truncation.content || emptyText;
  if (!truncation.truncated) return textResult(text);

  const startLine = truncation.totalLines - truncation.outputLines + 1;
  const endLine = truncation.totalLines;
  if (truncation.lastLinePartial) {
    text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${String(endLine)}. Full output: ${outputPath}]`;
  } else if (truncation.truncatedBy === 'lines') {
    text += `\n\n[Showing lines ${String(startLine)}-${String(endLine)} of ${String(truncation.totalLines)}. Full output: ${outputPath}]`;
  } else {
    text += `\n\n[Showing lines ${String(startLine)}-${String(endLine)} of ${String(truncation.totalLines)} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${outputPath}]`;
  }
  return textResult(text, { truncation, fullOutputPath: outputPath });
}

function appendStatus(result: ForegroundBashToolResult, status: string): ForegroundBashToolResult {
  const output = result.content[0].text;
  const text = `${output ? `${output}\n\n` : ''}${status}`;
  return result.details === undefined ? textResult(text) : textResult(text, result.details);
}

function isNonInteractive(
  deps: ForegroundBashExecutorDeps,
  context: ForegroundBashExecutionContext,
): boolean {
  if (context.nonInteractive !== undefined) return context.nonInteractive;
  if (typeof deps.nonInteractive === 'function') return deps.nonInteractive(context);
  return deps.nonInteractive ?? false;
}

function defaultSpawn(
  file: string,
  args: string[],
  options: ForegroundBashSpawnOptions,
): ForegroundBashChildProcess {
  return nodeSpawn(file, args, options as SpawnOptions) as ForegroundBashChildProcess;
}

export function createForegroundBashExecutor(
  deps: ForegroundBashExecutorDeps,
): ForegroundBashController {
  const spawn = deps.spawn ?? defaultSpawn;
  const now = deps.now ?? Date.now;
  const invocations = new Map<string, ActiveInvocation>();
  let sequence = 0;

  const clearTimers = (invocation: ActiveInvocation): void => {
    if (invocation.graceTimer !== undefined) clearTimeout(invocation.graceTimer);
    if (invocation.hintTimer !== undefined) clearTimeout(invocation.hintTimer);
    if (invocation.timeoutTimer !== undefined) clearTimeout(invocation.timeoutTimer);
    invocation.graceTimer = undefined;
    invocation.hintTimer = undefined;
    invocation.timeoutTimer = undefined;
  };

  const removeAbortListener = (invocation: ActiveInvocation): void => {
    if (invocation.signal !== undefined && invocation.abortListener !== undefined) {
      invocation.signal.removeEventListener('abort', invocation.abortListener);
    }
    invocation.abortListener = undefined;
  };

  const removeChildListeners = (invocation: ActiveInvocation): void => {
    invocation.child.removeListener('error', invocation.errorListener);
    invocation.child.removeListener('close', invocation.closeListener);
    invocation.child.stdout.removeListener('data', invocation.stdoutListener);
    invocation.child.stderr.removeListener('data', invocation.stderrListener);
  };

  const cleanup = (invocation: ActiveInvocation): void => {
    clearTimers(invocation);
    removeAbortListener(invocation);
    removeChildListeners(invocation);
    invocations.delete(invocation.context.toolCallId);
  };

  const settleResult = (invocation: ActiveInvocation, result: ForegroundBashToolResult): void => {
    if (invocation.status === 'settled') return;
    invocation.status = 'settled';
    cleanup(invocation);
    invocation.resolve(result);
  };

  const settleError = (invocation: ActiveInvocation, error: Error): void => {
    if (invocation.status === 'settled') return;
    invocation.status = 'settled';
    cleanup(invocation);
    invocation.reject(error);
  };

  const emitUpdate = (invocation: ActiveInvocation): void => {
    if (invocation.onUpdate === undefined) return;
    invocation.onUpdate(formattedOutput(invocation.output, invocation.outputPath, ''));
  };

  const appendOutput = (invocation: ActiveInvocation, data: Buffer | string): void => {
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    appendFileSync(invocation.outputAbsPath, buffer);
    invocation.output += buffer.toString('utf8');
    emitUpdate(invocation);
  };

  const killInvocation = (invocation: ActiveInvocation, errorPrefix: string): Promise<void> => {
    return Promise.resolve()
      .then(() => deps.killProcessGroup(invocation.child.pid, 'SIGTERM'))
      .catch((error: unknown) => {
        throw new Error(
          `${errorPrefix}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };

  const backgroundInvocation = (invocation: ActiveInvocation, reason: BackgroundReason): void => {
    if (invocation.status !== 'foreground') return;
    invocation.status = 'backgrounding';
    clearTimers(invocation);
    removeAbortListener(invocation);
    removeChildListeners(invocation);

    let adopted: ForegroundBashAdoptResult;
    try {
      adopted = deps.adoptTask({
        child: invocation.child,
        command: invocation.command,
        outputPath: invocation.outputPath,
        startedAt: invocation.startedAt,
        context: invocation.context,
        notifyOnCompletion: true,
        triggerOnCompletion: true,
      });
    } catch (error) {
      void killInvocation(invocation, 'Failed to terminate command after registry adoption failed')
        .then(() => {
          settleError(invocation, error instanceof Error ? error : new Error(String(error)));
        })
        .catch((killError: unknown) => {
          settleError(
            invocation,
            killError instanceof Error ? killError : new Error(String(killError)),
          );
        });
      return;
    }

    const details: ForegroundBashBackgroundedDetails = {
      taskId: adopted.taskId,
      command: invocation.command,
      outputPath: invocation.outputPath,
      reason,
      timeoutSeconds: invocation.timeoutSeconds,
    };
    const priorOutput = formattedOutput(
      invocation.output,
      invocation.outputPath,
      '',
    ).content[0].text;
    const receipt = [
      priorOutput,
      `Command backgrounded as task ${adopted.taskId}.`,
      `Command: ${invocation.command}`,
      `Output: ${invocation.outputPath}`,
      `Reason: ${reason}${reason === 'timeout' ? ` after ${String(invocation.timeoutSeconds)} seconds` : ''}`,
    ]
      .filter((line) => line.length > 0)
      .join('\n');

    invocation.status = 'settled';
    invocations.delete(invocation.context.toolCallId);
    invocation.resolve(textResult(receipt, { fullOutputPath: invocation.outputPath }));

    deps.sendMessage(
      {
        customType: FOREGROUND_BACKGROUND_MESSAGE_TYPE,
        content: `Foreground bash command backgrounded as task ${adopted.taskId}.\nCommand: ${invocation.command}\nOutput: ${invocation.outputPath}\nReason: ${reason}\nTimeout: ${String(invocation.timeoutSeconds)} seconds.`,
        display: true,
        details,
      },
      { deliverAs: 'followUp', triggerTurn: true },
    );
  };

  const execute = async (
    params: BashToolInput,
    context: ForegroundBashExecutionContext,
    signal?: AbortSignal,
    onUpdate?: (result: ForegroundBashToolResult) => void,
  ): Promise<ForegroundBashToolResult> => {
    if (invocations.has(context.toolCallId)) {
      return Promise.reject(
        new Error(`Foreground bash toolCallId is already active: ${context.toolCallId}`),
      );
    }
    if (signal?.aborted) return Promise.reject(new Error('Command aborted before spawn'));

    const blockedSleep = detectBlockedSleep(params.command);
    if (blockedSleep !== undefined) {
      return Promise.reject(
        new Error(`Blocked standalone sleep command before spawn: ${blockedSleep}`),
      );
    }

    let timeoutMs: number;
    try {
      timeoutMs = timeoutMsFor(params);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const timeoutSeconds = timeoutMs / 1000;
    const invocationSequence = ++sequence;
    const outputPath = deps.outputPathForCall(context.toolCallId, invocationSequence);
    const outputAbsPath = isAbsolute(outputPath) ? outputPath : resolve(context.cwd, outputPath);
    mkdirSync(dirname(outputAbsPath), { recursive: true });
    writeFileSync(outputAbsPath, '');

    const child = spawn('bash', ['-c', params.command], {
      cwd: context.cwd,
      detached: true,
      env: context.env ?? deps.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const startedAt = now();

    return new Promise<ForegroundBashToolResult>((resolvePromise, rejectPromise) => {
      const invocation: ActiveInvocation = {
        sequence: invocationSequence,
        command: params.command,
        context,
        child,
        outputPath,
        outputAbsPath,
        startedAt,
        timeoutMs,
        timeoutSeconds,
        nonInteractive: isNonInteractive(deps, context),
        signal,
        onUpdate,
        resolve: resolvePromise,
        reject: rejectPromise,
        status: 'foreground' as InvocationStatus,
        output: '',
        streamingEnabled: false,
        graceTimer: undefined,
        hintTimer: undefined,
        timeoutTimer: undefined,
        abortListener: undefined,
        stdoutListener: (_data: Buffer | string) => undefined,
        stderrListener: (_data: Buffer | string) => undefined,
        errorListener: (_error: Error) => undefined,
        closeListener: (_code: number | null, _signalName: NodeJS.Signals | null) => undefined,
      };

      invocation.stdoutListener = (data) => {
        appendOutput(invocation, data);
      };
      invocation.stderrListener = (data) => {
        appendOutput(invocation, data);
      };
      invocation.errorListener = (error) => {
        if (invocation.status === 'settled') return;
        if (invocation.status === 'aborting') {
          settleError(invocation, new Error(`Command aborted: ${error.message}`));
          return;
        }
        settleError(invocation, error);
      };
      invocation.closeListener = (code, signalName) => {
        if (invocation.status === 'settled' || invocation.status === 'backgrounding') return;
        const result = formattedOutput(invocation.output, invocation.outputPath, '(no output)');
        if (invocation.status === 'aborting') {
          settleError(
            invocation,
            new Error(appendStatus(result, 'Command aborted').content[0].text),
          );
          return;
        }
        if (invocation.status === 'timeout-killing') {
          settleResult(
            invocation,
            appendStatus(
              result,
              `Command timed out after ${String(invocation.timeoutSeconds)} seconds and was terminated`,
            ),
          );
          return;
        }
        if (code !== 0 && code !== null) {
          const signalSuffix = signalName === null ? '' : ` (${signalName})`;
          settleError(
            invocation,
            new Error(
              appendStatus(result, `Command exited with code ${String(code)}${signalSuffix}`)
                .content[0].text,
            ),
          );
          return;
        }
        settleResult(invocation, result);
      };
      invocation.abortListener = () => {
        if (invocation.status !== 'foreground') return;
        invocation.status = 'aborting';
        clearTimers(invocation);
        removeAbortListener(invocation);
        void killInvocation(
          invocation,
          'Command aborted but process-group termination failed',
        ).catch((error: unknown) => {
          settleError(invocation, error instanceof Error ? error : new Error(String(error)));
        });
      };

      invocations.set(context.toolCallId, invocation);
      child.stdout.on('data', invocation.stdoutListener);
      child.stderr.on('data', invocation.stderrListener);
      child.on('error', invocation.errorListener);
      child.on('close', invocation.closeListener);
      signal?.addEventListener('abort', invocation.abortListener, {
        once: true,
      });

      invocation.graceTimer = setTimeout(() => {
        if (invocation.status !== 'foreground') return;
        invocation.streamingEnabled = true;
        emitUpdate(invocation);
      }, FAST_PATH_GRACE_MS);

      if (!invocation.nonInteractive) {
        invocation.hintTimer = setTimeout(() => {
          if (invocation.status !== 'foreground') return;
          deps.notify?.(
            'Command is still running. Press Ctrl+B to move it to the background.',
            'info',
            invocation.context,
          );
        }, BACKGROUND_HINT_DELAY_MS);
        invocation.timeoutTimer = setTimeout(
          () => {
            if (invocation.status !== 'foreground') return;
            if (isAutoBackgroundAllowed(invocation.command)) {
              backgroundInvocation(invocation, 'timeout');
              return;
            }
            invocation.status = 'timeout-killing';
            clearTimers(invocation);
            removeAbortListener(invocation);
            void killInvocation(
              invocation,
              'Timed-out command process-group termination failed',
            ).catch((error: unknown) => {
              settleError(invocation, error instanceof Error ? error : new Error(String(error)));
            });
          },
          invocation.timeoutMs - (now() - invocation.startedAt),
        );
      }
    });
  };

  return {
    execute,
    triggerBackground(): boolean {
      let target: ActiveInvocation | undefined;
      for (const invocation of invocations.values()) {
        if (
          invocation.status === 'foreground' &&
          !invocation.nonInteractive &&
          (target === undefined || invocation.sequence > target.sequence)
        ) {
          target = invocation;
        }
      }
      if (target === undefined) return false;
      backgroundInvocation(target, 'manual');
      return true;
    },
    hasForegroundProcess(): boolean {
      for (const invocation of invocations.values()) {
        if (invocation.status === 'foreground') return true;
      }
      return false;
    },
  };
}

function sessionEnvironment(ctx: ExtensionContext): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env['PI_SESSION_ID'];
  delete env['PI_SESSION_FILE'];
  delete env['PI_PROVIDER'];
  delete env['PI_MODEL'];
  delete env['PI_REASONING_LEVEL'];
  env['PI_SESSION_ID'] = ctx.sessionManager.getSessionId();
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile !== undefined) env['PI_SESSION_FILE'] = sessionFile;
  if (ctx.model !== undefined) {
    env['PI_PROVIDER'] = ctx.model.provider;
    env['PI_MODEL'] = ctx.model.id;
  }
  if (ctx.thinkingLevel !== undefined) env['PI_REASONING_LEVEL'] = ctx.thinkingLevel;
  return env;
}

export function registerForegroundBashFeature<TApi>(
  pi: TApi,
  controller: ForegroundBashController,
): void;
export function registerForegroundBashFeature(
  pi: Pick<ExtensionAPI, 'registerTool' | 'registerShortcut'>,
  controller: ForegroundBashController,
): void {
  const builtInBash = createBashTool(process.cwd());
  pi.registerTool({
    ...builtInBash,
    description: `${builtInBash.description} Commands still running after 120 seconds are moved into the background task registry; press Ctrl+B to background the most recent active command sooner.`,
    execute(toolCallId, params, signal, onUpdate, ctx) {
      return controller.execute(
        params,
        {
          toolCallId,
          cwd: ctx.cwd,
          env: sessionEnvironment(ctx),
          nonInteractive: ctx.mode !== 'tui',
          extensionContext: ctx,
        },
        signal,
        onUpdate === undefined ? undefined : (result) => onUpdate(result),
      );
    },
  });
  pi.registerShortcut('ctrl+b' satisfies KeyId, {
    description: 'Move the most recent active foreground bash command to the background',
    handler: () => {
      controller.triggerBackground();
    },
  });
}

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdirSync, openSync, closeSync, fsyncSync, renameSync, writeSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { Type, type Static } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Usage } from '@earendil-works/pi-ai';
import {
  DELEGATE_RECEIPT_SCHEMA_VERSION,
  type DelegateRouteAttestation,
  type DelegateSeedV1,
  type DelegateSpillReceipt,
  type DelegateUsageReport,
} from './core/delegate/types.js';
import { verifyDelegateSeedBytes } from './core/delegate/seed.js';
import { evaluateDelegateRuntimeBudget } from './core/delegate/budget.js';
import {
  buildDelegateResultPackage,
  serializeDelegateResultPackage,
} from './core/delegate/result-package.js';

/**
 * Package-owned delegate child extension.
 *
 * This runs inside the delegate child Pi process and is the only extension it
 * loads. It is responsible for every guarantee that cannot be enforced from the
 * parent:
 *
 * - verifying the frozen seed bytes before the first model call;
 * - measuring the outgoing message set before every model call and refusing to
 *   let an oversized one reach the provider;
 * - spilling oversized tool results to hashed artifacts and replacing them with
 *   explicit receipts before they enter the transcript;
 * - asserting every assistant message came from the pinned route;
 * - enforcing turn and tool-call limits;
 * - committing exactly one result package atomically.
 *
 * Measured Pi 0.83 behaviour this design accounts for (see
 * `tests/scripted-provider/pi-hook-contract.test.ts`):
 *
 * - Throwing from a `context` handler does NOT stop the provider call. Pi
 *   catches the exception and dispatches anyway. A throw is therefore never used
 *   as a barrier here.
 * - `ctx.abort()` does not skip the provider call site, but the call receives an
 *   already-aborted signal and the run terminates. That is the barrier used.
 * - Because neither mechanism is a hard admission gate on its own, the guard
 *   ALSO replaces the offending content in the returned message set. Even a
 *   provider that ignored the aborted signal could not transmit the content,
 *   because the content is no longer there.
 */

const SPILL_DIRNAME = 'spill';

interface GuardState {
  seed: DelegateSeedV1;
  artifactDirAbs: string;
  turns: number;
  toolCalls: number;
  totalToolOutputBytes: number;
  spilled: DelegateSpillReceipt[];
  attestations: DelegateRouteAttestation[];
  usage: Usage | undefined;
  usageUnavailableReason: string | undefined;
  answerBlocks: string[];
  terminal: TerminalLatch | undefined;
  committed: boolean;
}

/**
 * A terminal condition latches.
 *
 * Once the guard has degraded or refused anything, no later assistant message
 * may be committed as a successful answer. Otherwise a run whose context was
 * silently mutilated could still produce a hash-valid package, which is exactly
 * the "hash-valid but wrong" failure this design must not have.
 */
interface TerminalLatch {
  code: string;
  message: string;
}

/**
 * Stop reasons that may be committed as a complete answer.
 *
 * `length` means the provider truncated the response at the output-token limit,
 * `aborted` and `error` mean the run did not finish, and a pending tool call
 * means the agent had more to do. None of those is a whole answer, so none of
 * them may be committed as one.
 */
const ACCEPTED_STOP_REASONS: ReadonlySet<string> = new Set(['stop']);

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Replacement message set used when the guard suppresses a request.
 *
 * Keeps the shape valid without transmitting the content that triggered the
 * suppression. The head message is retained only when it is a user message, so
 * a suppressed request cannot carry assistant or tool content forward.
 */
function suppressedMessages<TMessage extends object>(
  messages: readonly TMessage[],
): TMessage[] {
  const head = messages[0];
  if (head === undefined) return [];
  return Reflect.get(head, 'role') === 'user' ? [head] : [];
}

function utf8(value: string): Buffer {
  return Buffer.from(value, 'utf8');
}

function finiteNonNegative(source: object, key: string): number | undefined {
  const value: unknown = Reflect.get(source, key);
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/**
 * Read a complete Pi `Usage` record, or report none.
 *
 * A partial usage record is treated as no usage at all. Filling missing fields
 * with zero would understate real spend, which is a silent misreport.
 */
function readUsage(value: unknown): Usage | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const cost: unknown = Reflect.get(value, 'cost');
  if (typeof cost !== 'object' || cost === null) return undefined;
  const input = finiteNonNegative(value, 'input');
  const output = finiteNonNegative(value, 'output');
  const cacheRead = finiteNonNegative(value, 'cacheRead');
  const cacheWrite = finiteNonNegative(value, 'cacheWrite');
  const totalTokens = finiteNonNegative(value, 'totalTokens');
  const costInput = finiteNonNegative(cost, 'input');
  const costOutput = finiteNonNegative(cost, 'output');
  const costCacheRead = finiteNonNegative(cost, 'cacheRead');
  const costCacheWrite = finiteNonNegative(cost, 'cacheWrite');
  const costTotal = finiteNonNegative(cost, 'total');
  if (
    input === undefined ||
    output === undefined ||
    cacheRead === undefined ||
    cacheWrite === undefined ||
    totalTokens === undefined ||
    costInput === undefined ||
    costOutput === undefined ||
    costCacheRead === undefined ||
    costCacheWrite === undefined ||
    costTotal === undefined
  ) {
    return undefined;
  }
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost: {
      input: costInput,
      output: costOutput,
      cacheRead: costCacheRead,
      cacheWrite: costCacheWrite,
      total: costTotal,
    },
  };
}

function readEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value.length === 0) {
    throw new Error(`delegate child requires ${key}`);
  }
  return value;
}

function pathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'));
}

/** Synchronous durable commit: temp write, fsync, rename, directory fsync. */
function commitFileSync(absPath: string, data: Buffer): void {
  const dir = dirname(absPath);
  mkdirSync(dir, { recursive: true });
  const temporary = `${absPath}.${String(process.pid)}.${Date.now().toString(36)}.tmp`;
  const handle = openSync(temporary, 'wx', 0o600);
  try {
    let written = 0;
    while (written < data.length) {
      written += writeSync(handle, data, written, data.length - written, null);
    }
    fsyncSync(handle);
  } finally {
    closeSync(handle);
  }
  renameSync(temporary, absPath);
  if (process.platform !== 'win32') {
    const dirHandle = openSync(dir, 'r');
    try {
      fsyncSync(dirHandle);
    } finally {
      closeSync(dirHandle);
    }
  }
}

function messageContentBytes(content: unknown): number {
  if (typeof content === 'string') return Buffer.byteLength(content, 'utf8');
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue;
    const text: unknown = Reflect.get(part, 'text');
    if (typeof text === 'string') total += Buffer.byteLength(text, 'utf8');
    const thinkingText: unknown = Reflect.get(part, 'thinking');
    if (typeof thinkingText === 'string') total += Buffer.byteLength(thinkingText, 'utf8');
    const args: unknown = Reflect.get(part, 'arguments');
    if (args !== undefined) total += Buffer.byteLength(JSON.stringify(args) ?? '', 'utf8');
    const data: unknown = Reflect.get(part, 'data');
    if (typeof data === 'string') total += Buffer.byteLength(data, 'utf8');
  }
  return total;
}

/** Complete retained input measured the same way the admission plan measured the seed. */
function retainedInputBytes(messages: readonly object[], systemPrompt: string): number {
  let total = Buffer.byteLength(systemPrompt, 'utf8');
  for (const message of messages) total += messageContentBytes(Reflect.get(message, 'content'));
  return total;
}

const ArtifactReadParams = Type.Object(
  {
    artifact: Type.String({
      description:
        'Relative artifact path exactly as named in a spill receipt, for example spill/t0001-c0000-abc.bin',
    }),
    offset: Type.Number({ description: 'Byte offset to start reading from. Zero-based.' }),
    length: Type.Number({ description: 'Exact number of bytes to read. Must be positive.' }),
  },
  { additionalProperties: false },
);

type ArtifactReadParamsValue = Static<typeof ArtifactReadParams>;

interface ArtifactReadDetails {
  artifact: string;
  offset: number;
  length: number;
  total_bytes: number;
}

export default function delegateChildExtension(pi: ExtensionAPI): void {
  const artifactDirAbs = readEnv('PI_BG_DELEGATE_ARTIFACT_DIR');
  const seedPath = readEnv('PI_BG_DELEGATE_SEED_PATH');
  const expectedSeedSha = readEnv('PI_BG_DELEGATE_SEED_SHA256');
  const expectedTaskId = readEnv('PI_BG_DELEGATE_TASK_ID');
  const expectedNonce = readEnv('PI_BG_DELEGATE_LAUNCH_NONCE');

  // Seed verification happens at load, before the first model call. A seed
  // that does not match its declared hash and identity aborts the child rather
  // than running with content the parent did not author.
  const seedRaw = readFileSync(seedPath, 'utf8');
  const seed = verifyDelegateSeedBytes(seedRaw, {
    sha256: expectedSeedSha,
    taskId: expectedTaskId,
    launchNonce: expectedNonce,
  });

  const state: GuardState = {
    seed,
    artifactDirAbs,
    turns: 0,
    toolCalls: 0,
    totalToolOutputBytes: 0,
    spilled: [],
    attestations: [],
    usage: undefined,
    usageUnavailableReason: 'the child produced no assistant message carrying usage',
    answerBlocks: [],
    terminal: undefined,
    committed: false,
  };

  function latch(code: string, message: string): void {
    if (state.terminal === undefined) state.terminal = { code, message };
  }

  function usageReport(): DelegateUsageReport {
    if (state.usage !== undefined) return { status: 'observed', usage: state.usage };
    return {
      status: 'unavailable',
      reason: state.usageUnavailableReason ?? 'usage was not reported by the provider',
    };
  }

  /**
   * Commit exactly one result package.
   *
   * Refuses to commit when a terminal condition has latched, so a degraded run
   * can never be reported as a clean success. Refuses to commit twice.
   */
  function commitResult(stopReason: string): void {
    if (state.committed) return;
    if (state.terminal !== undefined) {
      writeTerminalRecord(state.terminal);
      return;
    }
    if (state.answerBlocks.length === 0) {
      writeTerminalRecord({
        code: 'child_exited_without_commit',
        message: 'the delegate child produced no assistant answer text',
      });
      return;
    }
    // A hash proves the bytes are intact; it cannot prove they are complete.
    // Only an approved terminal stop reason may be committed as success, so a
    // response cut short by the output-token limit, a content filter, an
    // aborted run, or a provider error can never be returned as a whole answer.
    if (!ACCEPTED_STOP_REASONS.has(stopReason)) {
      writeTerminalRecord({
        code: stopReason === 'length' ? 'child_model_output_limit' : 'child_result_invalid',
        message: `the delegate child stopped with reason "${stopReason}", so its answer is incomplete and is not committed as a result; the captured text is preserved in the child transcript`,
      });
      return;
    }
    if (state.answerBlocks.join('').trim().length === 0) {
      writeTerminalRecord({
        code: 'child_result_invalid',
        message: 'the delegate child produced only whitespace, which is not a usable answer',
      });
      return;
    }
    const pkg = buildDelegateResultPackage({
      taskId: seed.task_id,
      launchNonce: seed.launch_nonce,
      seedSha256: expectedSeedSha,
      directiveSha256: seed.directive.sha256,
      route: { provider: seed.route.provider, model: seed.route.model },
      routeAttestations: state.attestations,
      stopReason,
      turns: state.turns,
      toolCalls: state.toolCalls,
      usage: usageReport(),
      answerBlocks: state.answerBlocks,
      spilledArtifacts: state.spilled,
    });
    commitFileSync(join(artifactDirAbs, 'result.json'), utf8(serializeDelegateResultPackage(pkg)));
    state.committed = true;
  }

  function writeTerminalRecord(terminal: TerminalLatch): void {
    commitFileSync(
      join(artifactDirAbs, 'child-terminal.json'),
      utf8(
        `${JSON.stringify(
          {
            schema_version: 'pi-background-tasks.delegate-child-terminal.v1',
            task_id: seed.task_id,
            launch_nonce: seed.launch_nonce,
            code: terminal.code,
            message: terminal.message,
            turns: state.turns,
            tool_calls: state.toolCalls,
            spilled_artifacts: state.spilled,
          },
          null,
          2,
        )}\n`,
      ),
    );
  }

  pi.registerTool<typeof ArtifactReadParams, ArtifactReadDetails>({
    name: 'delegate_read_artifact',
    label: 'Delegate Artifact Read',
    description:
      'Read an exact byte range from a spilled tool-result artifact. Returns exactly the requested range or fails; it never returns fewer bytes than requested and never clamps the request.',
    promptSnippet: 'Read an exact byte range from a spilled tool-result artifact',
    promptGuidelines: [
      'Use delegate_read_artifact when a tool result was replaced by a spill receipt and the omitted bytes are actually needed.',
      'Request a bounded range. A request past the end of the artifact fails loudly rather than returning a short read.',
    ],
    parameters: ArtifactReadParams,
    prepareArguments(args): ArtifactReadParamsValue {
      if (typeof args !== 'object' || args === null)
        throw new Error('delegate_read_artifact arguments must be an object');
      const artifact: unknown = Reflect.get(args, 'artifact');
      const offset: unknown = Reflect.get(args, 'offset');
      const length: unknown = Reflect.get(args, 'length');
      if (typeof artifact !== 'string')
        throw new Error('delegate_read_artifact requires artifact string');
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0)
        throw new Error('delegate_read_artifact requires a non-negative integer offset');
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length <= 0)
        throw new Error('delegate_read_artifact requires a positive integer length');
      return { artifact, offset, length };
    },
    execute(_toolCallId, params) {
      const absPath = join(artifactDirAbs, params.artifact);
      if (!pathInside(artifactDirAbs, absPath)) {
        throw new Error(
          `delegate_read_artifact path ${params.artifact} escapes the delegate artifact directory`,
        );
      }
      const bytes = readFileSync(absPath);
      const end = params.offset + params.length;
      if (end > bytes.length) {
        throw new Error(
          `delegate_read_artifact requested bytes ${String(params.offset)}..${String(end)} but ${params.artifact} is ${String(bytes.length)} bytes; the read is refused rather than silently shortened`,
        );
      }
      const slice = bytes.subarray(params.offset, end);
      if (slice.length !== params.length) {
        throw new Error(
          `delegate_read_artifact returned ${String(slice.length)} of ${String(params.length)} requested bytes`,
        );
      }
      return Promise.resolve({
        content: [{ type: 'text' as const, text: slice.toString('utf8') }],
        details: {
          artifact: params.artifact,
          offset: params.offset,
          length: params.length,
          total_bytes: bytes.length,
        },
      });
    },
  });

  pi.on('context', (event, ctx) => {
    // Fail closed. Pi swallows exceptions thrown from a `context` handler and
    // dispatches the call regardless, so a throw inside this guard would let the
    // ORIGINAL unguarded message set reach the provider. Every path therefore
    // runs inside this try, and the catch latches terminal state and suppresses
    // the content rather than letting the original through.
    try {
      const verdict = evaluateDelegateRuntimeBudget(
        { retainedInputBytes: retainedInputBytes(event.messages, ctx.getSystemPrompt()) },
        seed.limits.allowed_input_tokens,
      );
      if (verdict.withinBudget) return undefined;
      const message = `delegate child context reached ${String(verdict.measuredTokens)} input tokens against a ${String(verdict.allowedTokens)}-token allowance on route ${seed.route.qualified_id}, over by ${String(verdict.overageTokens)}`;
      latch('provider_context_budget_exhausted', message);
      // Barrier one: terminate the run. Measured on Pi 0.83, this hands the
      // provider call an already-aborted signal and stops further turns.
      ctx.abort();
      // Barrier two: remove the content itself, so the request could not carry it
      // even if a provider ignored the aborted signal. Retaining only the first
      // message keeps the shape valid without transmitting the oversized tail.
      return { messages: suppressedMessages(event.messages) };
    } catch (error) {
      latch(
        'child_result_invalid',
        `delegate context guard failed and the run was stopped rather than dispatched unguarded: ${error instanceof Error ? error.message : String(error)}`,
      );
      try {
        ctx.abort();
      } catch {
        // An abort failure must not resurrect the unguarded message set. The
        // latch above already prevents a success commit, and the suppressed
        // replacement below still removes the content from this request.
      }
      return { messages: suppressedMessages(event.messages) };
    }
  });

  pi.on('tool_result', (event) => {
    // Fail closed for the same reason as the context guard: a throw here would
    // let the ORIGINAL oversized payload flow into the transcript.
    try {
      return guardToolResult(event);
    } catch (error) {
      latch(
        'artifact_spill_failed',
        `delegate tool-result guard failed and the payload was withheld: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: '[delegate: tool result withheld because the result guard failed; the run is terminating]',
          },
        ],
        isError: true,
      };
    }
  });

  function guardToolResult(event: {
    toolName: string;
    toolCallId: string;
    content: ReadonlyArray<{ type: string; text?: string }>;
  }): { content: Array<{ type: 'text'; text: string }>; isError?: boolean } | undefined {
    state.toolCalls += 1;
    if (state.toolCalls > seed.limits.max_tool_calls) {
      latch(
        'child_tool_call_limit',
        `delegate child exceeded its ${String(seed.limits.max_tool_calls)} tool-call limit`,
      );
    }
    const texts = event.content.flatMap((part) =>
      part.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
    );
    const joined = texts.join('');
    const payload = utf8(joined);
    state.totalToolOutputBytes += payload.length;
    if (state.totalToolOutputBytes > seed.limits.max_total_tool_output_bytes) {
      latch(
        'aggregate_tool_output_cap',
        `delegate child accumulated ${String(state.totalToolOutputBytes)} bytes of tool output, exceeding its ${String(seed.limits.max_total_tool_output_bytes)}-byte cap`,
      );
    }
    if (payload.length <= seed.limits.max_tool_result_bytes) return undefined;

    // Oversized: spill to a hashed artifact and replace the transcript content
    // with an explicit receipt. The raw payload never enters the transcript.
    const turnSequence = state.turns;
    const sourceCallIndex = state.spilled.length;
    const safeCallId = event.toolCallId.replace(/[^a-zA-Z0-9_.-]+/g, '-').slice(0, 64);
    const name = `t${String(turnSequence).padStart(4, '0')}-c${String(sourceCallIndex).padStart(4, '0')}-${safeCallId}.bin`;
    const relPath = join(SPILL_DIRNAME, name);
    const absPath = join(artifactDirAbs, relPath);
    if (!pathInside(artifactDirAbs, absPath)) {
      latch('artifact_spill_failed', `delegate spill path escapes the artifact directory: ${name}`);
      return {
        content: [
          {
            type: 'text' as const,
            text: '[delegate: tool result withheld because its spill path was rejected]',
          },
        ],
      };
    }
    try {
      commitFileSync(absPath, payload);
    } catch (error) {
      // A spill that cannot be committed is terminal. The original payload is
      // never returned as a fallback, and no receipt claims an uncommitted file.
      latch(
        'artifact_spill_failed',
        `delegate could not spill a ${String(payload.length)}-byte tool result: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        content: [
          {
            type: 'text' as const,
            text: '[delegate: tool result withheld because it could not be durably spilled; the run is terminating]',
          },
        ],
        isError: true,
      };
    }
    const receipt: DelegateSpillReceipt = {
      schema_version: DELEGATE_RECEIPT_SCHEMA_VERSION,
      artifact: relPath,
      tool_name: event.toolName,
      tool_call_id: event.toolCallId,
      turn_sequence: turnSequence,
      source_call_index: sourceCallIndex,
      byte_length: payload.length,
      sha256: sha256(payload),
    };
    state.spilled.push(receipt);
    return {
      content: [
        {
          type: 'text' as const,
          text: [
            `[delegate spill receipt] The ${event.toolName} result was ${String(payload.length)} bytes, over the ${String(seed.limits.max_tool_result_bytes)}-byte transcript cap.`,
            `It was written in full to ${relPath} (sha256 ${receipt.sha256}).`,
            'Nothing was truncated: the complete bytes are on disk.',
            `Read an exact range with delegate_read_artifact({artifact:"${relPath}", offset, length}).`,
          ].join('\n'),
        },
      ],
    };
  }

  pi.on('turn_start', () => {
    state.turns += 1;
    if (state.turns > seed.limits.max_turns) {
      latch(
        'child_turn_limit',
        `delegate child exceeded its ${String(seed.limits.max_turns)} turn limit`,
      );
    }
  });

  pi.on('message_end', (event) => {
    if (event.message.role !== 'assistant') return;
    const provider: unknown = Reflect.get(event.message, 'provider');
    const model: unknown = Reflect.get(event.message, 'model');
    const stopReason: unknown = Reflect.get(event.message, 'stopReason');
    const attestation: DelegateRouteAttestation = {
      provider: typeof provider === 'string' ? provider : '',
      model: typeof model === 'string' ? model : '',
      stop_reason: typeof stopReason === 'string' ? stopReason : '',
    };
    state.attestations.push(attestation);
    if (
      attestation.provider !== seed.route.provider ||
      attestation.model !== seed.route.model
    ) {
      latch(
        'route_mismatch',
        `delegate child produced an assistant message on ${attestation.provider}/${attestation.model}, but the pinned route is ${seed.route.qualified_id}`,
      );
    }
    const observedUsage = readUsage(Reflect.get(event.message, 'usage'));
    if (observedUsage === undefined) {
      // Never synthesize zero usage. An absent or incomplete usage record stays
      // explicitly unavailable so the parent cannot report a free run.
      state.usageUnavailableReason =
        'the provider did not report a complete token/cost usage record';
    } else {
      state.usage = observedUsage;
      state.usageUnavailableReason = undefined;
    }
    const content: unknown = Reflect.get(event.message, 'content');
    if (!Array.isArray(content)) return;
    for (const part of content) {
      if (typeof part !== 'object' || part === null) continue;
      if (Reflect.get(part, 'type') !== 'text') continue;
      const text: unknown = Reflect.get(part, 'text');
      if (typeof text === 'string' && text.length > 0) state.answerBlocks.push(text);
    }
  });

  pi.on('agent_end', () => {
    const finalStop = state.attestations.at(-1)?.stop_reason ?? 'unknown';
    commitResult(finalStop);
  });

  pi.on('session_shutdown', () => {
    // A shutdown before agent_end means no answer was produced. Record it so the
    // parent sees a typed reason instead of an empty directory.
    if (state.committed) return;
    if (state.terminal === undefined) {
      latch('child_exited_without_commit', 'the delegate child shut down before committing a result');
    }
    if (state.terminal !== undefined) writeTerminalRecord(state.terminal);
  });
}

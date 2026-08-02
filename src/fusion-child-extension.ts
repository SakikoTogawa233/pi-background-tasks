import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, writeSync } from 'node:fs';
import type { Usage } from '@earendil-works/pi-ai';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  FUSION_TOOL_CALL_LOG_SCHEMA_VERSION,
  type FusionToolCallLogRecord,
} from './core/fusion/types.js';

export const FUSION_CHILD_RESULT_SCHEMA_VERSION =
  'pi-background-tasks.fusion-child-result.v2' as const;
export const FUSION_CHILD_RESULT_PREFIX = '\u001ePI_FUSION_CHILD_RESULT ';
export const FUSION_TOOL_CALL_LOG_PATH_ENV = 'PI_FUSION_TOOL_CALL_LOG_PATH';

/**
 * Aggregate ceiling on tool-result bytes a single candidate child may accumulate.
 *
 * v1 deliberately has no tool-CALL cap, so this byte budget is the only bound on how much
 * a read-only candidate can pull into its context. 8 MiB is generous for targeted
 * grep/read investigation while still preventing an unbounded read loop from degrading
 * into an opaque provider-side context failure.
 */
export const FUSION_CHILD_MAX_TOTAL_TOOL_RESULT_BYTES = 8 * 1024 * 1024;

export interface FusionChildTextBlockMetadata {
  utf8_bytes: number;
  sha256: string;
}

export type FusionChildResultUsageMetadata = Usage;

export interface FusionChildResultMetadata {
  schema_version: typeof FUSION_CHILD_RESULT_SCHEMA_VERSION;
  provider: string;
  model: string;
  stop_reason: string;
  text_blocks: FusionChildTextBlockMetadata[];
  text_sha256: string;
  usage: FusionChildResultUsageMetadata;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function utf8JsonBytes(value: unknown, label: string): Buffer {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    throw new Error(
      `fusion tool-call log could not serialize ${label}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (text === undefined) throw new Error(`fusion tool-call log ${label} serialized to undefined`);
  return Buffer.from(text, 'utf8');
}

function appendToolCallLogLine(path: string, record: FusionToolCallLogRecord): void {
  // The log is an audit trail, not a payload copy: raw tool arguments/results may
  // contain secrets, so only byte counts and SHA-256 digests are persisted.
  const line = `${JSON.stringify(record)}\n`;
  const expectedBytes = Buffer.byteLength(line, 'utf8');
  let fd: number | undefined;
  try {
    fd = openSync(path, 'a', 0o600);
    const written = writeSync(fd, line, undefined, 'utf8');
    if (written !== expectedBytes) {
      throw new Error(
        `short write: wrote ${String(written)} of ${String(expectedBytes)} bytes`,
      );
    }
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function buildFusionChildResultMetadata(message: {
  provider: string;
  model: string;
  stopReason: string;
  content: ReadonlyArray<{ type: string; text?: string }>;
  usage: Usage;
}): FusionChildResultMetadata {
  const textBlocks = message.content.flatMap((part) =>
    part.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
  );
  const usage: FusionChildResultUsageMetadata = {
    input: message.usage.input,
    output: message.usage.output,
    cacheRead: message.usage.cacheRead,
    cacheWrite: message.usage.cacheWrite,
    totalTokens: message.usage.totalTokens,
    cost: {
      input: message.usage.cost.input,
      output: message.usage.cost.output,
      cacheRead: message.usage.cost.cacheRead,
      cacheWrite: message.usage.cost.cacheWrite,
      total: message.usage.cost.total,
    },
  };
  return {
    schema_version: FUSION_CHILD_RESULT_SCHEMA_VERSION,
    provider: message.provider,
    model: message.model,
    stop_reason: message.stopReason,
    text_blocks: textBlocks.map((text) => ({
      utf8_bytes: Buffer.byteLength(text, 'utf8'),
      sha256: sha256(text),
    })),
    text_sha256: sha256(textBlocks.join('')),
    usage,
  };
}

async function writeMetadata(record: FusionChildResultMetadata): Promise<void> {
  const line = `${FUSION_CHILD_RESULT_PREFIX}${JSON.stringify(record)}\n`;
  await new Promise<void>((resolve, reject) => {
    process.stderr.write(line, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

/**
 * Private Fusion child extension.
 *
 * Pi print mode writes only the final full text to stdout. This extension adds
 * one compact, reasoning-free metadata record to stderr for each finalized
 * assistant message so the parent can validate model identity, stop reason,
 * exact text bytes, and usage without consuming cumulative JSON stream events.
 */
export default function fusionChildExtension(pi: ExtensionAPI): void {
  const toolCallLogPath = process.env[FUSION_TOOL_CALL_LOG_PATH_ENV];
  if (toolCallLogPath !== undefined) {
    // Create the log immediately, before tools can run. Without this, an absent file
    // is ambiguous: it could mean "this child made zero tool calls" or "the audit trail
    // was never written". The parent must be able to tell those apart, so existence is
    // established up front and a missing file is a hard failure rather than an empty trace.
    closeSync(openSync(toolCallLogPath, 'a', 0o600));
    let ordinal = 0;
    let totalToolResultBytes = 0;
    const starts = new Map<string, number>();
    pi.on('tool_call', (event) => {
      starts.set(event.toolCallId, Date.now());
    });
    pi.on('tool_result', (event) => {
      const start = starts.get(event.toolCallId);
      if (start === undefined) {
        throw new Error(`fusion tool-call log missing start for ${event.toolCallId}`);
      }
      starts.delete(event.toolCallId);
      const argumentsBytes = utf8JsonBytes(event.input, 'arguments');
      const resultBytes = utf8JsonBytes(
        {
          content: event.content,
          details: event.details,
          isError: event.isError,
          usage: event.usage,
        },
        'result',
      );
      const record: FusionToolCallLogRecord = {
        schema_version: FUSION_TOOL_CALL_LOG_SCHEMA_VERSION,
        ordinal,
        tool_name: event.toolName,
        arguments_sha256: sha256(argumentsBytes),
        arguments_bytes: argumentsBytes.length,
        result_bytes: resultBytes.length,
        result_sha256: sha256(resultBytes),
        status: event.isError === true ? 'error' : 'ok',
        duration_ms: Math.max(0, Date.now() - start),
      };
      ordinal += 1;
      appendToolCallLogLine(toolCallLogPath, record);
      // Aggregate output ceiling. There is no tool-CALL cap in v1 by design, so bytes are
      // the only bound on how much a read-only candidate can pull into its context. The
      // record is durable before this check, so the offending call stays auditable; the
      // failure is loud rather than a truncation, because a silently shortened tool result
      // would corrupt the candidate's reasoning with no signal at all.
      totalToolResultBytes += resultBytes.length;
      if (totalToolResultBytes > FUSION_CHILD_MAX_TOTAL_TOOL_RESULT_BYTES) {
        throw new Error(
          `fusion candidate exceeded the aggregate tool-output budget: ${String(totalToolResultBytes)} bytes across ${String(ordinal)} calls exceeds ${String(FUSION_CHILD_MAX_TOTAL_TOOL_RESULT_BYTES)}`,
        );
      }
    });
  }

  pi.on('message_end', async (event) => {
    if (event.message.role !== 'assistant') return;
    await writeMetadata(buildFusionChildResultMetadata(event.message));
  });
}

import { createHash } from 'node:crypto';
import type { Usage } from '@earendil-works/pi-ai';

export const FUSION_CHILD_RESULT_SCHEMA_VERSION =
  'pi-background-tasks.fusion-child-result.v2' as const;
export const FUSION_CHILD_RESULT_PREFIX = '\u001ePI_FUSION_CHILD_RESULT ';
export const FUSION_CHILD_SETTLEMENT_SCHEMA_VERSION =
  'pi-background-tasks.fusion-child-settlement.v1' as const;
export const FUSION_CHILD_SETTLEMENT_PREFIX = '\u001ePI_FUSION_CHILD_SETTLEMENT ';
export const FUSION_TOOL_CALL_LOG_PATH_ENV = 'PI_FUSION_TOOL_CALL_LOG_PATH';
export const FUSION_RESEARCH_ENABLED_ENV = 'PI_FUSION_RESEARCH_ENABLED';
export const FUSION_SOURCE_POLICY_PATH_ENV = 'PI_FUSION_SOURCE_POLICY_PATH';
export const FUSION_SOURCE_POLICY_SHA256_ENV = 'PI_FUSION_SOURCE_POLICY_SHA256';
export const FUSION_TOOL_CALL_SEAL_SCHEMA_VERSION =
  'pi-background-tasks.fusion-tool-call-seal.v1' as const;
export const FUSION_TOOL_CALL_SEAL_SUFFIX = '.seal.json';
export const FUSION_RUNTIME_GUARD_SCHEMA_VERSION =
  'pi-background-tasks.fusion-runtime-guard.v1' as const;
export const FUSION_RUNTIME_GUARD_PREFIX = '\u001ePI_FUSION_RUNTIME_GUARD ';
export const FUSION_CHILD_MAX_PROVIDER_REQUESTS = 128;
export const FUSION_CHILD_MAX_TOOL_CALLS = 192;
export const FUSION_CHILD_MIN_OUTPUT_RESERVE_TOKENS = 32_768;
export const FUSION_CHILD_SAFETY_RESERVE_TOKENS = 4_096;

/**
 * Aggregate ceiling on tool-result bytes a single candidate child may accumulate.
 *
 * The byte ceiling complements the runtime provider-payload governor and tool/request
 * count limits. It remains an independent bound on total tool material even when Pi
 * compaction keeps each individual provider request within the route context window.
 */
export const FUSION_CHILD_MAX_TOTAL_TOOL_RESULT_BYTES = 8 * 1024 * 1024;

export type FusionRuntimeGuardCode =
  | 'provider_request_limit'
  | 'provider_request_budget'
  | 'provider_payload_invalid'
  | 'tool_call_limit';

export interface FusionRuntimeGuardRecord {
  schema_version: typeof FUSION_RUNTIME_GUARD_SCHEMA_VERSION;
  code: FusionRuntimeGuardCode;
  provider: string;
  model: string;
  request_ordinal: number;
  tool_call_count: number;
  payload_bytes: number;
  payload_sha256: string;
  estimated_input_tokens: number;
  context_window_tokens: number;
  reserved_output_tokens: number;
  safety_reserve_tokens: number;
  allowed_input_tokens: number;
  message: string;
}

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

export type FusionChildSettlementFailureReason =
  | 'no_records'
  | 'final_not_stop'
  | 'invalid_non_final'
  | 'runtime_guard';

export interface FusionChildSettlementRecord {
  schema_version: typeof FUSION_CHILD_SETTLEMENT_SCHEMA_VERSION;
  status: 'complete' | 'failed';
  record_count: number;
  records_sha256: string;
  final_record_index: number | null;
  final_text_sha256: string | null;
  recovered_error_ordinals: number[];
  failure_reason: FusionChildSettlementFailureReason | null;
}

function protocolSha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function serializeFusionChildResultRecords(
  records: readonly FusionChildResultMetadata[],
): Buffer {
  return Buffer.from(
    records.length === 0 ? '' : `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    'utf8',
  );
}

function hasZeroUsage(record: FusionChildResultMetadata): boolean {
  const usage = record.usage;
  return (
    usage.input === 0 &&
    usage.output === 0 &&
    usage.cacheRead === 0 &&
    usage.cacheWrite === 0 &&
    usage.totalTokens === 0 &&
    usage.cost.input === 0 &&
    usage.cost.output === 0 &&
    usage.cost.cacheRead === 0 &&
    usage.cost.cacheWrite === 0 &&
    usage.cost.total === 0
  );
}

export function isRecoverableFusionChildErrorRecord(record: FusionChildResultMetadata): boolean {
  return (
    record.stop_reason === 'error' &&
    record.text_blocks.length === 0 &&
    record.text_sha256 === protocolSha256(Buffer.alloc(0)) &&
    hasZeroUsage(record)
  );
}

export function buildFusionChildSettlement(
  records: readonly FusionChildResultMetadata[],
  runtimeGuardFailed = false,
): FusionChildSettlementRecord {
  const finalRecordIndex = records.length === 0 ? null : records.length - 1;
  const final = records.at(-1);
  const recoveredErrorOrdinals = records.flatMap((record, ordinal) =>
    ordinal < records.length - 1 && isRecoverableFusionChildErrorRecord(record) ? [ordinal] : [],
  );
  const invalidNonFinal = records.some(
    (record, ordinal) =>
      ordinal < records.length - 1 &&
      record.stop_reason !== 'toolUse' &&
      !isRecoverableFusionChildErrorRecord(record),
  );
  let failureReason: FusionChildSettlementFailureReason | null = null;
  if (runtimeGuardFailed) failureReason = 'runtime_guard';
  else if (final === undefined) failureReason = 'no_records';
  else if (final.stop_reason !== 'stop') failureReason = 'final_not_stop';
  else if (invalidNonFinal) failureReason = 'invalid_non_final';
  return {
    schema_version: FUSION_CHILD_SETTLEMENT_SCHEMA_VERSION,
    status: failureReason === null ? 'complete' : 'failed',
    record_count: records.length,
    records_sha256: protocolSha256(serializeFusionChildResultRecords(records)),
    final_record_index: finalRecordIndex,
    final_text_sha256: final?.text_sha256 ?? null,
    recovered_error_ordinals: recoveredErrorOrdinals,
    failure_reason: failureReason,
  };
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
      sha256: protocolSha256(text),
    })),
    text_sha256: protocolSha256(textBlocks.join('')),
    usage,
  };
}

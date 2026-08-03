import { createHash } from 'node:crypto';
import type { Usage } from '@earendil-works/pi-ai';

export const FUSION_CHILD_RESULT_SCHEMA_VERSION =
  'pi-background-tasks.fusion-child-result.v2' as const;
export const FUSION_CHILD_RESULT_PREFIX = '\u001ePI_FUSION_CHILD_RESULT ';
export const FUSION_TOOL_CALL_LOG_PATH_ENV = 'PI_FUSION_TOOL_CALL_LOG_PATH';
export const FUSION_RESEARCH_ENABLED_ENV = 'PI_FUSION_RESEARCH_ENABLED';
export const FUSION_SOURCE_POLICY_PATH_ENV = 'PI_FUSION_SOURCE_POLICY_PATH';
export const FUSION_SOURCE_POLICY_SHA256_ENV = 'PI_FUSION_SOURCE_POLICY_SHA256';
export const FUSION_TOOL_CALL_SEAL_SCHEMA_VERSION =
  'pi-background-tasks.fusion-tool-call-seal.v1' as const;
export const FUSION_TOOL_CALL_SEAL_SUFFIX = '.seal.json';

/**
 * Aggregate ceiling on tool-result bytes a single candidate child may accumulate.
 *
 * v1 deliberately has no tool-call-count cap, so this byte budget is the only bound on
 * how much a read-only candidate can pull into its context. 8 MiB is generous for
 * targeted grep/read investigation while still preventing an unbounded read loop from
 * degrading into an opaque provider-side context failure.
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

function protocolSha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
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

import { createHash } from 'node:crypto';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export const FUSION_CHILD_RESULT_SCHEMA_VERSION =
  'pi-background-tasks.fusion-child-result.v1' as const;
export const FUSION_CHILD_RESULT_PREFIX = '\u001ePI_FUSION_CHILD_RESULT ';

export interface FusionChildTextBlockMetadata {
  utf8_bytes: number;
  sha256: string;
}

export interface FusionChildResultUsageMetadata {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costTotal?: number;
}

export interface FusionChildResultMetadata {
  schema_version: typeof FUSION_CHILD_RESULT_SCHEMA_VERSION;
  provider: string;
  model: string;
  stop_reason: string;
  text_blocks: FusionChildTextBlockMetadata[];
  text_sha256: string;
  usage: FusionChildResultUsageMetadata;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function buildFusionChildResultMetadata(message: {
  provider: string;
  model: string;
  stopReason: string;
  content: ReadonlyArray<{ type: string; text?: string }>;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: { total: number };
  };
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
  };
  if (Number.isFinite(message.usage.cost.total) && message.usage.cost.total >= 0) {
    usage.costTotal = message.usage.cost.total;
  }
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
  pi.on('message_end', async (event) => {
    if (event.message.role !== 'assistant') return;
    await writeMetadata(buildFusionChildResultMetadata(event.message));
  });
}

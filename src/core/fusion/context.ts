import { createHash } from 'node:crypto';
import {
  buildSessionContext,
  convertToLlm,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import type { Message } from '@earendil-works/pi-ai';
import { canonicalJson } from '../attested-pi-run.js';
import { isJsonObject, type JsonObject } from '../common.js';
import {
  FUSION_BRANCH_FILTER_ID,
  FUSION_COMMAND_CONTEXT_POLICY_ID,
  FUSION_CONTEXT_LEDGER_SCHEMA_VERSION,
  FUSION_CONTEXT_TRANSFORM_ID,
  FUSION_IMAGE_OMISSION_PREFIX,
  FUSION_INPUT_SCHEMA_VERSION,
  FUSION_TOOL_CONTEXT_POLICY_ID,
  FusionError,
  type FusionBranchFilterDescriptor,
  type FusionCanonicalInputV2,
  type FusionCanonicalRequestV2,
  type FusionContextOmissionLedgerV1,
  type FusionContextPolicyDescriptor,
  type FusionConversationProjectionV2,
  type FusionOmittedEventKind,
  type FusionOmittedEventRecord,
  type FusionOmittedRunBytes,
  type FusionOmittedRunCounts,
  type FusionProjectionAccounting,
  type FusionProjectionEntry,
  type FusionProjectionOmissionEntry,
  type FusionProjectionTextEntry,
  type FusionRequestAuthority,
  type FusionSource,
  type FusionToolCallNameCount,
} from './types.js';

export const FUSION_BRAINSTORM_TOOL_NAME = 'fusion_brainstorm';

export interface FusionReadonlySessionManager {
  getLeafId(): string | null;
  getLeafEntry(): SessionEntry | undefined;
  getEntries(): SessionEntry[];
}

export interface FusionContextSource {
  cwd: string;
  sessionManager: FusionReadonlySessionManager;
  getSystemPrompt(): string;
}

export interface BuildFusionCanonicalInputOptions {
  source: FusionSource;
  request: string;
  toolCallId?: string;
  toolName?: string;
}

export interface BuiltFusionCanonicalInput {
  input: FusionCanonicalInputV2;
  serialized: string;
  ledger: FusionContextOmissionLedgerV1;
  transcriptLeafId: string | null;
}

export function normalizeFusionCommandRequest(args: string): string {
  return args.trim();
}

function entriesById(entries: readonly SessionEntry[]): Map<string, SessionEntry> {
  const byId = new Map<string, SessionEntry>();
  for (const entry of entries) byId.set(entry.id, entry);
  return byId;
}

function readArray(record: JsonObject, key: string): readonly unknown[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value : undefined;
}

function recordOf(value: unknown): JsonObject | undefined {
  if (!isJsonObject(value) || Array.isArray(value)) return undefined;
  return value;
}

function entryMessage(entry: SessionEntry): JsonObject | undefined {
  if (entry.type !== 'message') return undefined;
  return recordOf(entry.message);
}

function toolCallPartMatches(
  part: unknown,
  toolCallId: string | undefined,
  toolName: string,
): boolean {
  const record = recordOf(part);
  if (record === undefined || record['type'] !== 'toolCall') return false;
  if (toolCallId !== undefined) return record['id'] === toolCallId;
  return record['name'] === toolName;
}

function messageContainsToolCall(
  message: JsonObject,
  toolCallId: string | undefined,
  toolName: string,
): boolean {
  if (message['role'] !== 'assistant') return false;
  const content = readArray(message, 'content');
  if (content === undefined) return false;
  for (const part of content) {
    if (toolCallPartMatches(part, toolCallId, toolName)) return true;
  }
  return false;
}

interface EffectiveLeaf {
  leafId: string | null;
  activeToolCallLeafExcluded: boolean;
}

function effectiveLeafForTool(
  sessionManager: FusionReadonlySessionManager,
  toolCallId: string | undefined,
  toolName: string,
): EffectiveLeaf {
  const leaf = sessionManager.getLeafEntry();
  if (leaf === undefined)
    return { leafId: sessionManager.getLeafId(), activeToolCallLeafExcluded: false };
  const message = entryMessage(leaf);
  if (message !== undefined && messageContainsToolCall(message, toolCallId, toolName)) {
    return { leafId: leaf.parentId, activeToolCallLeafExcluded: true };
  }
  return { leafId: sessionManager.getLeafId(), activeToolCallLeafExcluded: false };
}

function effectiveLeaf(
  sessionManager: FusionReadonlySessionManager,
  options: BuildFusionCanonicalInputOptions,
): EffectiveLeaf {
  if (options.source !== 'tool')
    return { leafId: sessionManager.getLeafId(), activeToolCallLeafExcluded: false };
  return effectiveLeafForTool(
    sessionManager,
    options.toolCallId,
    options.toolName ?? FUSION_BRAINSTORM_TOOL_NAME,
  );
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256Text(value: string): string {
  return sha256Hex(Buffer.from(value, 'utf8'));
}

function uint64be(value: number): Buffer {
  const out = Buffer.alloc(8);
  out.writeBigUInt64BE(BigInt(value));
  return out;
}

/** Length-prefixed framing so concatenated fields cannot collide across boundaries. */
function lengthPrefixed(bytes: Buffer): Buffer {
  return Buffer.concat([uint64be(bytes.length), bytes]);
}

function ledgerLeafHash(index: number, record: FusionOmittedEventRecord): Buffer {
  return createHash('sha256')
    .update(Buffer.from('pi-fusion-ledger-leaf-v1\0', 'utf8'))
    .update(uint64be(index))
    .update(lengthPrefixed(Buffer.from(canonicalJson(record), 'utf8')))
    .digest();
}

function ledgerRunHash(leaves: readonly Buffer[], first: number): string {
  const hash = createHash('sha256')
    .update(Buffer.from('pi-fusion-ledger-run-v1\0', 'utf8'))
    .update(uint64be(first))
    .update(uint64be(leaves.length));
  for (const leaf of leaves) hash.update(leaf);
  return hash.digest('hex');
}

function ledgerRootHash(leaves: readonly Buffer[]): string {
  const hash = createHash('sha256')
    .update(Buffer.from('pi-fusion-ledger-root-v1\0', 'utf8'))
    .update(uint64be(leaves.length));
  for (const leaf of leaves) hash.update(leaf);
  return hash.digest('hex');
}

function unsupportedBlock(label: string): FusionError {
  return new FusionError(
    `fusion context projection encountered an unsupported conversation block: ${label}`,
    { code: 'context_policy_unsupported_block', childCreated: false },
  );
}

function contextPolicyId(source: FusionSource): string {
  return source === 'tool' ? FUSION_TOOL_CONTEXT_POLICY_ID : FUSION_COMMAND_CONTEXT_POLICY_ID;
}

function requestAuthority(source: FusionSource): FusionRequestAuthority {
  return source === 'tool' ? 'explicit_text' : 'directive_over_projected_conversation';
}

function policyDescriptor(source: FusionSource): FusionContextPolicyDescriptor {
  return {
    id: contextPolicyId(source),
    transform: FUSION_CONTEXT_TRANSFORM_ID,
    version: 1,
    user_text: 'verbatim',
    assistant_text: 'verbatim',
    assistant_thinking: 'ledger_only',
    tool_call_arguments: 'ledger_only',
    tool_results: 'ledger_only',
    tool_payload_preview_bytes: 0,
    images: 'marker_or_ledger_only',
    unknown_block_behavior: 'error',
  };
}

/**
 * Accumulates omitted-event ledger rows and turns maximal contiguous omitted
 * runs into compact, source-ordered receipts inside the canonical input.
 */
class ProjectionBuilder {
  private readonly entries: FusionProjectionEntry[] = [];
  private readonly ledger: FusionOmittedEventRecord[] = [];
  private readonly leaves: Buffer[] = [];
  private readonly toolCallNames = new Map<string, number>();
  private pendingCounts: Required<FusionOmittedRunCounts> | undefined;
  private pendingBytes: Required<FusionOmittedRunBytes> | undefined;
  private pendingLeaves: Buffer[] = [];
  private pendingLedgerFirst = 0;
  private pendingSourceFirst = 0;
  private pendingSourceLast = 0;

  includedUserTextBytes = 0;
  includedAssistantTextBytes = 0;
  includedImageMarkers = 0;
  emptyTextBlocks = 0;

  addText(entry: FusionProjectionTextEntry): void {
    this.flush();
    this.entries.push(entry);
    if (entry.role === 'user') this.includedUserTextBytes += utf8Bytes(entry.text);
    else this.includedAssistantTextBytes += utf8Bytes(entry.text);
  }

  addOmission(
    sourceOrdinal: number,
    blockOrdinal: number,
    kind: FusionOmittedEventKind,
    payload: Buffer,
    extra: { toolName?: string; toolCallId?: string; mimeType?: string } = {},
  ): void {
    const index = this.ledger.length;
    const record: FusionOmittedEventRecord = {
      index,
      source_ordinal: sourceOrdinal,
      block_ordinal: blockOrdinal,
      kind,
      payload_bytes: payload.length,
      payload_sha256: sha256Hex(payload),
    };
    if (extra.toolName !== undefined) record.tool_name = extra.toolName;
    if (extra.toolCallId !== undefined) record.tool_call_id = extra.toolCallId;
    if (extra.mimeType !== undefined) record.mime_type = extra.mimeType;
    this.ledger.push(record);
    const leaf = ledgerLeafHash(index, record);
    this.leaves.push(leaf);

    if (extra.toolName !== undefined && kind === 'tool_call') {
      this.toolCallNames.set(extra.toolName, (this.toolCallNames.get(extra.toolName) ?? 0) + 1);
    }

    if (this.pendingCounts === undefined || this.pendingBytes === undefined) {
      this.pendingCounts = {
        assistant_thinking: 0,
        tool_calls: 0,
        tool_result_texts: 0,
        tool_result_images: 0,
      };
      this.pendingBytes = {
        assistant_thinking: 0,
        tool_call_arguments: 0,
        tool_result_text: 0,
        tool_result_image: 0,
      };
      this.pendingLeaves = [];
      this.pendingLedgerFirst = index;
      this.pendingSourceFirst = sourceOrdinal;
    }
    this.pendingSourceLast = sourceOrdinal;
    this.pendingLeaves.push(leaf);
    if (kind === 'assistant_thinking') {
      this.pendingCounts.assistant_thinking += 1;
      this.pendingBytes.assistant_thinking += payload.length;
    } else if (kind === 'tool_call') {
      this.pendingCounts.tool_calls += 1;
      this.pendingBytes.tool_call_arguments += payload.length;
    } else if (kind === 'tool_result_text') {
      this.pendingCounts.tool_result_texts += 1;
      this.pendingBytes.tool_result_text += payload.length;
    } else {
      this.pendingCounts.tool_result_images += 1;
      this.pendingBytes.tool_result_image += payload.length;
    }
  }

  private flush(): void {
    const counts = this.pendingCounts;
    const bytes = this.pendingBytes;
    if (counts === undefined || bytes === undefined) return;
    const entry: FusionProjectionOmissionEntry = {
      kind: 'omitted_activity',
      source_ordinal_first: this.pendingSourceFirst,
      source_ordinal_last: this.pendingSourceLast,
      ledger_index_first: this.pendingLedgerFirst,
      ledger_index_last: this.pendingLedgerFirst + this.pendingLeaves.length - 1,
      counts: compactCounts(counts),
      payload_bytes: compactBytes(bytes),
      ledger_run_sha256: ledgerRunHash(this.pendingLeaves, this.pendingLedgerFirst),
    };
    this.entries.push(entry);
    this.pendingCounts = undefined;
    this.pendingBytes = undefined;
    this.pendingLeaves = [];
  }

  finish(
    source: FusionSource,
    branchFilter: FusionBranchFilterDescriptor,
    messageCount: number,
  ): { projection: FusionConversationProjectionV2; ledger: FusionContextOmissionLedgerV1 } {
    this.flush();
    const rootSha256 = ledgerRootHash(this.leaves);
    let omittedRunCount = 0;
    let includedTextEntries = 0;
    let thinkingBytes = 0;
    let toolCallCount = 0;
    let toolArgumentBytes = 0;
    let toolResultTextCount = 0;
    let toolResultTextBytes = 0;
    let toolResultImageCount = 0;
    let toolResultImageBytes = 0;
    for (const entry of this.entries) {
      if (entry.kind === 'text') {
        includedTextEntries += 1;
        continue;
      }
      omittedRunCount += 1;
      thinkingBytes += entry.payload_bytes.assistant_thinking ?? 0;
      toolCallCount += entry.counts.tool_calls ?? 0;
      toolArgumentBytes += entry.payload_bytes.tool_call_arguments ?? 0;
      toolResultTextCount += entry.counts.tool_result_texts ?? 0;
      toolResultTextBytes += entry.payload_bytes.tool_result_text ?? 0;
      toolResultImageCount += entry.counts.tool_result_images ?? 0;
      toolResultImageBytes += entry.payload_bytes.tool_result_image ?? 0;
    }
    const toolCallNames: FusionToolCallNameCount[] = [...this.toolCallNames.entries()]
      .map(([name, calls]) => ({ name, calls }))
      .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    const accounting: FusionProjectionAccounting = {
      message_count: messageCount,
      included_text_entry_count: includedTextEntries,
      included_user_text_bytes: this.includedUserTextBytes,
      included_assistant_text_bytes: this.includedAssistantTextBytes,
      included_image_marker_count: this.includedImageMarkers,
      empty_text_block_count: this.emptyTextBlocks,
      omitted_run_count: omittedRunCount,
      omitted_event_count: this.ledger.length,
      omitted_thinking_bytes: thinkingBytes,
      omitted_tool_call_count: toolCallCount,
      omitted_tool_call_argument_bytes: toolArgumentBytes,
      omitted_tool_result_text_count: toolResultTextCount,
      omitted_tool_result_text_bytes: toolResultTextBytes,
      omitted_tool_result_image_count: toolResultImageCount,
      omitted_tool_result_image_bytes: toolResultImageBytes,
      tool_call_names: toolCallNames,
      ledger_entry_count: this.ledger.length,
      ledger_root_sha256: rootSha256,
    };
    return {
      projection: {
        policy: policyDescriptor(source),
        branch_filter: branchFilter,
        entries: this.entries,
        accounting,
      },
      ledger: {
        schema_version: FUSION_CONTEXT_LEDGER_SCHEMA_VERSION,
        policy_id: contextPolicyId(source),
        transform: FUSION_CONTEXT_TRANSFORM_ID,
        entries: this.ledger,
        root_sha256: rootSha256,
      },
    };
  }
}

function imageMarker(mimeType: string): string {
  return `${FUSION_IMAGE_OMISSION_PREFIX}${mimeType}]`;
}

/**
 * Fixed policy rule: a zero-valued kind is absent from the receipt rather than
 * serialized as `0`. This keeps receipts compact without losing information —
 * absent is defined by the policy version to mean exactly zero — and it is
 * applied unconditionally, never adaptively because an input happens to be large.
 */
function compactCounts(counts: Required<FusionOmittedRunCounts>): FusionOmittedRunCounts {
  const out: FusionOmittedRunCounts = {};
  if (counts.assistant_thinking > 0) out.assistant_thinking = counts.assistant_thinking;
  if (counts.tool_calls > 0) out.tool_calls = counts.tool_calls;
  if (counts.tool_result_texts > 0) out.tool_result_texts = counts.tool_result_texts;
  if (counts.tool_result_images > 0) out.tool_result_images = counts.tool_result_images;
  return out;
}

function compactBytes(bytes: Required<FusionOmittedRunBytes>): FusionOmittedRunBytes {
  const out: FusionOmittedRunBytes = {};
  if (bytes.assistant_thinking > 0) out.assistant_thinking = bytes.assistant_thinking;
  if (bytes.tool_call_arguments > 0) out.tool_call_arguments = bytes.tool_call_arguments;
  if (bytes.tool_result_text > 0) out.tool_result_text = bytes.tool_result_text;
  if (bytes.tool_result_image > 0) out.tool_result_image = bytes.tool_result_image;
  return out;
}

/**
 * Projects one user-role message. User text is retained verbatim; images stay
 * marker-only so the child never receives raw bytes.
 */
function projectUserMessage(
  builder: ProjectionBuilder,
  content: Message['content'],
  sourceOrdinal: number,
): void {
  if (typeof content === 'string') {
    if (content.length === 0) {
      builder.emptyTextBlocks += 1;
      return;
    }
    builder.addText({
      kind: 'text',
      source_ordinal: sourceOrdinal,
      block_ordinal: 0,
      role: 'user',
      text: content,
    });
    return;
  }
  for (const [blockOrdinal, block] of content.entries()) {
    if (block.type === 'text') {
      if (block.text.length === 0) {
        builder.emptyTextBlocks += 1;
        continue;
      }
      builder.addText({
        kind: 'text',
        source_ordinal: sourceOrdinal,
        block_ordinal: blockOrdinal,
        role: 'user',
        text: block.text,
      });
      continue;
    }
    if (block.type === 'image') {
      builder.includedImageMarkers += 1;
      builder.addText({
        kind: 'text',
        source_ordinal: sourceOrdinal,
        block_ordinal: blockOrdinal,
        role: 'user',
        text: imageMarker(block.mimeType),
      });
      continue;
    }
    throw unsupportedBlock(`user block ${String(Reflect.get(block, 'type'))}`);
  }
}

function projectAssistantMessage(
  builder: ProjectionBuilder,
  content: Extract<Message, { role: 'assistant' }>['content'],
  sourceOrdinal: number,
): void {
  for (const [blockOrdinal, block] of content.entries()) {
    if (block.type === 'text') {
      if (block.text.length === 0) {
        builder.emptyTextBlocks += 1;
        continue;
      }
      builder.addText({
        kind: 'text',
        source_ordinal: sourceOrdinal,
        block_ordinal: blockOrdinal,
        role: 'assistant',
        text: block.text,
      });
      continue;
    }
    if (block.type === 'thinking') {
      builder.addOmission(
        sourceOrdinal,
        blockOrdinal,
        'assistant_thinking',
        Buffer.from(block.thinking, 'utf8'),
      );
      continue;
    }
    if (block.type === 'toolCall') {
      builder.addOmission(
        sourceOrdinal,
        blockOrdinal,
        'tool_call',
        Buffer.from(canonicalJson(block.arguments), 'utf8'),
        { toolName: block.name, toolCallId: block.id },
      );
      continue;
    }
    throw unsupportedBlock(`assistant block ${String(Reflect.get(block, 'type'))}`);
  }
}

function projectToolResultMessage(
  builder: ProjectionBuilder,
  message: Extract<Message, { role: 'toolResult' }>,
  sourceOrdinal: number,
): void {
  const content = message.content;
  if (typeof content === 'string') {
    builder.addOmission(
      sourceOrdinal,
      0,
      'tool_result_text',
      Buffer.from(content, 'utf8'),
      { toolName: message.toolName, toolCallId: message.toolCallId },
    );
    return;
  }
  for (const [blockOrdinal, block] of content.entries()) {
    if (block.type === 'text') {
      builder.addOmission(
        sourceOrdinal,
        blockOrdinal,
        'tool_result_text',
        Buffer.from(block.text, 'utf8'),
        { toolName: message.toolName, toolCallId: message.toolCallId },
      );
      continue;
    }
    if (block.type === 'image') {
      builder.addOmission(
        sourceOrdinal,
        blockOrdinal,
        'tool_result_image',
        Buffer.from(block.data, 'utf8'),
        {
          toolName: message.toolName,
          toolCallId: message.toolCallId,
          mimeType: block.mimeType,
        },
      );
      continue;
    }
    throw unsupportedBlock(`tool result block ${String(Reflect.get(block, 'type'))}`);
  }
}

/**
 * Deterministic conversation projection. Every retained source block receives
 * exactly one disposition: included verbatim, or represented as an omission
 * ledger row. Unknown block types fail loudly instead of disappearing.
 */
export function projectFusionConversation(
  messages: readonly Message[],
  source: FusionSource,
  branchFilter: FusionBranchFilterDescriptor,
): { projection: FusionConversationProjectionV2; ledger: FusionContextOmissionLedgerV1 } {
  const builder = new ProjectionBuilder();
  for (const [sourceOrdinal, message] of messages.entries()) {
    if (message.role === 'user') projectUserMessage(builder, message.content, sourceOrdinal);
    else if (message.role === 'assistant')
      projectAssistantMessage(builder, message.content, sourceOrdinal);
    else if (message.role === 'toolResult')
      projectToolResultMessage(builder, message, sourceOrdinal);
    else throw unsupportedBlock(`message role ${String(Reflect.get(message, 'role'))}`);
  }
  return builder.finish(source, branchFilter, messages.length);
}

export function buildFusionCanonicalInput(
  ctx: FusionContextSource,
  options: BuildFusionCanonicalInputOptions,
): BuiltFusionCanonicalInput {
  if (options.request.trim().length === 0) {
    throw new FusionError('fusion request must not be blank', {
      code: 'context_capture_failed',
      childCreated: false,
    });
  }
  const entries = ctx.sessionManager.getEntries();
  const leaf = effectiveLeaf(ctx.sessionManager, options);
  const sessionContext = buildSessionContext(entries, leaf.leafId, entriesById(entries));
  const llmMessages = convertToLlm(sessionContext.messages);
  const toolName = options.toolName ?? FUSION_BRAINSTORM_TOOL_NAME;
  const branchFilter: FusionBranchFilterDescriptor = {
    id: FUSION_BRANCH_FILTER_ID,
    tool_name: toolName,
    tool_call_id: options.source === 'tool' ? (options.toolCallId ?? null) : null,
    active_tool_call_leaf_excluded: leaf.activeToolCallLeafExcluded,
  };
  const projected = projectFusionConversation(llmMessages, options.source, branchFilter);
  const request: FusionCanonicalRequestV2 = {
    source: options.source,
    authority: requestAuthority(options.source),
    text: options.request,
    sha256: sha256Text(options.request),
  };
  const input: FusionCanonicalInputV2 = {
    schema_version: FUSION_INPUT_SCHEMA_VERSION,
    cwd: ctx.cwd,
    system_prompt: ctx.getSystemPrompt(),
    request,
    conversation_projection: projected.projection,
  };
  return {
    input,
    serialized: canonicalJson(input),
    ledger: projected.ledger,
    transcriptLeafId: leaf.leafId,
  };
}

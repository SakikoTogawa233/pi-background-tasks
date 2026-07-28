import {
  buildSessionContext,
  convertToLlm,
  serializeConversation,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { canonicalJson } from '../attested-pi-run.js';
import { isJsonObject } from '../common.js';
import {
  FUSION_INPUT_SCHEMA_VERSION,
  FusionError,
  type FusionCanonicalInputV1,
  type FusionSource,
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
  input: FusionCanonicalInputV1;
  serialized: string;
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

function readArray(record: Record<string, unknown>, key: string): readonly unknown[] | undefined {
  const value = record[key];
  return Array.isArray(value) ? value : undefined;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (!isJsonObject(value) || Array.isArray(value)) return undefined;
  return value;
}

function entryMessage(entry: SessionEntry): Record<string, unknown> | undefined {
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
  message: Record<string, unknown>,
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

function effectiveLeafForTool(
  sessionManager: FusionReadonlySessionManager,
  toolCallId: string | undefined,
  toolName: string,
): string | null {
  const leaf = sessionManager.getLeafEntry();
  if (leaf === undefined) return sessionManager.getLeafId();
  const message = entryMessage(leaf);
  if (message !== undefined && messageContainsToolCall(message, toolCallId, toolName)) {
    return leaf.parentId;
  }
  return sessionManager.getLeafId();
}

function effectiveLeafId(
  sessionManager: FusionReadonlySessionManager,
  options: BuildFusionCanonicalInputOptions,
): string | null {
  if (options.source !== 'tool') return sessionManager.getLeafId();
  return effectiveLeafForTool(
    sessionManager,
    options.toolCallId,
    options.toolName ?? FUSION_BRAINSTORM_TOOL_NAME,
  );
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
  const leafId = effectiveLeafId(ctx.sessionManager, options);
  const sessionContext = buildSessionContext(entries, leafId, entriesById(entries));
  const llmMessages = convertToLlm(sessionContext.messages);
  const input: FusionCanonicalInputV1 = {
    schema_version: FUSION_INPUT_SCHEMA_VERSION,
    cwd: ctx.cwd,
    system_prompt: ctx.getSystemPrompt(),
    conversation_transcript: serializeConversation(llmMessages),
    request: options.request,
  };
  return { input, serialized: canonicalJson(input), transcriptLeafId: leafId };
}

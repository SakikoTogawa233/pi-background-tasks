import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import {
  buildFusionCanonicalInput,
  type BuildFusionCanonicalInputOptions,
  type BuiltFusionCanonicalInput,
} from '../../src/core/fusion/context.js';
import type {
  FusionCanonicalInputV2,
  FusionContextOmissionLedgerV1,
  FusionProjectionEntry,
  FusionProjectionOmissionEntry,
  FusionProjectionTextEntry,
  FusionUsage,
} from '../../src/core/fusion/types.js';

export function testUsage(): FusionUsage {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function userMessage(content: UserMessage['content'], timestamp = 1): UserMessage {
  return { role: 'user', content, timestamp };
}

export function assistantMessage(
  content: AssistantMessage['content'],
  timestamp = 2,
): AssistantMessage {
  return {
    role: 'assistant',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    model: 'gpt-5.5',
    usage: testUsage(),
    stopReason: 'toolUse',
    content,
    timestamp,
  };
}

export function toolResultMessage(
  toolCallId: string,
  toolName: string,
  content: ToolResultMessage['content'],
  timestamp = 3,
): ToolResultMessage {
  return {
    role: 'toolResult',
    toolCallId,
    toolName,
    content,
    details: { ok: true },
    isError: false,
    timestamp,
  };
}

export function sessionWith(messages: readonly (UserMessage | AssistantMessage | ToolResultMessage)[]) {
  const session = SessionManager.inMemory('/tmp/project');
  for (const message of messages) session.appendMessage(message);
  return session;
}

export function buildFrom(
  messages: readonly (UserMessage | AssistantMessage | ToolResultMessage)[],
  options: BuildFusionCanonicalInputOptions,
  systemPrompt = 'system',
): BuiltFusionCanonicalInput {
  const session = sessionWith(messages);
  return buildFusionCanonicalInput(
    { cwd: '/tmp/project', sessionManager: session, getSystemPrompt: () => systemPrompt },
    options,
  );
}

export function textEntries(
  input: FusionCanonicalInputV2,
): readonly FusionProjectionTextEntry[] {
  return input.conversation_projection.entries.filter(
    (entry): entry is FusionProjectionTextEntry => entry.kind === 'text',
  );
}

export function omissionEntries(
  input: FusionCanonicalInputV2,
): readonly FusionProjectionOmissionEntry[] {
  return input.conversation_projection.entries.filter(
    (entry): entry is FusionProjectionOmissionEntry => entry.kind === 'omitted_activity',
  );
}

export function projectedText(input: FusionCanonicalInputV2): string {
  return textEntries(input)
    .map((entry) => entry.text)
    .join('\n');
}

export function entryKinds(input: FusionCanonicalInputV2): readonly FusionProjectionEntry['kind'][] {
  return input.conversation_projection.entries.map((entry) => entry.kind);
}

/** Minimal ledger for orchestrator tests that supply a hand-built canonical input. */
export function emptyLedger(policyId: string): FusionContextOmissionLedgerV1 {
  return {
    schema_version: 'pi-background-tasks.fusion-context-ledger.v1',
    policy_id: policyId,
    transform: 'visible-conversation-ledger-v1',
    entries: [],
    root_sha256: 'a'.repeat(64),
  };
}

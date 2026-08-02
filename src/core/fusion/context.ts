import { createHash } from 'node:crypto';
import { canonicalJson } from '../attested-pi-run.js';
import {
  projectVisibleConversationV2,
  type ProjectedConversationV2,
} from '../context/visible-conversation-v2.js';
import {
  snapshotParentConversation,
  type ParentContextSource,
  type ParentSnapshotOptions,
  type ReadonlyParentSessionManager,
} from '../context/parent-snapshot.js';
import type { Message } from '@earendil-works/pi-ai';
import {
  FUSION_BRANCH_FILTER_ID,
  FUSION_COMMAND_CONTEXT_POLICY_ID,
  FUSION_CONTEXT_LEDGER_SCHEMA_VERSION,
  FUSION_CONTEXT_TRANSFORM_ID,
  FUSION_INPUT_SCHEMA_VERSION,
  FUSION_TOOL_CONTEXT_POLICY_ID,
  FusionError,
  type FusionBranchFilterDescriptor,
  type FusionCanonicalInputV3,
  type FusionCanonicalRequestV3,
  type FusionContextOmissionLedgerV2,
  type FusionContextPolicyDescriptor,
  type FusionConversationProjectionV3,
  type FusionRequestAuthority,
  type FusionSource,
} from './types.js';

export const FUSION_BRAINSTORM_TOOL_NAME = 'fusion_brainstorm';

/** Retained for source compatibility; Fusion's session access is the shared adapter. */
export type FusionReadonlySessionManager = ReadonlyParentSessionManager;
export type FusionContextSource = ParentContextSource;

export interface BuildFusionCanonicalInputOptions {
  source: FusionSource;
  request: string;
  toolCallId?: string;
  toolName?: string;
}

export interface BuiltFusionCanonicalInput {
  input: FusionCanonicalInputV3;
  serialized: string;
  ledger: FusionContextOmissionLedgerV2;
  transcriptLeafId: string | null;
}

export function normalizeFusionCommandRequest(args: string): string {
  return args.trim();
}

function sha256Text(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
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
    version: 2,
    receipt_format: 'omitted_activity.v2',
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
 * Seal the shared transform output into Fusion's versioned envelopes.
 *
 * Field values and construction order are preserved exactly as Fusion has always
 * emitted them. The ledger root commits only to ledger rows, so sealing under a
 * Fusion envelope cannot change it. `tests/unit/fusion-golden-bytes.test.ts`
 * proves the resulting bytes are unchanged.
 */
function sealFusionProjection(
  projected: ProjectedConversationV2,
  source: FusionSource,
  branchFilter: FusionBranchFilterDescriptor,
): { projection: FusionConversationProjectionV3; ledger: FusionContextOmissionLedgerV2 } {
  return {
    projection: {
      policy: policyDescriptor(source),
      branch_filter: branchFilter,
      entries: projected.entries,
      accounting: projected.accounting,
    },
    ledger: {
      schema_version: FUSION_CONTEXT_LEDGER_SCHEMA_VERSION,
      policy_id: contextPolicyId(source),
      transform: FUSION_CONTEXT_TRANSFORM_ID,
      entries: projected.ledger.entries,
      projection_map: projected.ledger.projection_map,
      root_sha256: projected.ledger.root_sha256,
    },
  };
}

/** Preserved public entry point; delegates to the shared frozen transform. */
export function projectFusionConversation(
  messages: readonly Message[],
  source: FusionSource,
  branchFilter: FusionBranchFilterDescriptor,
): { projection: FusionConversationProjectionV3; ledger: FusionContextOmissionLedgerV2 } {
  return sealFusionProjection(projectVisibleConversationV2(messages), source, branchFilter);
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
  const toolName = options.toolName ?? FUSION_BRAINSTORM_TOOL_NAME;
  const snapshotOptions: ParentSnapshotOptions = {
    toolName,
    excludeActiveToolCallLeaf: options.source === 'tool',
  };
  if (options.toolCallId !== undefined) snapshotOptions.toolCallId = options.toolCallId;
  const snapshot = snapshotParentConversation(ctx, snapshotOptions);
  const branchFilter: FusionBranchFilterDescriptor = {
    id: FUSION_BRANCH_FILTER_ID,
    tool_name: toolName,
    tool_call_id: options.source === 'tool' ? (options.toolCallId ?? null) : null,
    active_tool_call_leaf_excluded: snapshot.activeToolCallLeafExcluded,
  };
  const projected = projectFusionConversation(snapshot.messages, options.source, branchFilter);
  const request: FusionCanonicalRequestV3 = {
    source: options.source,
    authority: requestAuthority(options.source),
    text: options.request,
    sha256: sha256Text(options.request),
  };
  const input: FusionCanonicalInputV3 = {
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
    transcriptLeafId: snapshot.leafId,
  };
}

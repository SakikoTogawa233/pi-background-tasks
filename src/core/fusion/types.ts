import type { Usage } from '@earendil-works/pi-ai';

export type FusionThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export const FUSION_MODEL_CONFIG_SCHEMA_VERSION = 'pi-background-tasks.fusion-models.v1';
export const FUSION_INPUT_SCHEMA_VERSION = 'pi-background-tasks.fusion-input.v3';
export const FUSION_EVALUATION_SCHEMA_VERSION = 'pi-background-tasks.fusion-evaluation.v1';
export const FUSION_RESULT_SCHEMA_VERSION = 'pi-background-tasks.fusion-result.v2';
export const FUSION_MANIFEST_SCHEMA_VERSION = 'pi-background-tasks.fusion-manifest.v2';
export const FUSION_CONTEXT_LEDGER_SCHEMA_VERSION = 'pi-background-tasks.fusion-context-ledger.v2';
export const FUSION_BUDGET_PLAN_SCHEMA_VERSION = 'pi-background-tasks.fusion-budget-plan.v2';

/**
 * Conversation-projection transform shared by every Fusion entry point.
 *
 * The transform keeps visible user/assistant conversational text verbatim and
 * replaces assistant thinking plus all tool traffic with deterministic,
 * hash-accounted omission receipts. It never truncates retained text and never
 * forwards raw image bytes.
 */
export const FUSION_CONTEXT_TRANSFORM_ID = 'visible-conversation-ledger-v2';
export const FUSION_BRANCH_FILTER_ID = 'exclude-active-fusion-subtree-v1';

/** Entry-point specific context policies. Both use the same payload-exclusion transform. */
export const FUSION_TOOL_CONTEXT_POLICY_ID = 'fusion-tool-explicit-v2';
export const FUSION_COMMAND_CONTEXT_POLICY_ID = 'fusion-command-conversation-v2';

export const FUSION_IMAGE_OMISSION_PREFIX = '[Image omitted from fusion text transcript: ';

export const FUSION_CANDIDATE_IDS = ['A', 'B', 'C'] as const;
export type FusionCandidateId = (typeof FUSION_CANDIDATE_IDS)[number];

export const FUSION_STAGE_VALUES = ['candidate', 'evaluation', 'merge'] as const;
export type FusionStage = (typeof FUSION_STAGE_VALUES)[number];

/**
 * Prompt-expansion stages guarded by deterministic size accounting. `evaluation`
 * and `evaluation_repair` share the evaluator model but render different prompts.
 */
export const FUSION_BUDGET_STAGE_VALUES = [
  'candidate',
  'evaluation',
  'evaluation_repair',
  'merge',
] as const;
export type FusionBudgetStage = (typeof FUSION_BUDGET_STAGE_VALUES)[number];

export const FUSION_SOURCE_VALUES = ['command', 'tool'] as const;
export type FusionSource = (typeof FUSION_SOURCE_VALUES)[number];

export const FUSION_STATE_VALUES = [
  'initializing',
  'candidates_running',
  'candidates_complete',
  'evaluating',
  'evaluation_complete',
  'merging',
  'completed',
  'failed',
  'cancelled',
] as const;
export type FusionState = (typeof FUSION_STATE_VALUES)[number];
export type FusionTerminalState = Extract<FusionState, 'completed' | 'failed' | 'cancelled'>;
export type FusionNonterminalState = Exclude<FusionState, FusionTerminalState>;

export const FUSION_NONTERMINAL_STATE_VALUES = [
  'initializing',
  'candidates_running',
  'candidates_complete',
  'evaluating',
  'evaluation_complete',
  'merging',
] as const satisfies readonly FusionNonterminalState[];

export const FUSION_TERMINAL_STATE_VALUES = ['completed', 'failed', 'cancelled'] as const;

export type FusionModelSelection = '$current' | string;

export interface FusionModelConfigV1 {
  schema_version: typeof FUSION_MODEL_CONFIG_SCHEMA_VERSION;
  candidates: readonly [FusionModelSelection, FusionModelSelection, FusionModelSelection];
  evaluator: FusionModelSelection;
  merger: FusionModelSelection;
}

export interface FusionModelConfigRevision {
  path: string;
  exists: boolean;
  sha256: string | null;
}

export interface LoadedFusionModelConfig {
  config: FusionModelConfigV1;
  revision: FusionModelConfigRevision;
}

export interface ResolvedFusionModel {
  selection: string;
  source: 'current' | 'configured';
  provider: string;
  model: string;
  qualifiedId: string;
  thinkingLevel: FusionThinkingLevel;
  contextWindow: number;
}

export interface ResolvedFusionModels {
  candidates: readonly [ResolvedFusionModel, ResolvedFusionModel, ResolvedFusionModel];
  evaluator: ResolvedFusionModel;
  merger: ResolvedFusionModel;
}

export type FusionRequestAuthority = 'explicit_text' | 'directive_over_projected_conversation';

export interface FusionCanonicalRequestV3 {
  /** Entry point that produced this request. */
  source: FusionSource;
  /** How children must weigh `text` against the projected conversation. */
  authority: FusionRequestAuthority;
  /** Verbatim request text. Never clipped, never rewritten. */
  text: string;
  /** Lowercase SHA-256 of the UTF-8 request bytes. */
  sha256: string;
}

export const FUSION_OMITTED_EVENT_KINDS = [
  'assistant_thinking',
  'tool_call',
  'tool_result_text',
  'tool_result_image',
] as const;
export type FusionOmittedEventKind = (typeof FUSION_OMITTED_EVENT_KINDS)[number];

/** One omitted conversation event. Ledger rows never leave the local artifact directory. */
export interface FusionOmittedEventRecord {
  index: number;
  source_ordinal: number;
  block_ordinal: number;
  kind: FusionOmittedEventKind;
  payload_bytes: number;
  payload_sha256: string;
  tool_name?: string;
  tool_call_id?: string;
  mime_type?: string;
}

export interface FusionOmittedActivityProjectionMapEntry {
  canonical_entry_index: number;
  entry_kind: 'omitted_activity';
  ledger_index_first: number;
  ledger_index_last: number;
}

export interface FusionLedgerOnlyImageProjectionMapEntry {
  entry_kind: 'ledger_only_tool_result_image';
  ledger_index_first: number;
  ledger_index_last: number;
}

export type FusionContextProjectionMapEntry =
  | FusionOmittedActivityProjectionMapEntry
  | FusionLedgerOnlyImageProjectionMapEntry;

export interface FusionContextOmissionLedgerV2 {
  schema_version: typeof FUSION_CONTEXT_LEDGER_SCHEMA_VERSION;
  policy_id: string;
  transform: typeof FUSION_CONTEXT_TRANSFORM_ID;
  entries: readonly FusionOmittedEventRecord[];
  projection_map: readonly FusionContextProjectionMapEntry[];
  root_sha256: string;
}

export interface FusionProjectionTextEntry {
  kind: 'text';
  source_ordinal: number;
  block_ordinal: number;
  role: 'user' | 'assistant';
  text: string;
}

/**
 * Per-kind counts for one omitted run. Zero-valued kinds are omitted from the
 * serialized receipt by a fixed policy rule so receipt size does not scale with
 * the number of tracked kinds; absent means exactly zero.
 */
export interface FusionOmittedRunCounts {
  assistant_thinking?: number;
  tool_calls?: number;
  tool_result_texts?: number;
}

export interface FusionProjectionOmissionEntry {
  kind: 'omitted_activity';
  at: readonly [number, number];
  bytes: number;
  counts: FusionOmittedRunCounts;
}

export type FusionProjectionEntry = FusionProjectionTextEntry | FusionProjectionOmissionEntry;

export interface FusionContextPolicyDescriptor {
  id: string;
  transform: typeof FUSION_CONTEXT_TRANSFORM_ID;
  version: 2;
  receipt_format: 'omitted_activity.v2';
  user_text: 'verbatim';
  assistant_text: 'verbatim';
  assistant_thinking: 'ledger_only';
  tool_call_arguments: 'ledger_only';
  tool_results: 'ledger_only';
  tool_payload_preview_bytes: 0;
  images: 'marker_or_ledger_only';
  unknown_block_behavior: 'error';
}

export interface FusionBranchFilterDescriptor {
  id: typeof FUSION_BRANCH_FILTER_ID;
  tool_name: string;
  tool_call_id: string | null;
  active_tool_call_leaf_excluded: boolean;
}

export interface FusionToolCallNameCount {
  name: string;
  calls: number;
}

export interface FusionProjectionAccounting {
  message_count: number;
  included_text_entry_count: number;
  included_user_text_bytes: number;
  included_assistant_text_bytes: number;
  included_image_marker_count: number;
  empty_text_block_count: number;
  omitted_run_count: number;
  omitted_event_count: number;
  omitted_thinking_bytes: number;
  omitted_tool_call_count: number;
  omitted_tool_call_argument_bytes: number;
  omitted_tool_result_text_count: number;
  omitted_tool_result_text_bytes: number;
  omitted_tool_result_image_count: number;
  omitted_tool_result_image_bytes: number;
  tool_call_names: readonly FusionToolCallNameCount[];
  ledger_entry_count: number;
  ledger_root_sha256: string;
  omission_receipt_utf8_bytes: number;
}

export interface FusionConversationProjectionV3 {
  policy: FusionContextPolicyDescriptor;
  branch_filter: FusionBranchFilterDescriptor;
  entries: readonly FusionProjectionEntry[];
  accounting: FusionProjectionAccounting;
}

export interface FusionCanonicalInputV3 {
  schema_version: typeof FUSION_INPUT_SCHEMA_VERSION;
  cwd: string;
  system_prompt: string;
  request: FusionCanonicalRequestV3;
  conversation_projection: FusionConversationProjectionV3;
}

export interface CandidateAssessment {
  candidate_id: FusionCandidateId;
  summary: string;
  strengths: readonly string[];
  limitations: readonly string[];
  useful_contributions: readonly string[];
  risks: readonly string[];
}

export interface FusionConflictPosition {
  candidate_id: FusionCandidateId;
  position: string;
}

export interface FusionConflict {
  topic: string;
  positions: readonly FusionConflictPosition[];
  resolution: string;
}

export interface FusionSynthesisContribution {
  candidate_id: FusionCandidateId;
  contribution: string;
}

export interface FusionSynthesisPlan {
  must_include: readonly FusionSynthesisContribution[];
  must_resolve: readonly string[];
  must_avoid: readonly string[];
}

export interface FusionEvaluationV1 {
  schema_version: typeof FUSION_EVALUATION_SCHEMA_VERSION;
  candidate_assessments: readonly [CandidateAssessment, CandidateAssessment, CandidateAssessment];
  agreements: readonly string[];
  conflicts: readonly FusionConflict[];
  synthesis_plan: FusionSynthesisPlan;
}

/** Exact Pi usage contract used at the child, artifact, and host tool-result boundaries. */
export type FusionUsage = Usage;

const EMPTY_FUSION_COST: Usage['cost'] = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
});

export const EMPTY_FUSION_USAGE: FusionUsage = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: EMPTY_FUSION_COST,
});

export function createEmptyFusionUsage(): FusionUsage {
  return cloneFusionUsage(EMPTY_FUSION_USAGE);
}

export function cloneFusionUsage(usage: FusionUsage): FusionUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    cost: {
      input: usage.cost.input,
      output: usage.cost.output,
      cacheRead: usage.cost.cacheRead,
      cacheWrite: usage.cost.cacheWrite,
      total: usage.cost.total,
    },
  };
}

export function addFusionUsage(target: FusionUsage, delta: FusionUsage): void {
  target.input += delta.input;
  target.output += delta.output;
  target.cacheRead += delta.cacheRead;
  target.cacheWrite += delta.cacheWrite;
  target.totalTokens += delta.totalTokens;
  target.cost.input += delta.cost.input;
  target.cost.output += delta.cost.output;
  target.cost.cacheRead += delta.cost.cacheRead;
  target.cost.cacheWrite += delta.cost.cacheWrite;
  target.cost.total += delta.cost.total;
}

export interface FusionResultDetails {
  schema_version: typeof FUSION_RESULT_SCHEMA_VERSION;
  run_id: string;
  source: FusionSource;
  status: 'completed';
  artifact_dir: string;
  models: {
    candidates: readonly [string, string, string];
    evaluator: string;
    merger: string;
    thinking_level: string;
  };
  evaluator_attempts: number;
  usage: FusionUsage;
}

export type FusionProgressEvent =
  | { type: 'state'; state: FusionState }
  | { type: 'candidate_started'; slot: 1 | 2 | 3; attempt: number }
  | { type: 'candidate_completed'; slot: 1 | 2 | 3; completed: number; total: 3 }
  | { type: 'evaluation_started'; attempt: 1 | 2; repair: boolean }
  | { type: 'evaluation_retry'; errors: readonly string[] }
  | { type: 'budget_warning'; warnings: readonly FusionBudgetWarning[]; error: string }
  | { type: 'merge_started' }
  | { type: 'completed'; runId: string; artifactDir: string }
  | { type: 'failed'; runId: string; artifactDir: string; error: string }
  | { type: 'cancelled'; runId: string; artifactDir: string; reason: string };

export type FusionErrorCode =
  | 'config_invalid'
  | 'config_conflict'
  | 'model_unavailable'
  | 'context_capture_failed'
  | 'context_policy_unsupported_block'
  | 'prompt_budget_exceeded'
  | 'model_capacity_unknown'
  | 'child_spawn_failed'
  | 'child_stdin_failed'
  | 'child_event_invalid'
  | 'child_exit_failed'
  | 'child_timeout'
  | 'child_output_cap'
  | 'child_cancelled'
  | 'evaluation_invalid'
  | 'artifact_error'
  | 'state_transition_invalid'
  | 'orchestration_failed';

/** Structured detail attached to a `prompt_budget_exceeded` failure. */
export interface FusionBudgetErrorDetail {
  budget_stage: FusionBudgetStage;
  slot?: 1 | 2 | 3;
  measurement_kind: 'stage_forecast' | 'rendered_prompt';
  measured_utf8_bytes: number;
  measured_input_tokens_upper_bound: number;
  allowed_input_tokens: number;
  limiting_model: {
    provider: string;
    model: string;
    qualified_id: string;
    context_window_tokens: number;
  };
  context_policy_id: string;
  remediation: readonly string[];
  blockers: readonly FusionBudgetBlocker[];
  artifact_dir: string;
}

export interface FusionErrorDetails {
  code: FusionErrorCode;
  stage?: FusionStage;
  slot?: 1 | 2 | 3;
  attempt?: number;
  artifactDir?: string;
  transient?: boolean;
  childCreated?: boolean;
  budget?: FusionBudgetErrorDetail;
}

export class FusionError extends Error {
  readonly code: FusionErrorCode;
  readonly stage: FusionStage | undefined;
  readonly slot: 1 | 2 | 3 | undefined;
  readonly attempt: number | undefined;
  readonly artifactDir: string | undefined;
  readonly transient: boolean;
  readonly childCreated: boolean;
  readonly budget: FusionBudgetErrorDetail | undefined;

  constructor(message: string, details: FusionErrorDetails) {
    super(message);
    this.name = 'FusionError';
    this.code = details.code;
    this.stage = details.stage;
    this.slot = details.slot;
    this.attempt = details.attempt;
    this.artifactDir = details.artifactDir;
    this.transient = details.transient ?? false;
    this.childCreated = details.childCreated ?? true;
    this.budget = details.budget;
  }
}

export interface FusionChildUsage extends FusionUsage {
  provider: string;
  model: string;
  qualifiedId: string;
}

export interface FusionChildRunResult {
  stage: FusionStage;
  slot?: 1 | 2 | 3;
  attempt: number;
  provider: string;
  model: string;
  qualifiedId: string;
  text: string;
  usage: FusionUsage;
  events: Buffer;
  stderr: Buffer;
  exitCode: number;
  signal: NodeJS.Signals | null;
}

export interface FusionAttemptArtifactRecord {
  stage: FusionStage;
  slot?: 1 | 2 | 3;
  attempt: number;
  status: 'completed' | 'failed' | 'cancelled';
  prompt_path: string;
  events_path?: string;
  stderr_path?: string;
  response_path?: string;
  partial_response_path?: string;
  provider?: string;
  model?: string;
  qualifiedId?: string;
  usage?: FusionUsage;
  error?: string;
}

export interface FusionArtifactRef {
  path: string;
  byte_length: number;
  sha256: string;
}

export interface FusionArtifactManifest {
  schema_version: typeof FUSION_MANIFEST_SCHEMA_VERSION;
  run_id: string;
  source: FusionSource;
  state: FusionState;
  created_at: string;
  updated_at: string;
  cwd: string;
  config: FusionModelConfigV1;
  models: {
    candidates: readonly [string, string, string];
    evaluator: string;
    merger: string;
    thinking_level: string;
  };
  usage: FusionUsage;
  attempts: readonly FusionAttemptArtifactRecord[];
  artifacts: Readonly<Record<string, FusionArtifactRef>>;
  anonymous_map?: Readonly<Record<FusionCandidateId, 1 | 2 | 3>>;
  error?: string;
}

export interface FusionRunResult {
  mergedText: string;
  details: FusionResultDetails;
}

/** Snapshot of one configured route's verified input capacity for one stage. */
export interface FusionRouteCapacity {
  role: 'candidate-1' | 'candidate-2' | 'candidate-3' | 'evaluator' | 'merger';
  provider: string;
  model: string;
  qualified_id: string;
  context_window_tokens: number;
  reserved_output_tokens: number;
  framing_reserve_tokens: number;
  safety_reserve_tokens: number;
  allowed_input_tokens: number;
}

export interface FusionBudgetStageComposition {
  visible_text_bytes: number;
  omission_receipt_bytes: number;
  projection_metadata_bytes: number;
  request_bytes: number;
  static_stage_framing_bytes: number;
  upstream_output_contract_bytes: number;
}

export interface FusionStageBudgetPlanEntry {
  budget_stage: FusionBudgetStage;
  slot?: 1 | 2 | 3;
  route: FusionRouteCapacity;
  conditional: boolean;
  forecast_utf8_bytes: number;
  forecast_input_tokens_upper_bound: number;
  allowed_input_tokens: number;
  signed_headroom_tokens: number;
  utilization: number;
  fits: boolean;
}

export interface FusionBudgetBlocker extends FusionStageBudgetPlanEntry {
  overage_tokens: number;
}

export interface FusionBudgetWarning extends FusionStageBudgetPlanEntry {
  threshold: 0.8;
}

export interface FusionBudgetEmptyRequestVerdict {
  request_utf8_bytes: number;
  still_fails_with_empty_request: boolean;
  shortening_request_can_help: boolean;
  minimum_request_byte_reduction: number;
  maximum_safe_request_utf8_bytes: number;
  blockers_with_empty_request: readonly FusionBudgetBlocker[];
}

export interface FusionBudgetPlanV1 {
  schema_version: typeof FUSION_BUDGET_PLAN_SCHEMA_VERSION;
  policy: FusionBudgetPolicyDescriptor;
  routes: readonly FusionRouteCapacity[];
  stages: readonly FusionStageBudgetPlanEntry[];
  blockers: readonly FusionBudgetBlocker[];
  primary_blocker?: FusionBudgetBlocker;
  primary_blocker_composition?: FusionBudgetStageComposition;
  empty_request: FusionBudgetEmptyRequestVerdict;
  warnings: readonly FusionBudgetWarning[];
}

/** Documented, versioned budget policy. */
export interface FusionBudgetPolicyDescriptor {
  id: 'fusion-budget-policy-v2';
  bytes_per_token_divisor: number;
  reserved_output_tokens: number;
  framing_reserve_tokens: number;
  safety_reserve_tokens: number;
  candidate_output_contract_bytes: number;
  evaluation_output_contract_bytes: number;
  merge_output_contract_bytes: number;
  diagnostics_contract_bytes: number;
  utilization_warning_threshold: 0.8;
}

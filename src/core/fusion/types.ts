import type { ThinkingLevel } from '@earendil-works/pi-ai';

export const FUSION_MODEL_CONFIG_SCHEMA_VERSION = 'pi-background-tasks.fusion-models.v1';
export const FUSION_INPUT_SCHEMA_VERSION = 'pi-background-tasks.fusion-input.v1';
export const FUSION_EVALUATION_SCHEMA_VERSION = 'pi-background-tasks.fusion-evaluation.v1';
export const FUSION_RESULT_SCHEMA_VERSION = 'pi-background-tasks.fusion-result.v1';
export const FUSION_MANIFEST_SCHEMA_VERSION = 'pi-background-tasks.fusion-manifest.v1';

export const FUSION_CANDIDATE_IDS = ['A', 'B', 'C'] as const;
export type FusionCandidateId = (typeof FUSION_CANDIDATE_IDS)[number];

export const FUSION_STAGE_VALUES = ['candidate', 'evaluation', 'merge'] as const;
export type FusionStage = (typeof FUSION_STAGE_VALUES)[number];

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
  thinkingLevel: ThinkingLevel;
  contextWindow: number;
}

export interface ResolvedFusionModels {
  candidates: readonly [ResolvedFusionModel, ResolvedFusionModel, ResolvedFusionModel];
  evaluator: ResolvedFusionModel;
  merger: ResolvedFusionModel;
}

export interface FusionCanonicalInputV1 {
  schema_version: typeof FUSION_INPUT_SCHEMA_VERSION;
  cwd: string;
  system_prompt: string;
  conversation_transcript: string;
  request: string;
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

export interface FusionUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costTotal?: number;
}

export const EMPTY_FUSION_USAGE: FusionUsage = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
});

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
  | { type: 'merge_started' }
  | { type: 'completed'; runId: string; artifactDir: string }
  | { type: 'failed'; runId: string; artifactDir: string; error: string }
  | { type: 'cancelled'; runId: string; artifactDir: string; reason: string };

export type FusionErrorCode =
  | 'config_invalid'
  | 'config_conflict'
  | 'model_unavailable'
  | 'context_capture_failed'
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

export interface FusionErrorDetails {
  code: FusionErrorCode;
  stage?: FusionStage;
  slot?: 1 | 2 | 3;
  attempt?: number;
  artifactDir?: string;
  transient?: boolean;
  childCreated?: boolean;
}

export class FusionError extends Error {
  readonly code: FusionErrorCode;
  readonly stage: FusionStage | undefined;
  readonly slot: 1 | 2 | 3 | undefined;
  readonly attempt: number | undefined;
  readonly artifactDir: string | undefined;
  readonly transient: boolean;
  readonly childCreated: boolean;

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
  stdout: Buffer;
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

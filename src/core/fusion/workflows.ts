import {
  FUSION_EVALUATION_REPAIR_SYSTEM_PROMPT,
  FUSION_EVALUATOR_SYSTEM_PROMPT,
  FUSION_MERGER_SYSTEM_PROMPT,
  FUSION_VALIDATE_EVALUATION_REPAIR_SYSTEM_PROMPT,
  FUSION_VALIDATE_EVALUATOR_SYSTEM_PROMPT,
  FUSION_VALIDATE_MERGER_SYSTEM_PROMPT,
  fusionCandidateSystemPrompt,
  fusionValidateCandidateSystemPrompt,
} from './prompts.js';
import {
  FUSION_DEFAULT_CAPABILITY,
  FUSION_VALIDATE_CAPABILITY,
  FusionError,
  type FusionCapability,
  type FusionWorkflowId,
} from './types.js';

export const FUSION_BRAINSTORM_TOOL_NAME = 'fusion_brainstorm';
export const FUSION_VALIDATE_TOOL_NAME = 'fusion_validate';

/**
 * How a workflow decides which capability its candidate children run with.
 *
 * `caller_selected` lets the tool schema offer a capability argument and defaults
 * to the least-privileged profile. `fixed` pins one capability for every run and
 * makes each other value a loud orchestration failure rather than a silent
 * downgrade.
 */
export type FusionCapabilityPolicy = 'caller_selected' | 'fixed';

/**
 * Stage framing for one Fusion workflow.
 *
 * Everything a workflow can vary lives here: the four system prompts, the
 * capability policy, and presentation strings. Everything else - the conversation
 * projection, canonical input schema, budget policy, evaluation schema, artifact
 * store, and state machine - is shared and must never be branched per workflow.
 */
export interface FusionWorkflowProfile {
  readonly id: FusionWorkflowId;
  readonly toolName: string;
  /** First character of the run id, so artifact directories are self-describing. */
  readonly runIdPrefix: string;
  readonly capabilityPolicy: FusionCapabilityPolicy;
  /** The only capability permitted when `capabilityPolicy` is `fixed`. */
  readonly fixedCapability: FusionCapability | undefined;
  readonly defaultCapability: FusionCapability;
  readonly candidateSystemPrompt: (capability: FusionCapability) => string;
  readonly evaluatorSystemPrompt: string;
  readonly evaluationRepairSystemPrompt: string;
  readonly mergerSystemPrompt: string;
  /** Human-readable noun used in progress lines and rendered results. */
  readonly label: string;
}

export const FUSION_BRAINSTORM_WORKFLOW: FusionWorkflowProfile = Object.freeze({
  id: 'brainstorm',
  toolName: FUSION_BRAINSTORM_TOOL_NAME,
  runIdPrefix: 'f',
  capabilityPolicy: 'caller_selected',
  fixedCapability: undefined,
  defaultCapability: FUSION_DEFAULT_CAPABILITY,
  candidateSystemPrompt: fusionCandidateSystemPrompt,
  evaluatorSystemPrompt: FUSION_EVALUATOR_SYSTEM_PROMPT,
  evaluationRepairSystemPrompt: FUSION_EVALUATION_REPAIR_SYSTEM_PROMPT,
  mergerSystemPrompt: FUSION_MERGER_SYSTEM_PROMPT,
  label: 'fusion',
});

export const FUSION_VALIDATE_WORKFLOW: FusionWorkflowProfile = Object.freeze({
  id: 'validate',
  toolName: FUSION_VALIDATE_TOOL_NAME,
  runIdPrefix: 'v',
  capabilityPolicy: 'fixed',
  fixedCapability: FUSION_VALIDATE_CAPABILITY,
  defaultCapability: FUSION_VALIDATE_CAPABILITY,
  candidateSystemPrompt: fusionValidateCandidateSystemPrompt,
  evaluatorSystemPrompt: FUSION_VALIDATE_EVALUATOR_SYSTEM_PROMPT,
  evaluationRepairSystemPrompt: FUSION_VALIDATE_EVALUATION_REPAIR_SYSTEM_PROMPT,
  mergerSystemPrompt: FUSION_VALIDATE_MERGER_SYSTEM_PROMPT,
  label: 'validate',
});

const PROFILES_BY_ID: Readonly<Record<FusionWorkflowId, FusionWorkflowProfile>> = Object.freeze({
  brainstorm: FUSION_BRAINSTORM_WORKFLOW,
  validate: FUSION_VALIDATE_WORKFLOW,
});

export function fusionWorkflowProfile(id: FusionWorkflowId): FusionWorkflowProfile {
  const profile = PROFILES_BY_ID[id];
  if (profile === undefined) {
    throw new FusionError(`unknown fusion workflow ${String(id)}`, {
      code: 'orchestration_failed',
      childCreated: false,
    });
  }
  return profile;
}

/**
 * Resolve the candidate capability for one run under its workflow's policy.
 *
 * A `fixed` workflow rejects each other capability instead of quietly substituting
 * its own: silently accepting `reason` for a validation run would produce a review
 * that never read the code, which is exactly the failure this workflow exists to
 * prevent.
 */
export function resolveWorkflowCapability(
  profile: FusionWorkflowProfile,
  requested: FusionCapability | undefined,
): FusionCapability {
  if (profile.capabilityPolicy === 'caller_selected') {
    return requested ?? profile.defaultCapability;
  }
  const fixed = profile.fixedCapability;
  if (fixed === undefined) {
    throw new FusionError(
      `fusion workflow ${profile.id} declares a fixed capability policy without a capability`,
      { code: 'orchestration_failed', childCreated: false },
    );
  }
  if (requested !== undefined && requested !== fixed) {
    throw new FusionError(
      `fusion workflow ${profile.id} always runs candidates with the ${fixed} capability; received ${String(requested)}`,
      { code: 'orchestration_failed', childCreated: false },
    );
  }
  return fixed;
}

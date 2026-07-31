import { createHash } from 'node:crypto';
import {
  FUSION_CANDIDATE_SYSTEM_PROMPT,
  FUSION_EVALUATION_REPAIR_SYSTEM_PROMPT,
  FUSION_EVALUATOR_SYSTEM_PROMPT,
  FUSION_MERGER_SYSTEM_PROMPT,
  buildBlindEvaluationInput,
  buildCandidatePrompt,
  buildEvaluationPrompt,
  buildEvaluationRepairPrompt,
  buildMergeInput,
  buildMergePrompt,
  type AnonymousFusionCandidate,
} from './prompts.js';
import {
  FUSION_BUDGET_PLAN_SCHEMA_VERSION,
  FUSION_EVALUATION_SCHEMA_VERSION,
  FusionError,
  type FusionBudgetBlocker,
  type FusionBudgetEmptyRequestVerdict,
  type FusionBudgetErrorDetail,
  type FusionBudgetPlanV1,
  type FusionBudgetPolicyDescriptor,
  type FusionBudgetStage,
  type FusionBudgetStageComposition,
  type FusionBudgetWarning,
  type FusionCanonicalInputV3,
  type FusionEvaluationV1,
  type FusionRouteCapacity,
  type FusionStage,
  type FusionStageBudgetPlanEntry,
  type ResolvedFusionModel,
  type ResolvedFusionModels,
} from './types.js';

export const FUSION_BYTES_PER_TOKEN_DIVISOR = 2;

export const FUSION_CANDIDATE_MAX_OUTPUT_BYTES = 48 * 1024;
export const FUSION_EVALUATION_MAX_OUTPUT_BYTES = 64 * 1024;
export const FUSION_MERGE_MAX_OUTPUT_BYTES = 64 * 1024;
export const FUSION_DIAGNOSTICS_MAX_BYTES = 8 * 1024;

export const FUSION_RESERVED_OUTPUT_TOKENS = Math.ceil(
  FUSION_MERGE_MAX_OUTPUT_BYTES / FUSION_BYTES_PER_TOKEN_DIVISOR,
);
export const FUSION_FRAMING_RESERVE_TOKENS = 4_096;
export const FUSION_SAFETY_RESERVE_TOKENS = 4_096;
export const FUSION_MIN_CANONICAL_INPUT_TOKENS = 8_192;
export const FUSION_MIN_CONTEXT_WINDOW_TOKENS =
  FUSION_MIN_CANONICAL_INPUT_TOKENS +
  FUSION_RESERVED_OUTPUT_TOKENS +
  FUSION_FRAMING_RESERVE_TOKENS +
  FUSION_SAFETY_RESERVE_TOKENS;
export const FUSION_UTILIZATION_WARNING_THRESHOLD = 0.8;

export const FUSION_BUDGET_POLICY: FusionBudgetPolicyDescriptor = {
  id: 'fusion-budget-policy-v2',
  bytes_per_token_divisor: FUSION_BYTES_PER_TOKEN_DIVISOR,
  reserved_output_tokens: FUSION_RESERVED_OUTPUT_TOKENS,
  framing_reserve_tokens: FUSION_FRAMING_RESERVE_TOKENS,
  safety_reserve_tokens: FUSION_SAFETY_RESERVE_TOKENS,
  candidate_output_contract_bytes: FUSION_CANDIDATE_MAX_OUTPUT_BYTES,
  evaluation_output_contract_bytes: FUSION_EVALUATION_MAX_OUTPUT_BYTES,
  merge_output_contract_bytes: FUSION_MERGE_MAX_OUTPUT_BYTES,
  diagnostics_contract_bytes: FUSION_DIAGNOSTICS_MAX_BYTES,
  utilization_warning_threshold: FUSION_UTILIZATION_WARNING_THRESHOLD,
};

const EMPTY_REMEDIATION: readonly string[] = Object.freeze([
  'Start a fresh Pi conversation, or run Fusion earlier in the session.',
  "Raise the route's context window with a larger-context model via /fusion-models.",
  'Restate only the required prior findings as visible conversation text.',
]);

const REQUEST_REMEDIATION: readonly string[] = Object.freeze([
  'Provide a shorter, self-contained fusion_brainstorm prompt.',
  'Start a fresh Pi conversation, or run Fusion earlier in the session.',
  "Raise the route's context window with a larger-context model via /fusion-models.",
]);

const EMPTY_CANDIDATES: readonly [
  AnonymousFusionCandidate,
  AnonymousFusionCandidate,
  AnonymousFusionCandidate,
] = Object.freeze([
  Object.freeze({ candidate_id: 'A', response: '' }),
  Object.freeze({ candidate_id: 'B', response: '' }),
  Object.freeze({ candidate_id: 'C', response: '' }),
]);

const EMPTY_EVALUATION: FusionEvaluationV1 = Object.freeze({
  schema_version: FUSION_EVALUATION_SCHEMA_VERSION,
  candidate_assessments: Object.freeze([
    Object.freeze({
      candidate_id: 'A',
      summary: '',
      strengths: Object.freeze([]),
      limitations: Object.freeze([]),
      useful_contributions: Object.freeze([]),
      risks: Object.freeze([]),
    }),
    Object.freeze({
      candidate_id: 'B',
      summary: '',
      strengths: Object.freeze([]),
      limitations: Object.freeze([]),
      useful_contributions: Object.freeze([]),
      risks: Object.freeze([]),
    }),
    Object.freeze({
      candidate_id: 'C',
      summary: '',
      strengths: Object.freeze([]),
      limitations: Object.freeze([]),
      useful_contributions: Object.freeze([]),
      risks: Object.freeze([]),
    }),
  ]) as readonly [
    FusionEvaluationV1['candidate_assessments'][0],
    FusionEvaluationV1['candidate_assessments'][1],
    FusionEvaluationV1['candidate_assessments'][2],
  ],
  agreements: Object.freeze([]),
  conflicts: Object.freeze([]),
  synthesis_plan: Object.freeze({
    must_include: Object.freeze([]),
    must_resolve: Object.freeze([]),
    must_avoid: Object.freeze([]),
  }),
});

interface StageForecastDraft {
  budget_stage: FusionBudgetStage;
  slot?: 1 | 2 | 3;
  route: FusionRouteCapacity;
  conditional: boolean;
  system_prompt: string;
  empty_user_prompt: string;
  upstream_output_contract_bytes: number;
}

export function fusionTokenUpperBound(utf8Bytes: number): number {
  return Math.ceil(utf8Bytes / FUSION_BYTES_PER_TOKEN_DIVISOR);
}

export function fusionOutputContractBytes(stage: FusionStage): number {
  if (stage === 'candidate') return FUSION_CANDIDATE_MAX_OUTPUT_BYTES;
  if (stage === 'evaluation') return FUSION_EVALUATION_MAX_OUTPUT_BYTES;
  return FUSION_MERGE_MAX_OUTPUT_BYTES;
}

export function assertChildOutputWithinContract(stage: FusionStage, text: string): void {
  const bytes = Buffer.byteLength(JSON.stringify(text), 'utf8');
  const allowed = fusionOutputContractBytes(stage);
  if (bytes <= allowed) return;
  throw new FusionError(
    `fusion ${stage} response is ${String(bytes)} JSON-rendered bytes, exceeding the ${String(allowed)}-byte output contract for that stage; the response is preserved in the run artifacts and is not forwarded or truncated`,
    { code: 'child_output_cap', stage, childCreated: true },
  );
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function requirePositiveContextWindow(model: ResolvedFusionModel, role: string): number {
  const value = model.contextWindow;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new FusionError(
      `fusion ${role} route ${model.qualifiedId} has no usable context window capacity`,
      { code: 'model_capacity_unknown', childCreated: false },
    );
  }
  return value;
}

function routeCapacity(
  model: ResolvedFusionModel,
  role: FusionRouteCapacity['role'],
): FusionRouteCapacity {
  const contextWindow = requirePositiveContextWindow(model, role);
  const allowed =
    contextWindow -
    FUSION_RESERVED_OUTPUT_TOKENS -
    FUSION_FRAMING_RESERVE_TOKENS -
    FUSION_SAFETY_RESERVE_TOKENS;
  if (allowed < FUSION_MIN_CANONICAL_INPUT_TOKENS) {
    throw new FusionError(
      `fusion ${role} route ${model.qualifiedId} has a ${String(contextWindow)}-token context window, but Fusion requires at least ${String(FUSION_MIN_CONTEXT_WINDOW_TOKENS)} tokens per configured route: ${String(FUSION_RESERVED_OUTPUT_TOKENS)} output + ${String(FUSION_FRAMING_RESERVE_TOKENS)} framing + ${String(FUSION_SAFETY_RESERVE_TOKENS)} safety + ${String(FUSION_MIN_CANONICAL_INPUT_TOKENS)} usable input. Choose a larger-context model for this slot with /fusion-models.`,
      { code: 'model_capacity_unknown', childCreated: false },
    );
  }
  return {
    role,
    provider: model.provider,
    model: model.model,
    qualified_id: model.qualifiedId,
    context_window_tokens: contextWindow,
    reserved_output_tokens: FUSION_RESERVED_OUTPUT_TOKENS,
    framing_reserve_tokens: FUSION_FRAMING_RESERVE_TOKENS,
    safety_reserve_tokens: FUSION_SAFETY_RESERVE_TOKENS,
    allowed_input_tokens: allowed,
  };
}

export function fusionRouteCapacities(models: ResolvedFusionModels): readonly FusionRouteCapacity[] {
  return [
    routeCapacity(models.candidates[0], 'candidate-1'),
    routeCapacity(models.candidates[1], 'candidate-2'),
    routeCapacity(models.candidates[2], 'candidate-3'),
    routeCapacity(models.evaluator, 'evaluator'),
    routeCapacity(models.merger, 'merger'),
  ];
}

export function fusionLimitingRoute(
  routes: readonly FusionRouteCapacity[],
): FusionRouteCapacity {
  let limiting: FusionRouteCapacity | undefined;
  for (const route of routes) {
    if (limiting === undefined || route.allowed_input_tokens < limiting.allowed_input_tokens) {
      limiting = route;
    }
  }
  if (limiting === undefined) {
    throw new FusionError('fusion budget planning received no configured routes', {
      code: 'model_capacity_unknown',
      childCreated: false,
    });
  }
  return limiting;
}

function routeByRole(
  routes: readonly FusionRouteCapacity[],
  role: FusionRouteCapacity['role'],
): FusionRouteCapacity {
  const route = routes.find((item) => item.role === role);
  if (route === undefined) {
    throw new FusionError(`fusion budget route ${role} is missing`, {
      code: 'model_capacity_unknown',
      childCreated: false,
    });
  }
  return route;
}

function candidateRole(slot: 1 | 2 | 3): FusionRouteCapacity['role'] {
  if (slot === 1) return 'candidate-1';
  if (slot === 2) return 'candidate-2';
  return 'candidate-3';
}

function forecastEntry(draft: StageForecastDraft): FusionStageBudgetPlanEntry {
  const forecastUtf8Bytes =
    utf8Bytes(draft.system_prompt) +
    utf8Bytes(draft.empty_user_prompt) +
    draft.upstream_output_contract_bytes;
  const tokens = fusionTokenUpperBound(forecastUtf8Bytes);
  const entry: FusionStageBudgetPlanEntry = {
    budget_stage: draft.budget_stage,
    route: draft.route,
    conditional: draft.conditional,
    forecast_utf8_bytes: forecastUtf8Bytes,
    forecast_input_tokens_upper_bound: tokens,
    allowed_input_tokens: draft.route.allowed_input_tokens,
    signed_headroom_tokens: draft.route.allowed_input_tokens - tokens,
    utilization: tokens / draft.route.allowed_input_tokens,
    fits: tokens <= draft.route.allowed_input_tokens,
  };
  if (draft.slot !== undefined) entry.slot = draft.slot;
  return entry;
}

function blockerFromEntry(entry: FusionStageBudgetPlanEntry): FusionBudgetBlocker {
  return { ...entry, overage_tokens: Math.max(0, -entry.signed_headroom_tokens) };
}

function blockerOrder(blocker: FusionBudgetBlocker): number {
  if (blocker.budget_stage === 'candidate') return blocker.slot ?? 1;
  if (blocker.budget_stage === 'evaluation') return 4;
  if (blocker.budget_stage === 'merge') return 5;
  return 6;
}

function selectBlockers(entries: readonly FusionStageBudgetPlanEntry[]): readonly FusionBudgetBlocker[] {
  return entries.filter((entry) => !entry.fits).map(blockerFromEntry).sort((left, right) => {
    const byOrder = blockerOrder(left) - blockerOrder(right);
    if (byOrder !== 0) return byOrder;
    return left.route.role.localeCompare(right.route.role);
  });
}

function selectPrimaryBlocker(
  blockers: readonly FusionBudgetBlocker[],
): FusionBudgetBlocker | undefined {
  const mandatory = blockers.find((blocker) => !blocker.conditional);
  return mandatory ?? blockers[0];
}

function replaceRequestText(input: FusionCanonicalInputV3, text: string): FusionCanonicalInputV3 {
  return {
    ...input,
    request: {
      ...input.request,
      text,
      sha256: sha256Hex(text),
    },
  };
}

function visibleTextBytes(input: FusionCanonicalInputV3): number {
  let total = 0;
  for (const entry of input.conversation_projection.entries) {
    if (entry.kind === 'text') total += utf8Bytes(JSON.stringify(entry.text));
  }
  return total;
}

function omissionReceiptBytes(input: FusionCanonicalInputV3): number {
  let total = 0;
  for (const entry of input.conversation_projection.entries) {
    if (entry.kind === 'omitted_activity') total += utf8Bytes(JSON.stringify(entry));
  }
  return total;
}

function warningFromEntry(entry: FusionStageBudgetPlanEntry): FusionBudgetWarning {
  return { ...entry, threshold: FUSION_UTILIZATION_WARNING_THRESHOLD };
}

function warningsFor(entries: readonly FusionStageBudgetPlanEntry[]): readonly FusionBudgetWarning[] {
  return entries
    .filter((entry) => entry.fits && entry.utilization >= FUSION_UTILIZATION_WARNING_THRESHOLD)
    .map(warningFromEntry);
}

function entryLabel(entry: FusionStageBudgetPlanEntry): string {
  const slot = entry.slot === undefined ? '' : `-${String(entry.slot)}`;
  const conditional = entry.conditional ? ' (conditional)' : '';
  return `${entry.budget_stage}${slot}${conditional}`;
}

function formatTable(entries: readonly FusionStageBudgetPlanEntry[]): string {
  const lines = entries.map(
    (entry) =>
      `${entryLabel(entry)} | route=${entry.route.qualified_id} | forecast=${String(entry.forecast_input_tokens_upper_bound)} | allowed=${String(entry.allowed_input_tokens)} | headroom=${String(entry.signed_headroom_tokens)} | ${entry.fits ? 'fits' : 'over'}`,
  );
  return lines.join('\n');
}

function formatComposition(composition: FusionBudgetStageComposition): string {
  return [
    `visible text ${String(composition.visible_text_bytes)} B`,
    `omission receipts ${String(composition.omission_receipt_bytes)} B`,
    `projection metadata ${String(composition.projection_metadata_bytes)} B`,
    `request ${String(composition.request_bytes)} B`,
    `static stage framing ${String(composition.static_stage_framing_bytes)} B`,
    `upstream output contracts ${String(composition.upstream_output_contract_bytes)} B`,
  ].join('; ');
}

function remediationFor(verdict: FusionBudgetEmptyRequestVerdict): readonly string[] {
  return verdict.still_fails_with_empty_request ? EMPTY_REMEDIATION : REQUEST_REMEDIATION;
}

function formatEmptyRequestVerdict(verdict: FusionBudgetEmptyRequestVerdict): string {
  if (verdict.still_fails_with_empty_request) {
    return `Empty-request counterfactual: still fails with ${String(verdict.blockers_with_empty_request.length)} blocking stage(s), so shortening the request cannot make this workflow fit.`;
  }
  if (verdict.minimum_request_byte_reduction === 0) {
    return 'Empty-request counterfactual: fits; no request reduction is required by the current plan.';
  }
  return `Empty-request counterfactual: fits, so request size determines feasibility; reduce the request by at least ${String(verdict.minimum_request_byte_reduction)} UTF-8 bytes, leaving at most ${String(verdict.maximum_safe_request_utf8_bytes)} UTF-8 bytes.`;
}

function stageFromBudgetStage(stage: FusionBudgetStage): FusionStage {
  if (stage === 'merge') return 'merge';
  if (stage === 'candidate') return 'candidate';
  return 'evaluation';
}

export class FusionBudget {
  readonly routes: readonly FusionRouteCapacity[];
  readonly limiting: FusionRouteCapacity;
  private readonly contextPolicyId: string;

  constructor(models: ResolvedFusionModels, contextPolicyId: string) {
    this.routes = fusionRouteCapacities(models);
    this.limiting = fusionLimitingRoute(this.routes);
    this.contextPolicyId = contextPolicyId;
  }

  get allowedInputTokens(): number {
    return this.limiting.allowed_input_tokens;
  }

  private routeForStage(stage: FusionBudgetStage, slot?: 1 | 2 | 3): FusionRouteCapacity {
    if (stage === 'candidate') return routeByRole(this.routes, candidateRole(slot ?? 1));
    if (stage === 'merge') return routeByRole(this.routes, 'merger');
    return routeByRole(this.routes, 'evaluator');
  }

  private drafts(input: FusionCanonicalInputV3): readonly StageForecastDraft[] {
    const candidatePrompt = buildCandidatePrompt(input);
    const blindInput = buildBlindEvaluationInput(input, EMPTY_CANDIDATES);
    const evaluationPrompt = buildEvaluationPrompt(blindInput);
    const repairPrompt = buildEvaluationRepairPrompt({
      schema_version: 'pi-background-tasks.fusion-evaluation-repair-input.v1',
      original_blind_input: blindInput,
      invalid_output: '',
      validation_errors: [],
    });
    const mergePrompt = buildMergePrompt(buildMergeInput(input, EMPTY_CANDIDATES, EMPTY_EVALUATION));
    return [
      {
        budget_stage: 'candidate',
        slot: 1,
        route: this.routeForStage('candidate', 1),
        conditional: false,
        system_prompt: FUSION_CANDIDATE_SYSTEM_PROMPT,
        empty_user_prompt: candidatePrompt,
        upstream_output_contract_bytes: 0,
      },
      {
        budget_stage: 'candidate',
        slot: 2,
        route: this.routeForStage('candidate', 2),
        conditional: false,
        system_prompt: FUSION_CANDIDATE_SYSTEM_PROMPT,
        empty_user_prompt: candidatePrompt,
        upstream_output_contract_bytes: 0,
      },
      {
        budget_stage: 'candidate',
        slot: 3,
        route: this.routeForStage('candidate', 3),
        conditional: false,
        system_prompt: FUSION_CANDIDATE_SYSTEM_PROMPT,
        empty_user_prompt: candidatePrompt,
        upstream_output_contract_bytes: 0,
      },
      {
        budget_stage: 'evaluation',
        route: this.routeForStage('evaluation'),
        conditional: false,
        system_prompt: FUSION_EVALUATOR_SYSTEM_PROMPT,
        empty_user_prompt: evaluationPrompt,
        upstream_output_contract_bytes: 3 * FUSION_CANDIDATE_MAX_OUTPUT_BYTES,
      },
      {
        budget_stage: 'merge',
        route: this.routeForStage('merge'),
        conditional: false,
        system_prompt: FUSION_MERGER_SYSTEM_PROMPT,
        empty_user_prompt: mergePrompt,
        upstream_output_contract_bytes:
          3 * FUSION_CANDIDATE_MAX_OUTPUT_BYTES + FUSION_EVALUATION_MAX_OUTPUT_BYTES,
      },
      {
        budget_stage: 'evaluation_repair',
        route: this.routeForStage('evaluation_repair'),
        conditional: true,
        system_prompt: FUSION_EVALUATION_REPAIR_SYSTEM_PROMPT,
        empty_user_prompt: repairPrompt,
        upstream_output_contract_bytes:
          3 * FUSION_CANDIDATE_MAX_OUTPUT_BYTES +
          FUSION_EVALUATION_MAX_OUTPUT_BYTES +
          FUSION_DIAGNOSTICS_MAX_BYTES,
      },
    ];
  }

  private entries(input: FusionCanonicalInputV3): readonly FusionStageBudgetPlanEntry[] {
    return this.drafts(input).map(forecastEntry);
  }

  private composition(
    input: FusionCanonicalInputV3,
    blocker: FusionBudgetBlocker,
  ): FusionBudgetStageComposition {
    const canonicalBytes = utf8Bytes(buildCandidatePrompt(input));
    const emptyRequestCanonicalBytes = utf8Bytes(buildCandidatePrompt(replaceRequestText(input, '')));
    const requestBytes = canonicalBytes - emptyRequestCanonicalBytes;
    const visible = visibleTextBytes(input);
    const omissions = omissionReceiptBytes(input);
    const projectionMetadata = canonicalBytes - requestBytes - visible - omissions;
    const draft = this.drafts(input).find(
      (item) => item.budget_stage === blocker.budget_stage && item.slot === blocker.slot,
    );
    if (draft === undefined) {
      throw new FusionError('primary budget blocker disappeared during composition', {
        code: 'orchestration_failed',
        childCreated: false,
      });
    }
    return {
      visible_text_bytes: visible,
      omission_receipt_bytes: omissions,
      projection_metadata_bytes: projectionMetadata,
      request_bytes: requestBytes,
      static_stage_framing_bytes:
        utf8Bytes(draft.system_prompt) + utf8Bytes(draft.empty_user_prompt) - canonicalBytes,
      upstream_output_contract_bytes: draft.upstream_output_contract_bytes,
    };
  }

  private emptyRequestVerdict(
    input: FusionCanonicalInputV3,
    entries: readonly FusionStageBudgetPlanEntry[],
  ): FusionBudgetEmptyRequestVerdict {
    const emptyEntries = this.entries(replaceRequestText(input, ''));
    const emptyBlockers = selectBlockers(emptyEntries);
    let reduction = 0;
    for (const entry of entries) {
      const byteLimit = entry.allowed_input_tokens * FUSION_BYTES_PER_TOKEN_DIVISOR;
      reduction = Math.max(reduction, entry.forecast_utf8_bytes - byteLimit);
    }
    reduction = Math.max(0, reduction);
    const requestBytes = utf8Bytes(input.request.text);
    return {
      request_utf8_bytes: requestBytes,
      still_fails_with_empty_request: emptyBlockers.length > 0,
      shortening_request_can_help: emptyBlockers.length === 0,
      minimum_request_byte_reduction: reduction,
      maximum_safe_request_utf8_bytes: Math.max(0, requestBytes - reduction),
      blockers_with_empty_request: emptyBlockers,
    };
  }

  private failure(
    primary: FusionBudgetBlocker,
    plan: FusionBudgetPlanV1,
    artifactDir: string,
    measurementKind: FusionBudgetErrorDetail['measurement_kind'],
  ): FusionError {
    const remediation = remediationFor(plan.empty_request);
    const budget: FusionBudgetErrorDetail = {
      budget_stage: primary.budget_stage,
      measurement_kind: measurementKind,
      measured_utf8_bytes: primary.forecast_utf8_bytes,
      measured_input_tokens_upper_bound: primary.forecast_input_tokens_upper_bound,
      allowed_input_tokens: primary.allowed_input_tokens,
      limiting_model: {
        provider: primary.route.provider,
        model: primary.route.model,
        qualified_id: primary.route.qualified_id,
        context_window_tokens: primary.route.context_window_tokens,
      },
      context_policy_id: this.contextPolicyId,
      remediation,
      blockers: plan.blockers,
      artifact_dir: artifactDir,
    };
    if (primary.slot !== undefined) budget.slot = primary.slot;
    const composition = plan.primary_blocker_composition;
    const compositionText = composition === undefined ? 'unavailable' : formatComposition(composition);
    const additional = plan.blockers
      .filter((blocker) => blocker !== primary)
      .map((blocker) => `${entryLabel(blocker)} route=${blocker.route.qualified_id}`)
      .join('; ');
    const overage = primary.forecast_input_tokens_upper_bound - primary.allowed_input_tokens;
    const message =
      `Fusion prompt budget exceeded before child creation. Primary blocking stage: ${entryLabel(primary)} on route ${primary.route.qualified_id}. ` +
      `Forecast ${String(primary.forecast_utf8_bytes)} UTF-8 bytes (<= ${String(primary.forecast_input_tokens_upper_bound)} input tokens) against ${String(primary.allowed_input_tokens)} allowed input tokens, over by ${String(overage)} tokens. ` +
      `No child was created. Nothing was clipped, dropped, or substituted. Artifact directory: ${artifactDir}.\n` +
      `Per-stage forecast table:\n${formatTable(plan.stages)}\n` +
      `Primary blocker byte composition: ${compositionText}.\n` +
      `Additional blockers: ${additional.length === 0 ? 'none' : additional}.\n` +
      `${formatEmptyRequestVerdict(plan.empty_request)}\n` +
      `Remediation: ${remediation.join(' ')}`;
    const details = {
      code: 'prompt_budget_exceeded' as const,
      childCreated: false,
      budget,
      stage: stageFromBudgetStage(primary.budget_stage),
    };
    if (primary.slot !== undefined) return new FusionError(message, { ...details, slot: primary.slot });
    return new FusionError(message, details);
  }

  plan(input: FusionCanonicalInputV3): FusionBudgetPlanV1 {
    const stages = this.entries(input);
    const blockers = selectBlockers(stages);
    const primary = selectPrimaryBlocker(blockers);
    const emptyRequest = this.emptyRequestVerdict(input, stages);
    const base: FusionBudgetPlanV1 = {
      schema_version: FUSION_BUDGET_PLAN_SCHEMA_VERSION,
      policy: FUSION_BUDGET_POLICY,
      routes: this.routes,
      stages,
      blockers,
      empty_request: emptyRequest,
      warnings: warningsFor(stages),
    };
    if (primary === undefined) return base;
    return {
      ...base,
      primary_blocker: primary,
      primary_blocker_composition: this.composition(input, primary),
    };
  }

  assertPlanFits(plan: FusionBudgetPlanV1, artifactDir: string): void {
    if (plan.primary_blocker !== undefined) {
      throw this.failure(plan.primary_blocker, plan, artifactDir, 'stage_forecast');
    }
  }

  assertStagePrompt(
    stage: FusionBudgetStage,
    systemPrompt: string,
    userPrompt: string,
    slot?: 1 | 2 | 3,
  ): void {
    const route = this.routeForStage(stage, slot);
    const forecastUtf8Bytes = utf8Bytes(systemPrompt) + utf8Bytes(userPrompt);
    const tokens = fusionTokenUpperBound(forecastUtf8Bytes);
    if (tokens <= route.allowed_input_tokens) return;
    const entry: FusionStageBudgetPlanEntry = {
      budget_stage: stage,
      route,
      conditional: stage === 'evaluation_repair',
      forecast_utf8_bytes: forecastUtf8Bytes,
      forecast_input_tokens_upper_bound: tokens,
      allowed_input_tokens: route.allowed_input_tokens,
      signed_headroom_tokens: route.allowed_input_tokens - tokens,
      utilization: tokens / route.allowed_input_tokens,
      fits: false,
    };
    if (slot !== undefined) entry.slot = slot;
    const blocker = blockerFromEntry(entry);
    const plan: FusionBudgetPlanV1 = {
      schema_version: FUSION_BUDGET_PLAN_SCHEMA_VERSION,
      policy: FUSION_BUDGET_POLICY,
      routes: this.routes,
      stages: [entry],
      blockers: [blocker],
      primary_blocker: blocker,
      empty_request: {
        request_utf8_bytes: 0,
        still_fails_with_empty_request: true,
        shortening_request_can_help: false,
        minimum_request_byte_reduction: forecastUtf8Bytes - route.allowed_input_tokens * FUSION_BYTES_PER_TOKEN_DIVISOR,
        maximum_safe_request_utf8_bytes: 0,
        blockers_with_empty_request: [blocker],
      },
      warnings: [],
    };
    throw this.failure(blocker, plan, 'stage prompt re-measurement', 'rendered_prompt');
  }
}

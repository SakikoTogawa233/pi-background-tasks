import {
  FUSION_BUDGET_PLAN_SCHEMA_VERSION,
  FusionError,
  type FusionBudgetErrorDetail,
  type FusionBudgetPlanV1,
  type FusionBudgetPolicyDescriptor,
  type FusionBudgetStage,
  type FusionRouteCapacity,
  type FusionStage,
  type FusionStageBudgetPlanEntry,
  type ResolvedFusionModel,
  type ResolvedFusionModels,
} from './types.js';

/**
 * Conservative lower bound on UTF-8 bytes per input token.
 *
 * Token upper bound = ceil(utf8Bytes / FUSION_BYTES_PER_TOKEN_DIVISOR).
 *
 * Across 159 real large Fusion prompts (50 KB–1.4 MB) recorded in
 * `.pi/fusion/**\/manifest.json`, the smallest observed ratio was 3.552 bytes
 * per reported input token. A divisor of 2 therefore leaves roughly a 1.7x
 * margin against the densest real prompt and still bounds pathological input
 * such as dense CJK (3 UTF-8 bytes producing at most ~1.5 tokens) or long runs
 * of punctuation. It is not an estimate of typical usage; it is a ceiling.
 */
export const FUSION_BYTES_PER_TOKEN_DIVISOR = 2;

/**
 * Enforced maximum size of one child's response, measured in **JSON-rendered
 * transfer bytes** — the bytes the response actually contributes when a later
 * stage embeds it, escaping included.
 *
 * Measuring the rendered form rather than the raw form removes the need to
 * guess an escaping factor: quotes, backslashes, and newlines expand 2x and
 * control characters up to 6x, so a raw-byte contract would not bound the
 * embedded size. `assertChildOutputWithinContract` rejects a response that
 * exceeds its stage bound, so a later stage can never be handed more embedded
 * text than is budgeted here. Nothing is truncated to fit: an oversized
 * response is a loud failure.
 *
 * Sized above the largest real responses recorded across `.pi/fusion`:
 * candidate 45,434 B, evaluator 54,829 B, merged 56,846 B.
 */
export const FUSION_CANDIDATE_MAX_OUTPUT_BYTES = 48 * 1024;
export const FUSION_EVALUATION_MAX_OUTPUT_BYTES = 64 * 1024;
export const FUSION_MERGE_MAX_OUTPUT_BYTES = 64 * 1024;

/** `boundedEvaluationErrors` caps repair diagnostics far below this. */
export const FUSION_DIAGNOSTICS_MAX_BYTES = 8 * 1024;

/**
 * Tokens reserved so a child can emit a response up to its byte contract.
 *
 * Derived from the largest output contract through the same conservative
 * byte-to-token conversion used to measure prompts, so it cannot be understated.
 */
export const FUSION_RESERVED_OUTPUT_TOKENS = Math.ceil(
  FUSION_MERGE_MAX_OUTPUT_BYTES / FUSION_BYTES_PER_TOKEN_DIVISOR,
);

/**
 * Upper bound on Pi/provider framing that is not represented in the prompt
 * bytes Fusion renders: the child system prompt is passed via argv (counted
 * separately below), but chat framing, tool-free scaffolding, and provider
 * envelope overhead are not visible to this package.
 */
export const FUSION_FRAMING_RESERVE_TOKENS = 4_096;

/** Additional margin for provider-side tokenizer differences. */
export const FUSION_SAFETY_RESERVE_TOKENS = 4_096;

/**
 * Fixed structural overhead of the blind-candidate and repair wrappers: schema
 * version strings, candidate_id keys, JSON punctuation, and the evaluation
 * object's own keys. These are constant-size, not content-dependent; 16 KiB is
 * an order of magnitude above the real wrapper size.
 */
export const FUSION_WRAPPER_OVERHEAD_BYTES = 16 * 1024;

/**
 * Bytes of downstream growth the canonical input must leave room for.
 *
 * The widest stage prompt is the evaluation repair, which embeds the canonical
 * input plus three candidate answers, the invalid evaluator output, and bounded
 * validation errors. The merge prompt is strictly smaller.
 *
 * Because the output contracts above are enforced against JSON-rendered bytes,
 * this is an exact sum rather than a raw size inflated by an estimated escaping
 * factor. No content can expand past it, and the exact rendered prompt is still
 * re-measured before every spawn as defence in depth.
 */
export const FUSION_DOWNSTREAM_RESERVE_BYTES =
  3 * FUSION_CANDIDATE_MAX_OUTPUT_BYTES +
  FUSION_EVALUATION_MAX_OUTPUT_BYTES +
  FUSION_DIAGNOSTICS_MAX_BYTES +
  FUSION_WRAPPER_OVERHEAD_BYTES;

/**
 * Tokens withheld from the canonical input for that growth.
 *
 * This converts the reserve through the same byte-to-token function used to
 * measure prompts. Reserving output *tokens* directly would understate the cost
 * of re-embedding those bytes by the ratio between a provider's real
 * tokenization and this conservative ceiling.
 */
export const FUSION_DOWNSTREAM_RESERVE_TOKENS = Math.ceil(
  FUSION_DOWNSTREAM_RESERVE_BYTES / FUSION_BYTES_PER_TOKEN_DIVISOR,
);

/** Minimum usable canonical-input room a configured route must still offer. */
export const FUSION_MIN_CANONICAL_INPUT_TOKENS = 8_192;

/**
 * Smallest context window that can host the complete workflow under this policy.
 *
 * This is a consequence of uniformly conservative accounting, not a preference
 * for large models: the downstream reserve, the output reserve, framing, safety,
 * and a usable amount of canonical input must all fit. Routes below this are
 * rejected at configuration time with an actionable error rather than being
 * silently accepted and failing later at the provider.
 */
export const FUSION_MIN_CONTEXT_WINDOW_TOKENS =
  FUSION_DOWNSTREAM_RESERVE_TOKENS +
  FUSION_MIN_CANONICAL_INPUT_TOKENS +
  FUSION_RESERVED_OUTPUT_TOKENS +
  FUSION_FRAMING_RESERVE_TOKENS +
  FUSION_SAFETY_RESERVE_TOKENS;

export const FUSION_BUDGET_POLICY: FusionBudgetPolicyDescriptor = {
  id: 'fusion-budget-policy-v1',
  bytes_per_token_divisor: FUSION_BYTES_PER_TOKEN_DIVISOR,
  reserved_output_tokens: FUSION_RESERVED_OUTPUT_TOKENS,
  framing_reserve_tokens: FUSION_FRAMING_RESERVE_TOKENS,
  safety_reserve_tokens: FUSION_SAFETY_RESERVE_TOKENS,
  downstream_reserve_bytes: FUSION_DOWNSTREAM_RESERVE_BYTES,
  downstream_reserve_tokens: FUSION_DOWNSTREAM_RESERVE_TOKENS,
};

const REMEDIATION: readonly string[] = Object.freeze([
  'Start a fresh Pi conversation, or run Fusion earlier in the session.',
  'Provide a shorter, self-contained fusion_brainstorm prompt.',
  'Restate only the required prior findings as visible conversation text.',
  'Configure a larger-context model for the limiting Fusion slot via /fusion-models.',
]);

export function fusionTokenUpperBound(utf8Bytes: number): number {
  return Math.ceil(utf8Bytes / FUSION_BYTES_PER_TOKEN_DIVISOR);
}

/** Enforced response-size contract for one stage, in UTF-8 bytes. */
export function fusionOutputContractBytes(stage: FusionStage): number {
  if (stage === 'candidate') return FUSION_CANDIDATE_MAX_OUTPUT_BYTES;
  if (stage === 'evaluation') return FUSION_EVALUATION_MAX_OUTPUT_BYTES;
  return FUSION_MERGE_MAX_OUTPUT_BYTES;
}

/**
 * Reject a child response larger than its stage contract.
 *
 * This is what makes the downstream reserve a guarantee rather than a hope: a
 * later stage can never embed more bytes than were budgeted. The oversized text
 * is never sliced and never forwarded; the run fails loudly instead.
 */
export function assertChildOutputWithinContract(stage: FusionStage, text: string): void {
  // Measure what the response costs once embedded, escaping included, so the
  // downstream reserve is an exact bound rather than an estimate.
  const bytes = Buffer.byteLength(JSON.stringify(text), 'utf8');
  const allowed = fusionOutputContractBytes(stage);
  if (bytes <= allowed) return;
  throw new FusionError(
    `fusion ${stage} response is ${String(bytes)} JSON-rendered bytes, exceeding the ${String(allowed)}-byte output contract for that stage; the response is preserved in the run artifacts and is not forwarded or truncated`,
    { code: 'child_output_cap', stage, childCreated: true },
  );
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
  // The route must hold the downstream reserve plus a usable amount of canonical
  // input, otherwise the configured panel can never complete a workflow.
  if (allowed < FUSION_DOWNSTREAM_RESERVE_TOKENS + FUSION_MIN_CANONICAL_INPUT_TOKENS) {
    throw new FusionError(
      `fusion ${role} route ${model.qualifiedId} has a ${String(contextWindow)}-token context window, but the Fusion workflow requires at least ${String(FUSION_MIN_CONTEXT_WINDOW_TOKENS)} tokens per configured route: ${String(FUSION_RESERVED_OUTPUT_TOKENS)} output + ${String(FUSION_FRAMING_RESERVE_TOKENS)} framing + ${String(FUSION_SAFETY_RESERVE_TOKENS)} safety + ${String(FUSION_DOWNSTREAM_RESERVE_TOKENS)} for evaluator/repair/merger expansion + ${String(FUSION_MIN_CANONICAL_INPUT_TOKENS)} usable canonical input. Choose a larger-context model for this slot with /fusion-models.`,
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

/**
 * The limiting route is the configured participant with the smallest input
 * budget — never the largest-context model. Ties resolve to the first route in
 * declaration order so the plan is deterministic.
 */
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

export class FusionBudget {
  readonly routes: readonly FusionRouteCapacity[];
  readonly limiting: FusionRouteCapacity;
  private readonly contextPolicyId: string;

  constructor(models: ResolvedFusionModels, contextPolicyId: string) {
    this.routes = fusionRouteCapacities(models);
    this.limiting = fusionLimitingRoute(this.routes);
    this.contextPolicyId = contextPolicyId;
  }

  /** Full input budget of the limiting route, in tokens. */
  get allowedInputTokens(): number {
    return this.limiting.allowed_input_tokens;
  }

  /**
   * Budget for the canonical input alone, holding back the derived reserve that
   * downstream evaluator/repair/merger expansion provably needs.
   */
  get allowedCanonicalInputTokens(): number {
    return this.allowedInputTokens - FUSION_DOWNSTREAM_RESERVE_TOKENS;
  }

  private failure(
    stage: FusionBudgetStage,
    measurementKind: FusionBudgetErrorDetail['measurement_kind'],
    utf8Bytes: number,
    allowedTokens: number,
    label: string,
  ): FusionError {
    const tokens = fusionTokenUpperBound(utf8Bytes);
    const budget: FusionBudgetErrorDetail = {
      budget_stage: stage,
      measurement_kind: measurementKind,
      measured_utf8_bytes: utf8Bytes,
      measured_input_tokens_upper_bound: tokens,
      allowed_input_tokens: allowedTokens,
      limiting_model: {
        provider: this.limiting.provider,
        model: this.limiting.model,
        qualified_id: this.limiting.qualified_id,
        context_window_tokens: this.limiting.context_window_tokens,
      },
      context_policy_id: this.contextPolicyId,
      remediation: REMEDIATION,
    };
    const message =
      `fusion ${label} exceeds the safe input budget before child creation: ` +
      `measured ${String(utf8Bytes)} UTF-8 bytes (<= ${String(tokens)} input tokens) ` +
      `against ${String(allowedTokens)} allowed input tokens for the limiting configured model ` +
      `${this.limiting.qualified_id} (context window ${String(this.limiting.context_window_tokens)} tokens, ` +
      `reserving ${String(this.limiting.reserved_output_tokens)} output + ` +
      `${String(this.limiting.framing_reserve_tokens)} framing + ` +
      `${String(this.limiting.safety_reserve_tokens)} safety tokens). ` +
      `Remediation: ${REMEDIATION.join(' ')}`;
    return new FusionError(message, {
      code: 'prompt_budget_exceeded',
      childCreated: false,
      budget,
    });
  }

  /**
   * Whole-DAG feasibility check run before the first candidate spawns. Proving the
   * canonical input fits within its reserved share proves every downstream stage
   * has room for its expansion, because the reserved remainder exceeds the
   * largest possible candidate/evaluation growth by construction.
   */
  assertBaseContext(canonicalInputSerialized: string, systemPromptBytes: number): void {
    const bytes = Buffer.byteLength(canonicalInputSerialized, 'utf8') + systemPromptBytes;
    if (fusionTokenUpperBound(bytes) > this.allowedCanonicalInputTokens) {
      throw this.failure(
        'candidate',
        'worst_case_envelope',
        bytes,
        this.allowedCanonicalInputTokens,
        'conversation projection plus request',
      );
    }
  }

  /**
   * Exact preflight for one rendered stage prompt, measured on the same bytes
   * that will be written to the child's stdin and persisted as the artifact.
   */
  assertStagePrompt(stage: FusionBudgetStage, systemPrompt: string, userPrompt: string): void {
    const bytes =
      Buffer.byteLength(systemPrompt, 'utf8') + Buffer.byteLength(userPrompt, 'utf8');
    if (fusionTokenUpperBound(bytes) > this.allowedInputTokens) {
      throw this.failure(
        stage,
        'rendered_prompt',
        bytes,
        this.allowedInputTokens,
        `${stage} prompt`,
      );
    }
  }

  plan(canonicalInputSerialized: string, systemPromptBytes: number): FusionBudgetPlanV1 {
    const bytes = Buffer.byteLength(canonicalInputSerialized, 'utf8') + systemPromptBytes;
    const tokens = fusionTokenUpperBound(bytes);
    const base: FusionStageBudgetPlanEntry = {
      budget_stage: 'candidate',
      measurement_kind: 'worst_case_envelope',
      measured_utf8_bytes: bytes,
      measured_input_tokens_upper_bound: tokens,
      allowed_input_tokens: this.allowedCanonicalInputTokens,
      limiting_qualified_id: this.limiting.qualified_id,
      slack_tokens: this.allowedCanonicalInputTokens - tokens,
    };
    return {
      schema_version: FUSION_BUDGET_PLAN_SCHEMA_VERSION,
      policy: FUSION_BUDGET_POLICY,
      routes: this.routes,
      limiting_qualified_id: this.limiting.qualified_id,
      base_context: base,
    };
  }
}

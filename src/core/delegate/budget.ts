import {
  allowedInputTokens,
  isUsableContextWindow,
  tokenUpperBound,
  utf8ByteLength,
} from '../context/token-budget.js';
import {
  DELEGATE_BUDGET_PLAN_SCHEMA_VERSION,
  DelegateError,
  type DelegateLimits,
  type DelegatePinnedRoute,
} from './types.js';

/**
 * Delegate budgeting.
 *
 * A delegate child is a multi-turn, tool-using agent, so its budget has two
 * distinct phases rather than Fusion's single-shot stage forecast:
 *
 * 1. **Launch admission** — can the frozen seed plus framing plus the child's
 *    own system prompt fit the pinned route with room reserved for the final
 *    answer? Evaluated before the process, session, and artifacts exist.
 * 2. **Runtime governor** — before each model call, does the complete retained
 *    input still fit with the next-output reserve intact? Enforced inside the
 *    child by the `context` hook.
 *
 * Nothing here clamps, downgrades, or silently reduces. An input that does not
 * fit is a typed refusal.
 */

/** Output tokens reserved so the child can always finish an answer. */
export const DELEGATE_RESERVED_OUTPUT_TOKENS = 16_384;
/** Provider/tool-schema framing the package does not directly control. */
export const DELEGATE_FRAMING_RESERVE_TOKENS = 8_192;
export const DELEGATE_SAFETY_RESERVE_TOKENS = 4_096;
/** Below this, a route cannot hold a useful seed plus real investigation. */
export const DELEGATE_MIN_USABLE_INPUT_TOKENS = 8_192;
export const DELEGATE_MIN_CONTEXT_WINDOW_TOKENS =
  DELEGATE_MIN_USABLE_INPUT_TOKENS +
  DELEGATE_RESERVED_OUTPUT_TOKENS +
  DELEGATE_FRAMING_RESERVE_TOKENS +
  DELEGATE_SAFETY_RESERVE_TOKENS;

export const DELEGATE_DEFAULT_MAX_TURNS = 24;
export const DELEGATE_DEFAULT_MAX_TOOL_CALLS = 120;
export const DELEGATE_DEFAULT_TIMEOUT_SECONDS = 900;
export const DELEGATE_MAX_TOOL_RESULT_BYTES = 64 * 1024;
export const DELEGATE_MAX_TOTAL_TOOL_OUTPUT_BYTES = 64 * 1024 * 1024;
export const DELEGATE_MAX_ANSWER_BYTES = 4 * 1024 * 1024;
/** Answers at or under this serialize inline; larger ones degrade explicitly. */
export const DELEGATE_INLINE_ANSWER_BYTES = 48 * 1024;

export const DELEGATE_BUDGET_POLICY_ID = 'delegate-budget-policy-v1';

export interface DelegateBudgetPolicyDescriptor {
  id: typeof DELEGATE_BUDGET_POLICY_ID;
  bytes_per_token_divisor: number;
  reserved_output_tokens: number;
  framing_reserve_tokens: number;
  safety_reserve_tokens: number;
  min_usable_input_tokens: number;
  inline_answer_bytes: number;
}

export const DELEGATE_BUDGET_POLICY: DelegateBudgetPolicyDescriptor = {
  id: DELEGATE_BUDGET_POLICY_ID,
  bytes_per_token_divisor: 2,
  reserved_output_tokens: DELEGATE_RESERVED_OUTPUT_TOKENS,
  framing_reserve_tokens: DELEGATE_FRAMING_RESERVE_TOKENS,
  safety_reserve_tokens: DELEGATE_SAFETY_RESERVE_TOKENS,
  min_usable_input_tokens: DELEGATE_MIN_USABLE_INPUT_TOKENS,
  inline_answer_bytes: DELEGATE_INLINE_ANSWER_BYTES,
};

export interface DelegateAdmissionPlanV1 {
  schema_version: typeof DELEGATE_BUDGET_PLAN_SCHEMA_VERSION;
  policy: DelegateBudgetPolicyDescriptor;
  route: {
    provider: string;
    model: string;
    qualified_id: string;
    context_window_tokens: number;
    allowed_input_tokens: number;
  };
  seed_utf8_bytes: number;
  system_prompt_utf8_bytes: number;
  launch_utf8_bytes: number;
  launch_input_tokens_upper_bound: number;
  signed_headroom_tokens: number;
  utilization: number;
  fits: boolean;
  limits: DelegateLimits;
}

/**
 * Usable input tokens for a pinned route.
 *
 * A route with an unknown, non-integral, or non-positive context window is a
 * loud `route_capacity_unknown` refusal. The delegate never assumes a default
 * window, because assuming one is how oversized prompts reach a provider.
 */
export function delegateAllowedInputTokens(route: DelegatePinnedRoute): number {
  if (!isUsableContextWindow(route.context_window_tokens)) {
    throw new DelegateError(
      `bg_delegate route ${route.qualified_id} reports no usable context-window capacity`,
      {
        code: 'route_capacity_unknown',
        childCreated: false,
        remediation: [
          'Pin an explicit route whose model catalogue entry declares a context window.',
          'No child was created and no capacity was assumed.',
        ],
      },
    );
  }
  const allowed = allowedInputTokens(route.context_window_tokens, {
    reservedOutputTokens: DELEGATE_RESERVED_OUTPUT_TOKENS,
    framingReserveTokens: DELEGATE_FRAMING_RESERVE_TOKENS,
    safetyReserveTokens: DELEGATE_SAFETY_RESERVE_TOKENS,
  });
  if (allowed < DELEGATE_MIN_USABLE_INPUT_TOKENS) {
    throw new DelegateError(
      `bg_delegate route ${route.qualified_id} has a ${String(route.context_window_tokens)}-token context window, but a delegate child requires at least ${String(DELEGATE_MIN_CONTEXT_WINDOW_TOKENS)} tokens: ${String(DELEGATE_RESERVED_OUTPUT_TOKENS)} output + ${String(DELEGATE_FRAMING_RESERVE_TOKENS)} framing + ${String(DELEGATE_SAFETY_RESERVE_TOKENS)} safety + ${String(DELEGATE_MIN_USABLE_INPUT_TOKENS)} usable input`,
      {
        code: 'route_capacity_unknown',
        childCreated: false,
        remediation: ['Pin a larger-context route for this delegate.'],
      },
    );
  }
  return allowed;
}

export interface DelegateAdmissionInput {
  route: DelegatePinnedRoute;
  seedSerialized: string;
  childSystemPrompt: string;
  limits: DelegateLimits;
}

/** Deterministic launch-admission forecast. Pure; creates nothing. */
export function planDelegateAdmission(input: DelegateAdmissionInput): DelegateAdmissionPlanV1 {
  const allowed = delegateAllowedInputTokens(input.route);
  const seedBytes = utf8ByteLength(input.seedSerialized);
  const systemBytes = utf8ByteLength(input.childSystemPrompt);
  const launchBytes = seedBytes + systemBytes;
  const tokens = tokenUpperBound(launchBytes);
  return {
    schema_version: DELEGATE_BUDGET_PLAN_SCHEMA_VERSION,
    policy: DELEGATE_BUDGET_POLICY,
    route: {
      provider: input.route.provider,
      model: input.route.model,
      qualified_id: input.route.qualified_id,
      context_window_tokens: input.route.context_window_tokens,
      allowed_input_tokens: allowed,
    },
    seed_utf8_bytes: seedBytes,
    system_prompt_utf8_bytes: systemBytes,
    launch_utf8_bytes: launchBytes,
    launch_input_tokens_upper_bound: tokens,
    signed_headroom_tokens: allowed - tokens,
    utilization: tokens / allowed,
    fits: tokens <= allowed,
    limits: input.limits,
  };
}

/**
 * Enforce the admission plan.
 *
 * Called before the child process, the child session, and the artifact
 * directory exist, so a refusal leaves zero children and zero artifacts.
 */
export function assertDelegateAdmission(plan: DelegateAdmissionPlanV1): void {
  if (plan.fits) return;
  const overage = plan.launch_input_tokens_upper_bound - plan.route.allowed_input_tokens;
  throw new DelegateError(
    `bg_delegate seed does not fit the pinned route before launch. Route ${plan.route.qualified_id} allows ${String(plan.route.allowed_input_tokens)} input tokens; the frozen seed plus the child system prompt measure ${String(plan.launch_utf8_bytes)} UTF-8 bytes (<= ${String(plan.launch_input_tokens_upper_bound)} input tokens), over by ${String(overage)} tokens. No child process, child session, or artifact was created. Nothing was clipped, dropped, or substituted.`,
    {
      code: 'seed_budget_exceeded',
      childCreated: false,
      remediation: [
        'Pin a larger-context route with the route argument.',
        'Delegate earlier in the session, or start a fresh conversation, so less history is projected.',
        'Restate only the required findings as visible conversation text; omitted tool payloads are not what is large here.',
      ],
    },
  );
}

export interface DelegateRuntimeMeasurement {
  /** Complete retained input for the next model call, in UTF-8 bytes. */
  retainedInputBytes: number;
}

export interface DelegateGovernorVerdict {
  withinBudget: boolean;
  measuredTokens: number;
  allowedTokens: number;
  overageTokens: number;
}

/**
 * Runtime governor decision for one prospective model call.
 *
 * Pure and total, so the child guard can call it from inside a hook with no
 * possibility of throwing where a throw would be swallowed.
 */
export function evaluateDelegateRuntimeBudget(
  measurement: DelegateRuntimeMeasurement,
  allowedTokens: number,
): DelegateGovernorVerdict {
  const measuredTokens = tokenUpperBound(measurement.retainedInputBytes);
  return {
    withinBudget: measuredTokens <= allowedTokens,
    measuredTokens,
    allowedTokens,
    overageTokens: Math.max(0, measuredTokens - allowedTokens),
  };
}

export interface DelegateLimitOverrides {
  maxTurns?: number | undefined;
  maxToolCalls?: number | undefined;
  timeoutSeconds?: number | undefined;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new DelegateError(`bg_delegate ${label} must be a positive integer`, {
      code: 'invalid_arguments',
      childCreated: false,
    });
  }
  return value;
}

export function resolveDelegateLimits(
  route: DelegatePinnedRoute,
  overrides: DelegateLimitOverrides = {},
): DelegateLimits {
  return {
    max_turns: positiveInteger(overrides.maxTurns, DELEGATE_DEFAULT_MAX_TURNS, 'maxTurns'),
    max_tool_calls: positiveInteger(
      overrides.maxToolCalls,
      DELEGATE_DEFAULT_MAX_TOOL_CALLS,
      'maxToolCalls',
    ),
    timeout_seconds: positiveInteger(
      overrides.timeoutSeconds,
      DELEGATE_DEFAULT_TIMEOUT_SECONDS,
      'timeoutSeconds',
    ),
    max_tool_result_bytes: DELEGATE_MAX_TOOL_RESULT_BYTES,
    max_total_tool_output_bytes: DELEGATE_MAX_TOTAL_TOOL_OUTPUT_BYTES,
    max_answer_bytes: DELEGATE_MAX_ANSWER_BYTES,
    allowed_input_tokens: delegateAllowedInputTokens(route),
  };
}

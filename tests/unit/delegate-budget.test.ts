import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DELEGATE_FRAMING_RESERVE_TOKENS,
  DELEGATE_INLINE_ANSWER_BYTES,
  DELEGATE_MIN_CONTEXT_WINDOW_TOKENS,
  DELEGATE_MIN_USABLE_INPUT_TOKENS,
  DELEGATE_RESERVED_OUTPUT_TOKENS,
  DELEGATE_SAFETY_RESERVE_TOKENS,
  assertDelegateAdmission,
  delegateAllowedInputTokens,
  evaluateDelegateRuntimeBudget,
  planDelegateAdmission,
  resolveDelegateLimits,
} from '../../src/core/delegate/budget.js';
import { DelegateError, type DelegatePinnedRoute } from '../../src/core/delegate/types.js';
import {
  TOKEN_BUDGET_AFFINE_F_TOKENS,
  TOKEN_BUDGET_FAMILY_CALIBRATIONS,
  TOKEN_BUDGET_PROVABLE_RATE_X100,
  estimateInputTokens,
  maxKnownTextBytesForTokens,
  resolveTokenBudgetFamily,
} from '../../src/core/context/token-budget.js';

function route(
  contextWindow: number,
  provider = 'openai-codex',
  model = 'gpt-5.5',
): DelegatePinnedRoute {
  return {
    provider,
    model,
    qualified_id: `${provider}/${model}`,
    context_window_tokens: contextWindow,
    thinking_level: 'medium',
    origin: 'explicit',
  };
}

const LIMITS = {
  max_turns: 24,
  max_tool_calls: 120,
  timeout_seconds: 900,
  max_tool_result_bytes: 65_536,
  max_total_tool_output_bytes: 67_108_864,
  max_answer_bytes: 4_194_304,
  allowed_input_tokens: 0,
};

function maxDelegateKnownBytes(pinnedRoute: DelegatePinnedRoute): number {
  const family = resolveTokenBudgetFamily(pinnedRoute);
  return maxKnownTextBytesForTokens({
    family: family.family,
    allowedInputTokens: delegateAllowedInputTokens(pinnedRoute),
    scope: 'delegate',
  });
}

function delegateTokenForecast(bytes: number, allowedInputTokens: number): number {
  return estimateInputTokens({
    family: 'openai-codex',
    allowedInputTokens,
    scope: 'delegate',
    segments: [{ kind: 'known_text', bytes, multibyteBytes: 0, denseBytes: 0 }],
  }).tokens;
}

void describe('delegate route capacity', () => {
  void it('subtracts every documented reserve from the context window', () => {
    const window = 200_000;
    assert.equal(
      delegateAllowedInputTokens(route(window)),
      window -
        DELEGATE_RESERVED_OUTPUT_TOKENS -
        DELEGATE_FRAMING_RESERVE_TOKENS -
        DELEGATE_SAFETY_RESERVE_TOKENS,
    );
  });

  void it('accepts exactly the documented minimum window and rejects one token below', () => {
    assert.equal(
      delegateAllowedInputTokens(route(DELEGATE_MIN_CONTEXT_WINDOW_TOKENS)),
      DELEGATE_MIN_USABLE_INPUT_TOKENS,
    );
    assert.throws(
      () => delegateAllowedInputTokens(route(DELEGATE_MIN_CONTEXT_WINDOW_TOKENS - 1)),
      (error: unknown) =>
        error instanceof DelegateError &&
        error.code === 'route_capacity_unknown' &&
        error.childCreated === false,
    );
  });

  void it('never assumes a default window for unusable capacity', () => {
    for (const window of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
      assert.throws(
        () => delegateAllowedInputTokens(route(window)),
        (error: unknown) =>
          error instanceof DelegateError && error.code === 'route_capacity_unknown',
        `window ${String(window)} must be refused, not defaulted`,
      );
    }
  });
});

void describe('delegate launch admission', () => {
  void it('fits when the seed is comfortably under the route allowance', () => {
    const pinnedRoute = route(200_000);
    const plan = planDelegateAdmission({
      route: pinnedRoute,
      seedSerialized: 'x'.repeat(1000),
      childSystemPrompt: 'y'.repeat(500),
      limits: LIMITS,
    });
    assert.equal(plan.fits, true);
    assert.equal(plan.schema_version, 'pi-background-tasks.delegate-budget-plan.v2');
    assert.equal(plan.policy.id, 'delegate-budget-policy-v2');
    assert.equal(plan.seed_utf8_bytes, 1000);
    assert.equal(plan.system_prompt_utf8_bytes, 500);
    assert.equal(plan.launch_utf8_bytes, 1500);
    assert.equal(plan.launch_input_tokens_upper_bound, plan.estimate.tokens);
    assert.equal(plan.route.family, 'openai-codex');
    assert.equal(plan.route.rate_source.source, 'delegate_conservative');
    assert.doesNotThrow(() => {
      assertDelegateAdmission(plan);
    });
  });

  void it('accepts exactly at the affine boundary and rejects one byte past it', () => {
    const pinnedRoute = route(200_000);
    const exactBytes = maxDelegateKnownBytes(pinnedRoute);
    const atLimit = planDelegateAdmission({
      route: pinnedRoute,
      seedSerialized: 'x'.repeat(exactBytes),
      childSystemPrompt: '',
      limits: LIMITS,
    });
    assert.equal(atLimit.fits, true);
    assert.equal(atLimit.signed_headroom_tokens, 0);
    assert.doesNotThrow(() => {
      assertDelegateAdmission(atLimit);
    });

    const overLimit = planDelegateAdmission({
      route: pinnedRoute,
      seedSerialized: 'x'.repeat(exactBytes + 1),
      childSystemPrompt: '',
      limits: LIMITS,
    });
    assert.equal(overLimit.fits, false);
    assert.throws(
      () => {
        assertDelegateAdmission(overLimit);
      },
      (error: unknown) =>
        error instanceof DelegateError &&
        error.code === 'seed_budget_exceeded' &&
        error.childCreated === false,
    );
  });

  void it('counts the child system prompt as input, not as free framing', () => {
    const pinnedRoute = route(200_000);
    const seedBytes = maxDelegateKnownBytes(pinnedRoute);
    const plan = planDelegateAdmission({
      route: pinnedRoute,
      seedSerialized: 'x'.repeat(seedBytes),
      childSystemPrompt: 'y'.repeat(2),
      limits: LIMITS,
    });
    assert.equal(plan.fits, false, 'the system prompt must consume the same allowance');
  });

  void it('measures multi-byte UTF-8 by bytes and persists the provable advisory ceiling', () => {
    const emoji = '👩‍👩‍👧‍👦';
    const plan = planDelegateAdmission({
      route: route(200_000),
      seedSerialized: emoji.repeat(100),
      childSystemPrompt: '',
      limits: LIMITS,
    });
    assert.equal(plan.seed_utf8_bytes, Buffer.byteLength(emoji.repeat(100), 'utf8'));
    assert.ok(plan.seed_utf8_bytes > emoji.repeat(100).length);
    assert.equal(plan.estimate.byte_class_breakdown.multibyte_bytes, plan.seed_utf8_bytes);
    assert.equal(plan.estimate.perSegment[0]?.multibyte_provable_tokens, plan.seed_utf8_bytes);
    assert.ok((plan.estimate.perSegment[0]?.multibyte_tokens ?? 0) < plan.seed_utf8_bytes);
    assert.equal(plan.dominant_byte_class, 'multibyte');
  });

  void it('scope guard refuses the codex 23,674-byte delegate floor case', () => {
    const pinnedRoute = route(DELEGATE_MIN_CONTEXT_WINDOW_TOKENS, 'openai-codex', 'gpt-5.5');
    assert.equal(delegateAllowedInputTokens(pinnedRoute), 8192);
    const plan = planDelegateAdmission({
      route: pinnedRoute,
      seedSerialized: 'x'.repeat(23_674),
      childSystemPrompt: '',
      limits: LIMITS,
    });
    assert.equal(plan.route.rate_source.source, 'delegate_conservative');
    assert.equal(plan.fits, false);
    assert.throws(
      () => assertDelegateAdmission(plan),
      (error: unknown) => error instanceof DelegateError && error.code === 'seed_budget_exceeded',
    );
  });

  void it('scope guard refuses the anthropic 13,286-byte delegate zero-headroom case', () => {
    const pinnedRoute = route(DELEGATE_MIN_CONTEXT_WINDOW_TOKENS, 'anthropic', 'claude-opus-5');
    assert.equal(delegateAllowedInputTokens(pinnedRoute), 8192);
    const beforeAnthropicForecast = estimateInputTokens({
      family: 'anthropic',
      allowedInputTokens: 8192,
      scope: 'fusion',
      segments: [{ kind: 'known_text', bytes: 13_286, multibyteBytes: 0, denseBytes: 0 }],
    }).tokens;
    assert.equal(beforeAnthropicForecast, 8_192);
    const plan = planDelegateAdmission({
      route: pinnedRoute,
      seedSerialized: 'x'.repeat(13_286),
      childSystemPrompt: '',
      limits: LIMITS,
    });
    assert.equal(plan.route.rate_source.source, 'delegate_conservative');
    assert.equal(plan.route.rate_source.backed, true);
    assert.equal(plan.route.rate_source.effective_rate_bytes_per_token_x100, TOKEN_BUDGET_PROVABLE_RATE_X100);
    assert.equal(plan.launch_input_tokens_upper_bound, 13_798);
    assert.equal(plan.fits, false);
    assert.throws(
      () => assertDelegateAdmission(plan),
      (error: unknown) => {
        assert.ok(error instanceof DelegateError);
        assert.equal(error.code, 'seed_budget_exceeded');
        assert.equal(error.budget?.rate_source.source, 'delegate_conservative');
        assert.equal(error.budget?.backed, true);
        assert.equal(error.budget?.dominant_byte_class, 'normal');
        assert.match(error.message, /backed=true/);
        assert.match(error.message, /dominant_byte_class=normal/);
        return true;
      },
    );
  });

  void it('unknown family is loud and no looser than calibrated families', () => {
    const unknownRoute = route(200_000, 'mystery-provider', 'mystery-model');
    const plan = planDelegateAdmission({
      route: unknownRoute,
      seedSerialized: 'x',
      childSystemPrompt: '',
      limits: LIMITS,
    });
    const calibratedRates = Object.values(TOKEN_BUDGET_FAMILY_CALIBRATIONS)
      .filter((entry) => entry.provenance.backed)
      .map((entry) => entry.rate_bytes_per_token_x100);
    assert.equal(plan.route.family, 'unknown');
    assert.equal(plan.route.rate_source.backed, false);
    assert.ok(plan.route.rate_source.warning?.includes('unknown provider'));
    assert.ok(
      plan.route.rate_source.effective_rate_bytes_per_token_x100 <= Math.min(...calibratedRates),
    );
    const oversized = planDelegateAdmission({
      route: unknownRoute,
      seedSerialized: 'x'.repeat(delegateAllowedInputTokens(unknownRoute)),
      childSystemPrompt: '',
      limits: LIMITS,
    });
    assert.throws(
      () => assertDelegateAdmission(oversized),
      (error: unknown) => {
        assert.ok(error instanceof DelegateError);
        assert.match(error.message, /unknown provider/);
        return true;
      },
    );
  });

  void it('states what was preserved and how to remediate, and never clamps', () => {
    const pinnedRoute = route(200_000);
    const plan = planDelegateAdmission({
      route: pinnedRoute,
      seedSerialized: 'x'.repeat(maxDelegateKnownBytes(pinnedRoute) * 2),
      childSystemPrompt: '',
      limits: LIMITS,
    });
    try {
      assertDelegateAdmission(plan);
      assert.fail('oversized admission must throw');
    } catch (error) {
      assert.ok(error instanceof DelegateError);
      assert.equal(error.code, 'seed_budget_exceeded');
      assert.equal(error.childCreated, false);
      assert.match(error.message, /No child process, child session, or artifact was created/);
      assert.match(error.message, /Nothing was clipped, dropped, or substituted/);
      assert.ok(error.remediation.length > 0);
      assert.match(error.describe(), /Child process created: no/);
    }
  });
});

void describe('delegate runtime governor', () => {
  void it('is total and never throws from inside a hook', () => {
    const pinnedRoute = route(200_000);
    for (const bytes of [0, 1, 10_000, 10_000_000]) {
      const verdict = evaluateDelegateRuntimeBudget(
        { retainedInputBytes: bytes, retainedInputMultibyteBytes: 0, retainedInputDenseBytes: 0 },
        5_000,
        pinnedRoute,
      );
      assert.equal(verdict.measuredTokens, delegateTokenForecast(bytes, 5_000));
      assert.equal(verdict.allowedTokens, 5_000);
    }
  });

  void it('permits exactly the allowance and refuses one token past it', () => {
    const allowed = 1_000;
    const pinnedRoute = route(allowed + 28_672);
    const exactBytes = maxKnownTextBytesForTokens({
      family: 'openai-codex',
      allowedInputTokens: allowed,
      scope: 'delegate',
    });
    const exact = evaluateDelegateRuntimeBudget(
      {
        retainedInputBytes: exactBytes,
        retainedInputMultibyteBytes: 0,
        retainedInputDenseBytes: 0,
      },
      allowed,
      pinnedRoute,
    );
    assert.equal(exact.withinBudget, true);
    assert.equal(exact.overageTokens, 0);

    const over = evaluateDelegateRuntimeBudget(
      {
        retainedInputBytes: exactBytes + 1,
        retainedInputMultibyteBytes: 0,
        retainedInputDenseBytes: 0,
      },
      allowed,
      pinnedRoute,
    );
    assert.equal(over.withinBudget, false);
    assert.equal(over.overageTokens, 1);
  });
});

void describe('delegate limits', () => {
  void it('applies documented defaults and derives the route allowance', () => {
    const limits = resolveDelegateLimits(route(200_000));
    assert.equal(limits.max_turns, 24);
    assert.equal(limits.max_tool_calls, 120);
    assert.equal(limits.timeout_seconds, 1200);
    assert.equal(limits.allowed_input_tokens, delegateAllowedInputTokens(route(200_000)));
  });

  void it('rejects non-positive and non-integer overrides loudly', () => {
    for (const value of [0, -1, 1.5, Number.NaN]) {
      assert.throws(
        () => resolveDelegateLimits(route(200_000), { maxTurns: value }),
        (error: unknown) => error instanceof DelegateError && error.code === 'invalid_arguments',
      );
    }
  });

  void it('keeps the inline answer cap strictly below the answer capture cap', () => {
    const limits = resolveDelegateLimits(route(200_000));
    assert.ok(
      DELEGATE_INLINE_ANSWER_BYTES < limits.max_answer_bytes,
      'an answer must be capturable even when it is too large to inline',
    );
    assert.equal(TOKEN_BUDGET_AFFINE_F_TOKENS, 512);
  });
});

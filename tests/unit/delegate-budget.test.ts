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
import { BYTES_PER_TOKEN_DIVISOR, tokenUpperBound } from '../../src/core/context/token-budget.js';

function route(contextWindow: number): DelegatePinnedRoute {
  return {
    provider: 'p',
    model: 'm',
    qualified_id: 'p/m',
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
    const plan = planDelegateAdmission({
      route: route(200_000),
      seedSerialized: 'x'.repeat(1000),
      childSystemPrompt: 'y'.repeat(500),
      limits: LIMITS,
    });
    assert.equal(plan.fits, true);
    assert.equal(plan.seed_utf8_bytes, 1000);
    assert.equal(plan.system_prompt_utf8_bytes, 500);
    assert.equal(plan.launch_utf8_bytes, 1500);
    assert.equal(plan.launch_input_tokens_upper_bound, tokenUpperBound(1500));
    assert.doesNotThrow(() => {
      assertDelegateAdmission(plan);
    });
  });

  void it('accepts exactly at the boundary and rejects one byte past it', () => {
    const pinnedRoute = route(200_000);
    const allowed = delegateAllowedInputTokens(pinnedRoute);
    const exactBytes = allowed * BYTES_PER_TOKEN_DIVISOR;
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
    const allowed = delegateAllowedInputTokens(pinnedRoute);
    const seedBytes = allowed * BYTES_PER_TOKEN_DIVISOR;
    const plan = planDelegateAdmission({
      route: pinnedRoute,
      seedSerialized: 'x'.repeat(seedBytes),
      childSystemPrompt: 'y'.repeat(2),
      limits: LIMITS,
    });
    assert.equal(plan.fits, false, 'the system prompt must consume the same allowance');
  });

  void it('measures multi-byte UTF-8 by bytes, not by code points', () => {
    const emoji = '👩‍👩‍👧‍👦';
    const plan = planDelegateAdmission({
      route: route(200_000),
      seedSerialized: emoji.repeat(100),
      childSystemPrompt: '',
      limits: LIMITS,
    });
    assert.equal(plan.seed_utf8_bytes, Buffer.byteLength(emoji.repeat(100), 'utf8'));
    assert.ok(plan.seed_utf8_bytes > emoji.repeat(100).length);
  });

  void it('states what was preserved and how to remediate, and never clamps', () => {
    const pinnedRoute = route(200_000);
    const allowed = delegateAllowedInputTokens(pinnedRoute);
    const plan = planDelegateAdmission({
      route: pinnedRoute,
      seedSerialized: 'x'.repeat(allowed * BYTES_PER_TOKEN_DIVISOR * 2),
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
    for (const bytes of [0, 1, 10_000, 10_000_000]) {
      const verdict = evaluateDelegateRuntimeBudget({ retainedInputBytes: bytes }, 5_000);
      assert.equal(verdict.measuredTokens, tokenUpperBound(bytes));
      assert.equal(verdict.allowedTokens, 5_000);
    }
  });

  void it('permits exactly the allowance and refuses one token past it', () => {
    const allowed = 1_000;
    const exact = evaluateDelegateRuntimeBudget(
      { retainedInputBytes: allowed * BYTES_PER_TOKEN_DIVISOR },
      allowed,
    );
    assert.equal(exact.withinBudget, true);
    assert.equal(exact.overageTokens, 0);

    const over = evaluateDelegateRuntimeBudget(
      { retainedInputBytes: allowed * BYTES_PER_TOKEN_DIVISOR + BYTES_PER_TOKEN_DIVISOR },
      allowed,
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
    assert.equal(limits.timeout_seconds, 900);
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
  });
});

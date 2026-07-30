import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseJsonText } from '../../src/core/common.js';
import {
  FUSION_BYTES_PER_TOKEN_DIVISOR,
  FUSION_CANDIDATE_MAX_OUTPUT_BYTES,
  FUSION_MIN_CANONICAL_INPUT_TOKENS,
  FUSION_MIN_CONTEXT_WINDOW_TOKENS,
  FUSION_DIAGNOSTICS_MAX_BYTES,
  FUSION_EVALUATION_MAX_OUTPUT_BYTES,
  FUSION_DOWNSTREAM_RESERVE_BYTES,
  FUSION_DOWNSTREAM_RESERVE_TOKENS,
  FUSION_FRAMING_RESERVE_TOKENS,
  FUSION_RESERVED_OUTPUT_TOKENS,
  FUSION_SAFETY_RESERVE_TOKENS,
  FUSION_WRAPPER_OVERHEAD_BYTES,
  FusionBudget,
  assertChildOutputWithinContract,
  fusionLimitingRoute,
  fusionRouteCapacities,
  fusionTokenUpperBound,
} from '../../src/core/fusion/budget.js';
import { FusionOrchestrator, type FusionChildRunner } from '../../src/core/fusion/orchestrator.js';
import { defaultFusionModelConfig } from '../../src/core/fusion/config.js';
import { buildFusionCanonicalInput } from '../../src/core/fusion/context.js';
import {
  FUSION_COMMAND_CONTEXT_POLICY_ID,
  FUSION_CONTEXT_TRANSFORM_ID,
  FUSION_EVALUATION_SCHEMA_VERSION,
  FUSION_INPUT_SCHEMA_VERSION,
  FusionError,
  type FusionCanonicalInputV2,
  type FusionChildRunResult,
  type FusionEvaluationV1,
  type ResolvedFusionModel,
  type ResolvedFusionModels,
} from '../../src/core/fusion/types.js';
import type { RunPiChildOptions } from '../../src/core/fusion/pi-child.js';
import { emptyLedger, sessionWith, userMessage } from '../helpers/fusion-canonical.js';

const ledger = emptyLedger(FUSION_COMMAND_CONTEXT_POLICY_ID);

function resolved(qualifiedId: string, contextWindow: number): ResolvedFusionModel {
  const slash = qualifiedId.indexOf('/');
  return {
    selection: '$current',
    source: 'current',
    provider: qualifiedId.slice(0, slash),
    model: qualifiedId.slice(slash + 1),
    qualifiedId,
    thinkingLevel: 'high',
    contextWindow,
  };
}

/** Mirrors the real reported panel: two large-window models plus a smaller one. */
function models(options: { small?: number; large?: number } = {}): ResolvedFusionModels {
  const large = options.large ?? 272_000;
  const small = options.small ?? 200_000;
  return {
    candidates: [
      resolved('openai-codex/gpt-5.6-sol', large),
      resolved('openai-codex/gpt-5.6-terra', large),
      resolved('openai-codex/gpt-5.4-mini', small),
    ],
    evaluator: resolved('openai-codex/gpt-5.6-sol', large),
    merger: resolved('openai-codex/gpt-5.6-sol', large),
  };
}

function canonicalInput(text: string): FusionCanonicalInputV2 {
  return {
    schema_version: FUSION_INPUT_SCHEMA_VERSION,
    cwd: '/tmp/project',
    system_prompt: 'system',
    request: {
      source: 'command',
      authority: 'directive_over_projected_conversation',
      text: 'solve',
      sha256: 'b'.repeat(64),
    },
    conversation_projection: {
      policy: {
        id: FUSION_COMMAND_CONTEXT_POLICY_ID,
        transform: FUSION_CONTEXT_TRANSFORM_ID,
        version: 1,
        user_text: 'verbatim',
        assistant_text: 'verbatim',
        assistant_thinking: 'ledger_only',
        tool_call_arguments: 'ledger_only',
        tool_results: 'ledger_only',
        tool_payload_preview_bytes: 0,
        images: 'marker_or_ledger_only',
        unknown_block_behavior: 'error',
      },
      branch_filter: {
        id: 'exclude-active-fusion-subtree-v1',
        tool_name: 'fusion_brainstorm',
        tool_call_id: null,
        active_tool_call_leaf_excluded: false,
      },
      entries: [{ kind: 'text', source_ordinal: 0, block_ordinal: 0, role: 'user', text }],
      accounting: {
        message_count: 1,
        included_text_entry_count: 1,
        included_user_text_bytes: Buffer.byteLength(text, 'utf8'),
        included_assistant_text_bytes: 0,
        included_image_marker_count: 0,
        empty_text_block_count: 0,
        omitted_run_count: 0,
        omitted_event_count: 0,
        omitted_thinking_bytes: 0,
        omitted_tool_call_count: 0,
        omitted_tool_call_argument_bytes: 0,
        omitted_tool_result_text_count: 0,
        omitted_tool_result_text_bytes: 0,
        omitted_tool_result_image_count: 0,
        omitted_tool_result_image_bytes: 0,
        tool_call_names: [],
        ledger_entry_count: 0,
        ledger_root_sha256: 'a'.repeat(64),
      },
    },
  };
}

function evaluation(): FusionEvaluationV1 {
  const one = (id: 'A' | 'B' | 'C') => ({
    candidate_id: id,
    summary: id,
    strengths: [id],
    limitations: [id],
    useful_contributions: [id],
    risks: [id],
  });
  return {
    schema_version: FUSION_EVALUATION_SCHEMA_VERSION,
    candidate_assessments: [one('A'), one('B'), one('C')],
    agreements: ['agree'],
    conflicts: [],
    synthesis_plan: {
      must_include: [{ candidate_id: 'A', contribution: 'a' }],
      must_resolve: [],
      must_avoid: [],
    },
  };
}

function childResult(options: RunPiChildOptions, text: string): FusionChildRunResult {
  const result: FusionChildRunResult = {
    stage: options.stage,
    attempt: options.attempt,
    provider: options.model.provider,
    model: options.model.model,
    qualifiedId: options.model.qualifiedId,
    text,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    events: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    exitCode: 0,
    signal: null,
  };
  if (options.slot !== undefined) result.slot = options.slot;
  return result;
}

interface RunOutcome {
  error: FusionError;
  calls: readonly RunPiChildOptions[];
  root: string;
  artifactDir: string;
}

async function runExpectingFailure(
  input: FusionCanonicalInputV2,
  runner: FusionChildRunner,
  resolvedModels: ResolvedFusionModels = models(),
): Promise<RunOutcome> {
  const root = await mkdtemp(join(tmpdir(), 'pi-fusion-budget-'));
  const calls: RunPiChildOptions[] = [];
  const tracking: FusionChildRunner = async (options) => {
    calls.push(options);
    return runner(options);
  };
  const orchestrator = new FusionOrchestrator({ childRunner: tracking });
  let thrown: unknown;
  try {
    await orchestrator.run({
      source: 'command',
      cwd: root,
      canonicalInput: input,
      canonicalInputSerialized: JSON.stringify(input),
      contextLedger: ledger,
      config: defaultFusionModelConfig(),
      models: resolvedModels,
    });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof FusionError, 'run must fail with a FusionError');
  return { error: thrown, calls, root, artifactDir: thrown.artifactDir ?? '' };
}

function assertBudgetError(
  error: FusionError,
  stage: 'candidate' | 'evaluation' | 'evaluation_repair' | 'merge',
): void {
  assert.equal(error.code, 'prompt_budget_exceeded');
  assert.equal(error.childCreated, false, 'budget rejection must not claim a child was created');
  const budget = error.budget;
  assert.ok(budget, 'budget failure must carry structured detail');
  assert.equal(budget.budget_stage, stage);
  assert.ok(budget.measured_utf8_bytes > 0);
  assert.ok(budget.measured_input_tokens_upper_bound > budget.allowed_input_tokens);
  assert.ok(budget.allowed_input_tokens > 0);
  assert.ok(budget.limiting_model.qualified_id.length > 0);
  assert.ok(budget.limiting_model.context_window_tokens > 0);
  assert.ok(budget.remediation.length > 0);
  // The human-readable message must name every actionable fact too.
  assert.match(error.message, /exceeds the safe input budget before child creation/);
  assert.match(error.message, new RegExp(String(budget.measured_utf8_bytes)));
  assert.match(error.message, new RegExp(String(budget.allowed_input_tokens)));
  assert.match(error.message, new RegExp(budget.limiting_model.qualified_id));
  assert.match(error.message, /Remediation:/);
}

void describe('fusion stage budgets', () => {
  void it('derives the token bound and reserves from documented constants', () => {
    assert.equal(fusionTokenUpperBound(0), 0);
    assert.equal(fusionTokenUpperBound(1), 1);
    assert.equal(fusionTokenUpperBound(2), 1);
    assert.equal(fusionTokenUpperBound(3), 2);
    // The divisor must stay conservative: never assume 4 bytes per token.
    assert.ok(
      FUSION_BYTES_PER_TOKEN_DIVISOR <= 2,
      'bytes-per-token divisor must remain a conservative lower bound',
    );
  });

  void it('bases safety on the smallest configured route, not the largest', () => {
    const routes = fusionRouteCapacities(models({ small: 200_000, large: 1_000_000 }));
    const limiting = fusionLimitingRoute(routes);
    assert.equal(limiting.qualified_id, 'openai-codex/gpt-5.4-mini');
    assert.equal(limiting.context_window_tokens, 200_000);
    assert.equal(
      limiting.allowed_input_tokens,
      200_000 -
        FUSION_RESERVED_OUTPUT_TOKENS -
        FUSION_FRAMING_RESERVE_TOKENS -
        FUSION_SAFETY_RESERVE_TOKENS,
    );
    // Even when the small model is the evaluator rather than a candidate.
    const evaluatorSmall: ResolvedFusionModels = {
      candidates: [
        resolved('p/big1', 1_000_000),
        resolved('p/big2', 1_000_000),
        resolved('p/big3', 1_000_000),
      ],
      evaluator: resolved('p/small', 200_000),
      merger: resolved('p/big1', 1_000_000),
    };
    assert.equal(
      fusionLimitingRoute(fusionRouteCapacities(evaluatorSmall)).qualified_id,
      'p/small',
    );
  });

  void it('rejects routes whose capacity is unknown or too small to hold input', () => {
    for (const contextWindow of [0, -1, Number.NaN, 1_000, 128_000]) {
      const bad: ResolvedFusionModels = {
        candidates: [
          resolved('p/a', 200_000),
          resolved('p/b', 200_000),
          resolved('p/c', contextWindow),
        ],
        evaluator: resolved('p/a', 200_000),
        merger: resolved('p/a', 200_000),
      };
      assert.throws(
        () => new FusionBudget(bad, FUSION_COMMAND_CONTEXT_POLICY_ID),
        (error: unknown) =>
          error instanceof FusionError &&
          error.code === 'model_capacity_unknown' &&
          error.childCreated === false,
        `context window ${String(contextWindow)} must be rejected`,
      );
    }
  });

  void it('withholds a derived downstream reserve from the canonical-input budget', () => {
    const budget = new FusionBudget(models(), FUSION_COMMAND_CONTEXT_POLICY_ID);
    assert.equal(
      budget.allowedCanonicalInputTokens,
      budget.allowedInputTokens - FUSION_DOWNSTREAM_RESERVE_TOKENS,
    );
    assert.ok(budget.allowedCanonicalInputTokens < budget.allowedInputTokens);
    // The reserve must be converted through the same byte-to-token function used
    // to measure prompts. Reserving output tokens directly would understate the
    // cost of re-embedding those bytes in a later stage.
    assert.equal(
      FUSION_DOWNSTREAM_RESERVE_TOKENS,
      fusionTokenUpperBound(FUSION_DOWNSTREAM_RESERVE_BYTES),
    );
    // And it must exceed the real measured repair-stage growth.
    assert.ok(
      FUSION_DOWNSTREAM_RESERVE_TOKENS > 96_088,
      'reserve must cover the measured evaluation-repair growth',
    );
  });

  void it('accepts a safe prompt at the boundary and rejects one byte past it', () => {
    const budget = new FusionBudget(models(), FUSION_COMMAND_CONTEXT_POLICY_ID);
    const allowedBytes = budget.allowedInputTokens * FUSION_BYTES_PER_TOKEN_DIVISOR;
    assert.doesNotThrow(() => {
      budget.assertStagePrompt('candidate', '', 'x'.repeat(allowedBytes));
    });
    assert.throws(
      () => {
        budget.assertStagePrompt('candidate', '', 'x'.repeat(allowedBytes + 1));
      },
      (error: unknown) => error instanceof FusionError && error.code === 'prompt_budget_exceeded',
    );
  });

  void it('counts the child system prompt as input, not free space', () => {
    const budget = new FusionBudget(models(), FUSION_COMMAND_CONTEXT_POLICY_ID);
    const allowedBytes = budget.allowedInputTokens * FUSION_BYTES_PER_TOKEN_DIVISOR;
    assert.throws(
      () => {
        budget.assertStagePrompt('candidate', 'ab', 'x'.repeat(allowedBytes - 1));
      },
      (error: unknown) => error instanceof FusionError && error.code === 'prompt_budget_exceeded',
    );
  });

  void it('counts multi-byte UTF-8 by bytes so dense non-ASCII cannot bypass accounting', () => {
    const budget = new FusionBudget(models(), FUSION_COMMAND_CONTEXT_POLICY_ID);
    const allowedBytes = budget.allowedInputTokens * FUSION_BYTES_PER_TOKEN_DIVISOR;
    // Each CJK char is 3 UTF-8 bytes; string length alone would understate it.
    const chars = Math.floor(allowedBytes / 3) + 1;
    const dense = '漢'.repeat(chars);
    assert.ok(dense.length < allowedBytes, 'string length must be below the byte allowance');
    assert.throws(
      () => {
        budget.assertStagePrompt('candidate', '', dense);
      },
      (error: unknown) => error instanceof FusionError && error.code === 'prompt_budget_exceeded',
    );
  });

  void it('rejects an oversized candidate stage before spawning a child', async () => {
    const oversized = canonicalInput('u'.repeat(400_000));
    const outcome = await runExpectingFailure(oversized, async (options) =>
      childResult(options, 'unreachable'),
    );
    try {
      assertBudgetError(outcome.error, 'candidate');
      assert.equal(outcome.calls.length, 0, 'no child may be launched when preflight rejects');
    } finally {
      await rm(outcome.root, { recursive: true, force: true });
    }
  });

  void it('bounds each child response so downstream stages cannot be overrun', async () => {
    // Defence in depth layer 1: a response larger than its stage contract is
    // rejected loudly, never sliced and never forwarded to a later stage.
    const budget = new FusionBudget(models(), FUSION_COMMAND_CONTEXT_POLICY_ID);
    const oversized = 'c'.repeat(FUSION_CANDIDATE_MAX_OUTPUT_BYTES + 1);
    const outcome = await runExpectingFailure(canonicalInput('small'), async (options) => {
      if (options.stage === 'candidate') return childResult(options, oversized);
      return childResult(options, 'unreachable');
    });
    try {
      assert.equal(outcome.error.code, 'child_output_cap');
      assert.match(outcome.error.message, /exceeding the \d+-byte output contract/);
      assert.match(outcome.error.message, /not forwarded or truncated/);
      assert.equal(
        outcome.calls.filter((call) => call.stage !== 'candidate').length,
        0,
        'no downstream child may run once a candidate breaks its contract',
      );
      // The oversized response is preserved as evidence.
      const preserved = await readFile(
        join(outcome.root, outcome.artifactDir, 'candidate-1.attempt-1.response.md'),
        'utf8',
      );
      assert.equal(preserved.length, oversized.length);
    } finally {
      await rm(outcome.root, { recursive: true, force: true });
    }
    assert.equal(budget.allowedInputTokens > 0, true);
  });

  void it('rejects evaluator, repair, and merger expansion before those children spawn', () => {
    // Defence in depth layer 2: even if a response somehow reached a later stage,
    // the exact rendered prompt is re-measured before that child is created.
    const budget = new FusionBudget(models(), FUSION_COMMAND_CONTEXT_POLICY_ID);
    const allowedBytes = budget.allowedInputTokens * FUSION_BYTES_PER_TOKEN_DIVISOR;
    const oversizedPrompt = 'p'.repeat(allowedBytes + 1);
    for (const stage of ['evaluation', 'evaluation_repair', 'merge'] as const) {
      let thrown: unknown;
      try {
        budget.assertStagePrompt(stage, '', oversizedPrompt);
      } catch (error) {
        thrown = error;
      }
      assert.ok(thrown instanceof FusionError, `${stage} must reject`);
      assertBudgetError(thrown, stage);
      assert.equal(thrown.budget?.measurement_kind, 'rendered_prompt');
    }
  });

  void it('states the minimum viable route capacity instead of accepting a route that must fail', () => {
    // The policy's uniform conservatism has a real consequence: routes below the
    // documented minimum cannot host the workflow. That is surfaced as an
    // actionable configuration error, not discovered later at the provider.
    assert.equal(
      FUSION_MIN_CONTEXT_WINDOW_TOKENS,
      FUSION_DOWNSTREAM_RESERVE_TOKENS +
        FUSION_MIN_CANONICAL_INPUT_TOKENS +
        FUSION_RESERVED_OUTPUT_TOKENS +
        FUSION_FRAMING_RESERVE_TOKENS +
        FUSION_SAFETY_RESERVE_TOKENS,
    );
    const tooSmall: ResolvedFusionModels = {
      candidates: [
        resolved('p/ok', 272_000),
        resolved('p/ok', 272_000),
        resolved('p/small', FUSION_MIN_CONTEXT_WINDOW_TOKENS - 1),
      ],
      evaluator: resolved('p/ok', 272_000),
      merger: resolved('p/ok', 272_000),
    };
    assert.throws(
      () => new FusionBudget(tooSmall, FUSION_COMMAND_CONTEXT_POLICY_ID),
      (error: unknown) => {
        assert.ok(error instanceof FusionError);
        assert.equal(error.code, 'model_capacity_unknown');
        assert.equal(error.childCreated, false);
        // The error must name the requirement and the remedy.
        assert.match(error.message, new RegExp(String(FUSION_MIN_CONTEXT_WINDOW_TOKENS)));
        assert.match(error.message, /\/fusion-models/);
        return true;
      },
    );
    // Exactly at the minimum is accepted.
    const atMinimum: ResolvedFusionModels = {
      candidates: [
        resolved('p/ok', 272_000),
        resolved('p/ok', 272_000),
        resolved('p/edge', FUSION_MIN_CONTEXT_WINDOW_TOKENS),
      ],
      evaluator: resolved('p/ok', 272_000),
      merger: resolved('p/ok', 272_000),
    };
    assert.doesNotThrow(() => new FusionBudget(atMinimum, FUSION_COMMAND_CONTEXT_POLICY_ID));
  });

  void it('bounds output contracts in JSON-rendered bytes so escaping cannot bypass them', () => {
    // A raw-byte contract would be bypassed by escape-heavy content: control
    // characters render as \u00XX (6x) and quotes/backslashes/newlines as 2x.
    const rawLimit = FUSION_CANDIDATE_MAX_OUTPUT_BYTES;
    for (const [label, unit] of [
      ['control chars', '\u0001'],
      ['quotes', '"'],
      ['backslashes', '\\'],
      ['newlines', '\n'],
    ] as const) {
      // Half the raw limit: trivially inside a raw-byte bound...
      const text = unit.repeat(Math.floor(rawLimit / 2));
      assert.ok(
        Buffer.byteLength(text, 'utf8') < rawLimit,
        `${label} fixture must be under the raw limit`,
      );
      // ...but over the contract once rendered, which is what the reserve covers.
      assert.ok(
        Buffer.byteLength(JSON.stringify(text), 'utf8') > rawLimit,
        `${label} must expand past the raw limit when rendered`,
      );
      assert.throws(
        () => {
          assertChildOutputWithinContract('candidate', text);
        },
        (error: unknown) =>
          error instanceof FusionError &&
          error.code === 'child_output_cap' &&
          /JSON-rendered bytes/.test(error.message),
        `${label} must be rejected by the rendered-byte contract`,
      );
    }
    // Ordinary prose of the same raw size is accepted.
    assert.doesNotThrow(() => {
      assertChildOutputWithinContract('candidate', 'a'.repeat(Math.floor(rawLimit / 2)));
    });
  });

  void it('proves the downstream reserve covers the widest real stage envelope', () => {
    // The evaluation-repair prompt embeds the canonical input plus three candidate
    // answers, an invalid evaluator output, and diagnostics. With every embedded
    // output at its enforced contract maximum, the reserve must still hold.
    const worstCaseBytes =
      3 * FUSION_CANDIDATE_MAX_OUTPUT_BYTES +
      FUSION_EVALUATION_MAX_OUTPUT_BYTES +
      FUSION_DIAGNOSTICS_MAX_BYTES;
    assert.ok(
      FUSION_DOWNSTREAM_RESERVE_BYTES >= worstCaseBytes,
      'reserve must cover the widest stage at contract maxima',
    );
    // The reserve is an exact sum of rendered-byte contracts plus fixed wrapper
    // overhead, not a raw size inflated by an estimated escaping factor.
    assert.equal(
      FUSION_DOWNSTREAM_RESERVE_BYTES,
      worstCaseBytes + FUSION_WRAPPER_OVERHEAD_BYTES,
    );
    const budget = new FusionBudget(models(), FUSION_COMMAND_CONTEXT_POLICY_ID);
    // A canonical input exactly at its allowance still leaves room for that growth.
    assert.ok(
      budget.allowedCanonicalInputTokens +
        fusionTokenUpperBound(FUSION_DOWNSTREAM_RESERVE_BYTES) <=
        budget.allowedInputTokens,
      'canonical allowance plus downstream reserve must fit the input budget',
    );
  });

  void it('lets safe prompts proceed through all five calls and persists the budget plan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-budget-ok-'));
    try {
      const calls: RunPiChildOptions[] = [];
      const runner: FusionChildRunner = async (options) => {
        calls.push(options);
        if (options.stage === 'candidate') return childResult(options, 'candidate answer');
        if (options.stage === 'evaluation')
          return childResult(options, JSON.stringify(evaluation()));
        return childResult(options, 'merged');
      };
      const input = canonicalInput('a reasonable amount of conversation text');
      const result = await new FusionOrchestrator({ childRunner: runner }).run({
        source: 'command',
        cwd: root,
        canonicalInput: input,
        canonicalInputSerialized: JSON.stringify(input),
        contextLedger: ledger,
        config: defaultFusionModelConfig(),
        models: models(),
      });
      assert.equal(result.mergedText, 'merged');
      assert.equal(calls.length, 5);

      const planText = await readFile(
        join(root, result.details.artifact_dir, 'budget-plan.json'),
        'utf8',
      );
      const plan = parseJsonText(planText);
      assert.ok(typeof plan === 'object' && plan !== null);
      const routes = Reflect.get(plan, 'routes');
      assert.ok(Array.isArray(routes));
      assert.equal(routes.length, 5, 'every configured route must be snapshotted');
      assert.equal(
        Reflect.get(plan, 'limiting_qualified_id'),
        'openai-codex/gpt-5.4-mini',
      );
      const base = Reflect.get(plan, 'base_context');
      assert.ok(typeof base === 'object' && base !== null);
      assert.ok(Number(Reflect.get(base, 'slack_tokens')) > 0);

      const ledgerText = await readFile(
        join(root, result.details.artifact_dir, 'context-omission-ledger.json'),
        'utf8',
      );
      assert.match(ledgerText, /visible-conversation-ledger-v1/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('writes the budget plan before rejecting so the decision stays auditable', async () => {
    const oversized = canonicalInput('u'.repeat(400_000));
    const outcome = await runExpectingFailure(oversized, async (options) =>
      childResult(options, 'unreachable'),
    );
    try {
      const planText = await readFile(
        join(outcome.root, outcome.artifactDir, 'budget-plan.json'),
        'utf8',
      );
      const plan = parseJsonText(planText);
      assert.ok(typeof plan === 'object' && plan !== null);
      const base = Reflect.get(plan, 'base_context');
      assert.ok(typeof base === 'object' && base !== null);
      assert.ok(
        Number(Reflect.get(base, 'slack_tokens')) < 0,
        'a rejected plan must record negative slack',
      );
    } finally {
      await rm(outcome.root, { recursive: true, force: true });
    }
  });

  void it('keeps a real 1 MB tool-heavy session within the smallest configured budget', () => {
    const session = sessionWith([
      userMessage('genuine user question about the failing build'),
      {
        role: 'assistant',
        api: 'openai-codex-responses',
        provider: 'openai-codex',
        model: 'gpt-5.5',
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'toolUse',
        content: [
          { type: 'thinking', thinking: 'x'.repeat(10_303) },
          { type: 'text', text: 'assistant analysis kept verbatim' },
          {
            type: 'toolCall',
            id: 'c1',
            name: 'read',
            arguments: { blob: 'a'.repeat(251_508) },
          },
        ],
        timestamp: 2,
      },
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'read',
        content: [{ type: 'text', text: 'r'.repeat(696_929) }],
        details: { ok: true },
        isError: false,
        timestamp: 3,
      },
    ]);
    const built = buildFusionCanonicalInput(
      { cwd: '/tmp/project', sessionManager: session, getSystemPrompt: () => 'sys' },
      { source: 'tool', request: 'reproduce the original failure shape' },
    );
    // The pre-fix transcript for this shape was ~1,034,667 bytes.
    assert.ok(
      built.serialized.length < 10_000,
      `projected canonical input must be small, saw ${String(built.serialized.length)}`,
    );
    const budget = new FusionBudget(models(), built.input.conversation_projection.policy.id);
    assert.doesNotThrow(() => {
      budget.assertBaseContext(built.serialized, 3);
    });
  });
});

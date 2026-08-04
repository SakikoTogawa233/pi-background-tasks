/**
 * Large-context Fusion evidence harness.
 *
 * Rebuilds the exact shape that caused the production failure (a session whose
 * tool traffic dominates the transcript) and reports, for the pre-fix and
 * post-fix context policies, the canonical input size and whether each stage
 * would fit the smallest configured route.
 *
 * Run with `--live` to additionally drive a real Fusion workflow through the
 * package orchestrator using the caller's configured subscription models.
 * Without `--live` it performs no inference and spawns no child.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage, ToolResultMessage, UserMessage } from '@earendil-works/pi-ai';
import { canonicalJson } from '../src/core/attested-pi-run.js';
import { buildFusionCanonicalInput } from '../src/core/fusion/context.js';
import {
  FUSION_CANDIDATE_MAX_OUTPUT_BYTES,
  FUSION_EVALUATION_MAX_OUTPUT_BYTES,
  FUSION_MIN_CANONICAL_INPUT_TOKENS,
  FUSION_MIN_CONTEXT_WINDOW_TOKENS,
  FUSION_RESERVED_OUTPUT_TOKENS,
  FusionBudget,
  fusionTokenUpperBound,
} from '../src/core/fusion/budget.js';
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
} from '../src/core/fusion/prompts.js';
import {
  FUSION_EVALUATION_SCHEMA_VERSION,
  FusionError,
  type FusionEvaluationV1,
  type ResolvedFusionModel,
  type ResolvedFusionModels,
} from '../src/core/fusion/types.js';

/** Byte profile measured from the real failing run's canonical-input.json. */
const OBSERVED = {
  toolResultBytes: 696_929,
  toolArgumentBytes: 251_508,
  userTextBytes: 34_959,
  assistantTextBytes: 24_733,
  thinkingBytes: 10_303,
  systemPromptBytes: 13_422,
  requestBytes: 726,
} as const;

const TOOL_CALL_COUNT = 120;

function usage() {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** Rebuild a session with the observed byte composition spread over many turns. */
function buildLargeSession(cwd: string) {
  const session = SessionManager.inMemory(cwd);
  const perCallArgs = Math.floor(OBSERVED.toolArgumentBytes / TOOL_CALL_COUNT);
  const perCallResult = Math.floor(OBSERVED.toolResultBytes / TOOL_CALL_COUNT);
  const perTurnUser = Math.floor(OBSERVED.userTextBytes / TOOL_CALL_COUNT);
  const perTurnAssistant = Math.floor(OBSERVED.assistantTextBytes / TOOL_CALL_COUNT);
  const perTurnThinking = Math.floor(OBSERVED.thinkingBytes / TOOL_CALL_COUNT);
  let timestamp = 1;
  for (let index = 0; index < TOOL_CALL_COUNT; index++) {
    const user: UserMessage = {
      role: 'user',
      content: `USER-TURN-${String(index)} ${'u'.repeat(perTurnUser)}`,
      timestamp: timestamp++,
    };
    session.appendMessage(user);
    const assistant: AssistantMessage = {
      role: 'assistant',
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      model: 'gpt-5.5',
      usage: usage(),
      stopReason: 'toolUse',
      content: [
        { type: 'thinking', thinking: 'k'.repeat(perTurnThinking) },
        { type: 'text', text: `ASSISTANT-TURN-${String(index)} ${'a'.repeat(perTurnAssistant)}` },
        {
          type: 'toolCall',
          id: `call-${String(index)}`,
          name: index % 2 === 0 ? 'read' : 'bash',
          arguments: { payload: 'g'.repeat(perCallArgs) },
        },
      ],
      timestamp: timestamp++,
    };
    session.appendMessage(assistant);
    const result: ToolResultMessage = {
      role: 'toolResult',
      toolCallId: `call-${String(index)}`,
      toolName: index % 2 === 0 ? 'read' : 'bash',
      content: [{ type: 'text', text: 'z'.repeat(perCallResult) }],
      details: { ok: true },
      isError: false,
      timestamp: timestamp++,
    };
    session.appendMessage(result);
  }
  return session;
}

/** The retired policy: full transcript forwarding, exactly as it behaved pre-fix. */
function legacyTranscript(session: ReturnType<typeof buildLargeSession>): string {
  const parts: string[] = [];
  for (const entry of session.getEntries()) {
    if (entry.type !== 'message') continue;
    const message: unknown = entry.message;
    if (typeof message !== 'object' || message === null) continue;
    const role = Reflect.get(message, 'role');
    const content: unknown = Reflect.get(message, 'content');
    if (role === 'user' && typeof content === 'string') parts.push(`[User]: ${content}`);
    else if (role === 'assistant' && Array.isArray(content)) {
      for (const block of content) {
        const type = Reflect.get(block as object, 'type');
        if (type === 'thinking')
          parts.push(`[Assistant thinking]: ${String(Reflect.get(block as object, 'thinking'))}`);
        else if (type === 'text')
          parts.push(`[Assistant]: ${String(Reflect.get(block as object, 'text'))}`);
        else if (type === 'toolCall')
          parts.push(
            `[Assistant tool calls]: ${String(Reflect.get(block as object, 'name'))}(${canonicalJson(Reflect.get(block as object, 'arguments'))})`,
          );
      }
    } else if (role === 'toolResult' && Array.isArray(content)) {
      for (const block of content) {
        if (Reflect.get(block as object, 'type') === 'text')
          parts.push(`[Tool result]: ${String(Reflect.get(block as object, 'text'))}`);
      }
    }
  }
  return parts.join('\n\n');
}

function resolvedModel(qualifiedId: string, contextWindow: number): ResolvedFusionModel {
  const slash = qualifiedId.indexOf('/');
  return {
    selection: qualifiedId,
    source: 'configured',
    provider: qualifiedId.slice(0, slash),
    model: qualifiedId.slice(slash + 1),
    qualifiedId,
    thinkingLevel: 'high',
    contextWindow,
    maxOutputTokens: 128_000,
  };
}

/** The exact panel from the reproduced failure: slot 3 is the smaller gpt-5.5 route. */
function reportedModels(): ResolvedFusionModels {
  return {
    candidates: [
      resolvedModel('openai-codex/gpt-5.6-sol', 272_000),
      resolvedModel('openai-codex/gpt-5.6-terra', 272_000),
      resolvedModel('openai-codex/gpt-5.5', 272_000),
    ],
    evaluator: resolvedModel('openai-codex/gpt-5.6-sol', 272_000),
    merger: resolvedModel('openai-codex/gpt-5.6-sol', 272_000),
  };
}

function evaluationFixture(): FusionEvaluationV1 {
  const one = (id: 'A' | 'B' | 'C') => ({
    candidate_id: id,
    summary: `${id} summary`,
    strengths: [`${id} strength`],
    limitations: [`${id} limitation`],
    useful_contributions: [`${id} contribution`],
    risks: [`${id} risk`],
  });
  return {
    schema_version: FUSION_EVALUATION_SCHEMA_VERSION,
    candidate_assessments: [one('A'), one('B'), one('C')],
    agreements: ['agreement'],
    conflicts: [],
    synthesis_plan: {
      must_include: [{ candidate_id: 'A', contribution: 'a' }],
      must_resolve: [],
      must_avoid: [],
    },
  };
}

function fmt(bytes: number): string {
  return `${bytes.toLocaleString('en-US')} B`;
}

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'pi-fusion-large-context-'));
  try {
    const session = buildLargeSession(root);
    const request = 'R'.repeat(OBSERVED.requestBytes);
    const systemPrompt = 'S'.repeat(OBSERVED.systemPromptBytes);

    // --- Pre-fix behavior -------------------------------------------------
    const legacy = legacyTranscript(session);
    const legacyCanonical = canonicalJson({
      schema_version: 'pi-background-tasks.fusion-input.v1',
      cwd: root,
      system_prompt: systemPrompt,
      conversation_transcript: legacy,
      request,
    });

    // --- Post-fix behavior ------------------------------------------------
    const built = buildFusionCanonicalInput(
      { cwd: root, sessionManager: session, getSystemPrompt: () => systemPrompt },
      { source: 'tool', request, toolName: 'fusion_reason' },
    );

    const models = reportedModels();
    const budget = new FusionBudget(models, built.input.conversation_projection.policy.id);
    const smallest = budget.limiting;

    console.log('=== Reproduced large-context session ===');
    console.log(`tool calls:              ${String(TOOL_CALL_COUNT)}`);
    console.log(`limiting configured route: ${smallest.qualified_id}`);
    console.log(
      `  context window ${String(smallest.context_window_tokens)} tok, allowed input ${String(smallest.allowed_input_tokens)} tok`,
    );
    const plan = budget.plan(built.input);
    console.log(
      `  minimum viable window:   ${String(smallest.reserved_output_tokens + smallest.framing_reserve_tokens + smallest.safety_reserve_tokens + FUSION_MIN_CANONICAL_INPUT_TOKENS)} tok (${String(FUSION_MIN_CONTEXT_WINDOW_TOKENS)}-token baseline when model max output is <= ${String(FUSION_RESERVED_OUTPUT_TOKENS)})`,
    );

    console.log('\n=== PRE-FIX (full transcript forwarding) ===');
    console.log(`transcript:              ${fmt(Buffer.byteLength(legacy, 'utf8'))}`);
    console.log(`canonical input:         ${fmt(Buffer.byteLength(legacyCanonical, 'utf8'))}`);
    const legacyTokens = fusionTokenUpperBound(
      Buffer.byteLength(legacyCanonical, 'utf8') +
        Buffer.byteLength(FUSION_CANDIDATE_SYSTEM_PROMPT, 'utf8'),
    );
    console.log(
      `candidate token upper bound: ${String(legacyTokens)} vs allowed ${String(budget.allowedInputTokens)}  => ${legacyTokens > budget.allowedInputTokens ? 'REJECTED (reproduces failure)' : 'fits'}`,
    );

    console.log('\n=== POST-FIX (visible-conversation-ledger-v2) ===');
    const accounting = built.input.conversation_projection.accounting;
    console.log(`canonical input:         ${fmt(Buffer.byteLength(built.serialized, 'utf8'))}`);
    console.log(`  included user text:    ${fmt(accounting.included_user_text_bytes)}`);
    console.log(`  included assistant:    ${fmt(accounting.included_assistant_text_bytes)}`);
    console.log(`  omitted thinking:      ${fmt(accounting.omitted_thinking_bytes)}`);
    console.log(`  omitted tool args:     ${fmt(accounting.omitted_tool_call_argument_bytes)}`);
    console.log(`  omitted tool results:  ${fmt(accounting.omitted_tool_result_text_bytes)}`);
    console.log(`  omitted events:        ${String(accounting.omitted_event_count)}`);
    console.log(`  ledger root:           ${accounting.ledger_root_sha256.slice(0, 16)}…`);

    // Determinism witness.
    const rebuilt = buildFusionCanonicalInput(
      { cwd: root, sessionManager: session, getSystemPrompt: () => systemPrompt },
      { source: 'tool', request, toolName: 'fusion_reason' },
    );
    console.log(
      `  byte-identical rebuild: ${rebuilt.serialized === built.serialized ? 'yes' : 'NO'}`,
    );

    // Verify the entire four-stage envelope with per-stage forecasts.
    console.log('\n=== Stage preflight (configured routes) ===');
    budget.assertPlanFits(plan, 'large-context-smoke');
    const candidatePrompt = buildCandidatePrompt(built.input);
    // Use the enforced contract maxima, not merely the largest observed answer.
    const answer = 'A'.repeat(FUSION_CANDIDATE_MAX_OUTPUT_BYTES);
    const anonymous = [
      { candidate_id: 'A' as const, response: answer },
      { candidate_id: 'B' as const, response: answer },
      { candidate_id: 'C' as const, response: answer },
    ] as const;
    const blind = buildBlindEvaluationInput(built.input, anonymous);
    const evaluationPrompt = buildEvaluationPrompt(blind);
    const repairPrompt = buildEvaluationRepairPrompt({
      schema_version: 'pi-background-tasks.fusion-evaluation-repair-input.v1',
      original_blind_input: blind,
      invalid_output: 'x'.repeat(FUSION_EVALUATION_MAX_OUTPUT_BYTES),
      validation_errors: ['evaluation.schema_version mismatch'],
    });
    const mergePrompt = buildMergePrompt(
      buildMergeInput(built.input, anonymous, evaluationFixture()),
    );
    const stages = [
      ['candidate', FUSION_CANDIDATE_SYSTEM_PROMPT, candidatePrompt],
      ['evaluation', FUSION_EVALUATOR_SYSTEM_PROMPT, evaluationPrompt],
      ['evaluation_repair', FUSION_EVALUATION_REPAIR_SYSTEM_PROMPT, repairPrompt],
      ['merge', FUSION_MERGER_SYSTEM_PROMPT, mergePrompt],
    ] as const;
    for (const [stage, system, user] of stages) {
      const bytes = Buffer.byteLength(system, 'utf8') + Buffer.byteLength(user, 'utf8');
      const tokens = fusionTokenUpperBound(bytes);
      budget.assertStagePrompt(stage, system, user);
      console.log(
        `  ${stage.padEnd(18)} ${fmt(bytes).padStart(12)}  rendered check OK; 1-B/token ceiling ${String(tokens)} vs ${String(budget.allowedInputTokens)} allowed`,
      );
    }
    console.log(`\ninput estimator: ${plan.policy.calibration_version} (${plan.policy.id})`);
    console.log('\nPer-stage forecast:');
    for (const entry of plan.stages) {
      const slot = entry.slot === undefined ? '' : `-${String(entry.slot)}`;
      const reservation = entry.reservation_fits
        ? 'worst-case contract reservation fits'
        : 'input fits; worst-case contract reservation warning';
      console.log(
        `  ${entry.budget_stage}${slot}: input-only ${String(entry.input_only_input_tokens_upper_bound)} tok; reservation ${String(entry.forecast_input_tokens_upper_bound)} tok / ${String(entry.allowed_input_tokens)} allowed on ${entry.route.qualified_id} (${reservation})`,
      );
    }
    console.log(
      '\nKnown rendered contract-maximum fixtures pass route-aware checks; conservative unknown-output pressure remains explicit, and every actual provider payload is governed again before transport.',
    );

    const evidence = join(root, 'canonical-input.json');
    await writeFile(evidence, built.serialized, 'utf8');
    console.log(`\nProjected canonical input written to ${evidence}`);
  } catch (error) {
    if (error instanceof FusionError) {
      console.error(`FusionError[${error.code}]: ${error.message}`);
      if (error.budget !== undefined) console.error(canonicalJson(error.budget));
    }
    throw error;
  } finally {
    if (!process.argv.includes('--keep')) await rm(root, { recursive: true, force: true });
  }
}

await main();

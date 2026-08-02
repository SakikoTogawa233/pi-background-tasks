import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseJsonText } from '../../src/core/common.js';
import { FusionOrchestrator } from '../../src/core/fusion/orchestrator.js';
import { defaultFusionModelConfig } from '../../src/core/fusion/config.js';
import {
  FUSION_VALIDATE_CANDIDATE_SYSTEM_PROMPT,
  FUSION_VALIDATE_EVALUATOR_SYSTEM_PROMPT,
  FUSION_VALIDATE_MERGER_SYSTEM_PROMPT,
} from '../../src/core/fusion/prompts.js';
import {
  FUSION_BRAINSTORM_WORKFLOW,
  FUSION_VALIDATE_WORKFLOW,
} from '../../src/core/fusion/workflows.js';
import {
  FUSION_COMMAND_CONTEXT_POLICY_ID,
  FUSION_CONTEXT_TRANSFORM_ID,
  FUSION_EVALUATION_SCHEMA_VERSION,
  FUSION_INPUT_SCHEMA_VERSION,
  FUSION_MANIFEST_SCHEMA_VERSION,
  FUSION_RESULT_SCHEMA_VERSION,
  FUSION_VALIDATE_CAPABILITY,
  type FusionCanonicalInputV3,
  type FusionChildRunResult,
  type FusionContextOmissionLedgerV2,
  type FusionEvaluationV1,
  type ResolvedFusionModel,
  type ResolvedFusionModels,
} from '../../src/core/fusion/types.js';
import type { RunPiChildOptions } from '../../src/core/fusion/pi-child.js';
import { emptyLedger } from '../helpers/fusion-canonical.js';

const ledger: FusionContextOmissionLedgerV2 = emptyLedger(FUSION_COMMAND_CONTEXT_POLICY_ID);

function resolved(qualifiedId: string, contextWindow = 200_000): ResolvedFusionModel {
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

function models(): ResolvedFusionModels {
  return {
    candidates: [resolved('p/c1'), resolved('p/c2'), resolved('p/c3')],
    evaluator: resolved('p/eval'),
    merger: resolved('p/merge'),
  };
}

function canonicalInput(text = 'validate the extracted seam'): FusionCanonicalInputV3 {
  return {
    schema_version: FUSION_INPUT_SCHEMA_VERSION,
    cwd: '/tmp/project',
    system_prompt: 'sys',
    request: { source: 'tool', authority: 'explicit_text', text, sha256: 'b'.repeat(64) },
    conversation_projection: {
      policy: {
        id: FUSION_COMMAND_CONTEXT_POLICY_ID,
        transform: FUSION_CONTEXT_TRANSFORM_ID,
        version: 2,
        receipt_format: 'omitted_activity.v2',
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
        tool_name: 'fusion_validate',
        tool_call_id: null,
        active_tool_call_leaf_excluded: false,
      },
      entries: [],
      accounting: {
        message_count: 0,
        included_text_entry_count: 0,
        included_user_text_bytes: 0,
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
        omission_receipt_utf8_bytes: 0,
      },
    },
  };
}

function evaluation(): FusionEvaluationV1 {
  const assessment = (candidate_id: 'A' | 'B' | 'C') => ({
    candidate_id,
    summary: 's',
    strengths: ['s'],
    limitations: ['l'],
    useful_contributions: ['u'],
    risks: ['r'],
  });
  return {
    schema_version: FUSION_EVALUATION_SCHEMA_VERSION,
    candidate_assessments: [assessment('A'), assessment('B'), assessment('C')],
    agreements: ['agree'],
    conflicts: [],
    synthesis_plan: {
      must_include: [{ candidate_id: 'A', contribution: 'single-source critical finding' }],
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
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    },
    events: Buffer.from('{"schema_version":"pi-background-tasks.fusion-child-result.v2"}\n'),
    stderr: Buffer.alloc(0),
    exitCode: 0,
    signal: null,
  };
  if (options.slot !== undefined) result.slot = options.slot;
  return result;
}

function recordingRunner(calls: RunPiChildOptions[]) {
  return async (options: RunPiChildOptions): Promise<FusionChildRunResult> => {
    calls.push(options);
    if (options.stage === 'evaluation') {
      return childResult(options, JSON.stringify(evaluation()));
    }
    if (options.stage === 'merge') return childResult(options, 'merged validation report');
    return childResult(options, `report from slot ${String(options.slot)}`);
  };
}

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pi-fusion-validate-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runInput(root: string, calls: RunPiChildOptions[]) {
  return {
    orchestrator: new FusionOrchestrator({ childRunner: recordingRunner(calls) }),
    input: {
      source: 'tool' as const,
      cwd: root,
      canonicalInput: canonicalInput(),
      canonicalInputSerialized: JSON.stringify(canonicalInput()),
      contextLedger: ledger,
      config: defaultFusionModelConfig(),
      models: models(),
      profile: FUSION_VALIDATE_WORKFLOW,
    },
  };
}

void describe('fusion validate orchestration', () => {
  void it('runs five children with validate framing and inspect-only candidates', async () => {
    await withRoot(async (root) => {
      const calls: RunPiChildOptions[] = [];
      const { orchestrator, input } = runInput(root, calls);
      const result = await orchestrator.run(input);

      assert.equal(calls.length, 5);
      const candidates = calls.filter((call) => call.stage === 'candidate');
      const evaluations = calls.filter((call) => call.stage === 'evaluation');
      const merges = calls.filter((call) => call.stage === 'merge');
      assert.equal(candidates.length, 3);
      assert.equal(evaluations.length, 1);
      assert.equal(merges.length, 1);

      // Candidates always inspect; the evaluator and merger stay reasoning-only so a
      // validation run cannot grant tools to the stages that adjudicate it.
      assert.deepEqual(
        candidates.map((call) => call.capability),
        [FUSION_VALIDATE_CAPABILITY, FUSION_VALIDATE_CAPABILITY, FUSION_VALIDATE_CAPABILITY],
      );
      assert.equal(evaluations[0]?.capability, 'reason');
      assert.equal(merges[0]?.capability, 'reason');

      for (const call of candidates) {
        assert.equal(call.systemPrompt, FUSION_VALIDATE_CANDIDATE_SYSTEM_PROMPT);
        assert.notEqual(call.toolCallLogPath, undefined);
      }
      assert.equal(evaluations[0]?.systemPrompt, FUSION_VALIDATE_EVALUATOR_SYSTEM_PROMPT);
      assert.equal(merges[0]?.systemPrompt, FUSION_VALIDATE_MERGER_SYSTEM_PROMPT);
      assert.equal(evaluations[0]?.toolCallLogPath, undefined);
      assert.equal(merges[0]?.toolCallLogPath, undefined);

      assert.equal(result.mergedText, 'merged validation report');
      assert.equal(result.details.workflow, 'validate');
      assert.equal(result.details.schema_version, FUSION_RESULT_SCHEMA_VERSION);
      assert.ok(result.details.run_id.startsWith('v'));
    });
  });

  void it('persists the workflow and a v-prefixed run id in the manifest', async () => {
    await withRoot(async (root) => {
      const calls: RunPiChildOptions[] = [];
      const { orchestrator, input } = runInput(root, calls);
      const result = await orchestrator.run(input);
      const manifest = parseJsonText(
        await readFile(join(root, result.details.artifact_dir, 'manifest.json'), 'utf8'),
      ) as Record<string, unknown>;
      assert.equal(manifest['schema_version'], FUSION_MANIFEST_SCHEMA_VERSION);
      assert.equal(manifest['workflow'], 'validate');
      assert.equal(manifest['state'], 'completed');
      assert.equal(manifest['run_id'], result.details.run_id);
      assert.deepEqual(manifest['capabilities'], {
        candidate: FUSION_VALIDATE_CAPABILITY,
        evaluation: 'reason',
        merge: 'reason',
      });
      const merged = await readFile(
        join(root, result.details.artifact_dir, 'merged.md'),
        'utf8',
      );
      assert.equal(merged, 'merged validation report');
    });
  });

  void it('persists the exact validate prompt bytes handed to each child', async () => {
    await withRoot(async (root) => {
      const calls: RunPiChildOptions[] = [];
      const { orchestrator, input } = runInput(root, calls);
      const result = await orchestrator.run(input);
      const dir = join(root, result.details.artifact_dir);
      const candidatePrompt = await readFile(
        join(dir, 'candidate-1.attempt-1.prompt.txt'),
        'utf8',
      );
      const candidateCall = calls.find((call) => call.stage === 'candidate' && call.slot === 1);
      assert.equal(candidatePrompt, candidateCall?.userPrompt);
    });
  });

  void it('rejects a caller capability that contradicts the workflow before one child runs', async () => {
    await withRoot(async (root) => {
      const calls: RunPiChildOptions[] = [];
      const { orchestrator, input } = runInput(root, calls);
      await assert.rejects(
        orchestrator.run({ ...input, candidateCapability: 'reason' }),
        /always runs candidates with the inspect capability; received reason/,
      );
      // Zero children: the contradiction is resolved before the artifact store or one
      // spawn, so a downgraded validation run can never reach a provider.
      assert.equal(calls.length, 0);
    });
  });

  void it('accepts the workflow capability stated explicitly', async () => {
    await withRoot(async (root) => {
      const calls: RunPiChildOptions[] = [];
      const { orchestrator, input } = runInput(root, calls);
      const result = await orchestrator.run({
        ...input,
        candidateCapability: FUSION_VALIDATE_CAPABILITY,
      });
      assert.equal(result.details.workflow, 'validate');
      assert.equal(calls.length, 5);
    });
  });

  void it('keeps the brainstorm workflow on its own prompts and run id prefix', async () => {
    await withRoot(async (root) => {
      const calls: RunPiChildOptions[] = [];
      const { orchestrator, input } = runInput(root, calls);
      const result = await orchestrator.run({
        ...input,
        profile: FUSION_BRAINSTORM_WORKFLOW,
        candidateCapability: 'reason',
      });
      assert.equal(result.details.workflow, 'brainstorm');
      assert.ok(result.details.run_id.startsWith('f'));
      const candidates = calls.filter((call) => call.stage === 'candidate');
      for (const call of candidates) {
        assert.notEqual(call.systemPrompt, FUSION_VALIDATE_CANDIDATE_SYSTEM_PROMPT);
        assert.equal(call.capability, 'reason');
      }
    });
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { canonicalJson } from '../../src/core/attested-pi-run.js';
import { FusionOrchestrator } from '../../src/core/fusion/orchestrator.js';
import { defaultFusionModelConfig } from '../../src/core/fusion/config.js';
import { buildFusionCleanTaskCanonicalInput } from '../../src/core/fusion/clean-context.js';
import {
  FUSION_VALIDATE_CANDIDATE_SYSTEM_PROMPT,
  FUSION_VALIDATE_EVALUATOR_SYSTEM_PROMPT,
  FUSION_VALIDATE_MERGER_SYSTEM_PROMPT,
} from '../../src/core/fusion/prompts.js';
import { FUSION_VALIDATE_WORKFLOW } from '../../src/core/fusion/workflows.js';
import {
  FUSION_EVALUATION_SCHEMA_VERSION,
  FUSION_RESULT_SCHEMA_VERSION,
  FUSION_VALIDATE_CANDIDATE_SCHEMA_VERSION,
  FUSION_VALIDATE_CAPABILITY,
  type FusionChildRunResult,
  type ResolvedFusionModel,
  type ResolvedFusionModels,
} from '../../src/core/fusion/types.js';
import type { RunPiChildOptions } from '../../src/core/fusion/pi-child.js';

function resolved(qualifiedId: string): ResolvedFusionModel {
  const slash = qualifiedId.indexOf('/');
  return { selection: '$current', source: 'current', provider: qualifiedId.slice(0, slash), model: qualifiedId.slice(slash + 1), qualifiedId, thinkingLevel: 'high', contextWindow: 200_000 };
}

function models(): ResolvedFusionModels {
  return { candidates: [resolved('p/c1'), resolved('p/c2'), resolved('p/c3')], evaluator: resolved('p/eval'), merger: resolved('p/merge') };
}

function childResult(options: RunPiChildOptions, text: string): FusionChildRunResult {
  const result: FusionChildRunResult = {
    stage: options.stage,
    attempt: options.attempt,
    provider: options.model.provider,
    model: options.model.model,
    qualifiedId: options.model.qualifiedId,
    text,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 } },
    events: Buffer.from('{"schema_version":"pi-background-tasks.fusion-child-result.v2"}\n'),
    stderr: Buffer.alloc(0),
    exitCode: 0,
    signal: null,
  };
  if (options.slot !== undefined) result.slot = options.slot;
  return result;
}

function candidateReport(slot: number): string {
  return JSON.stringify({
    schema_version: FUSION_VALIDATE_CANDIDATE_SCHEMA_VERSION,
    findings: [{ severity: slot === 1 ? 'critical' : 'minor', location: `src/file-${String(slot)}.ts:1`, evidence: `evidence ${String(slot)}`, impact: `impact ${String(slot)}`, summary: `finding ${String(slot)}` }],
    verified: [`verified ${String(slot)}`],
    limitations: ['none'],
  });
}

function evaluatorText(stdin: string): string {
  const blind = JSON.parse(stdin) as { candidates: Array<{ candidate_id: 'A' | 'B' | 'C'; response: string }> };
  const findings = blind.candidates.flatMap((candidate) => {
    const report = JSON.parse(candidate.response) as { findings: Array<Record<string, unknown>> };
    return report.findings.map((finding, index) => ({ id: `${candidate.candidate_id}-F${String(index + 1).padStart(3, '0')}`, candidate_id: candidate.candidate_id, ...finding }));
  });
  return JSON.stringify({
    schema_version: FUSION_EVALUATION_SCHEMA_VERSION,
    candidate_assessments: ['A', 'B', 'C'].map((candidate_id) => ({ candidate_id, summary: 's', strengths: ['s'], limitations: ['l'], useful_contributions: ['u'], risks: ['r'] })),
    agreements: ['agree'],
    conflicts: [],
    synthesis_plan: { must_include: [{ candidate_id: 'A', contribution: 'preserve findings' }], must_resolve: [], must_avoid: [] },
    validation_accounting: { findings, decisions: findings.map((finding, index) => ({ source_id: finding.id, disposition: 'include', rationale: 'supported', group_id: `G${String(index + 1)}` })) },
  });
}

async function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'pi-fusion-validate-'));
  try { return await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}

void describe('fusion validate orchestration', () => {
  void it('uses clean input, inspect candidates, no-tool adjudicators, and deterministic validated rendering', async () => {
    await withRoot(async (root) => {
      const calls: RunPiChildOptions[] = [];
      const built = buildFusionCleanTaskCanonicalInput({ cwd: root, source: 'tool', workflow: 'validate', request: canonicalJson({ objective: 'validate', background: [], changeSummary: 'changed', scope: ['src'], acceptanceCriteria: ['works'], verification: { status: 'not_run', evidence: [], reason: 'unit' }, knownLimitations: [], exclusions: [] }) });
      const orchestrator = new FusionOrchestrator({ childRunner: async (options) => {
        calls.push(options);
        if (options.stage === 'candidate') return childResult(options, candidateReport(options.slot ?? 0));
        if (options.stage === 'evaluation') return childResult(options, evaluatorText(options.userPrompt));
        return childResult(options, 'ignored free-form merger prose');
      }});
      const result = await orchestrator.run({ source: 'tool', cwd: root, canonicalInput: built.input, canonicalInputSerialized: built.serialized, config: defaultFusionModelConfig(), models: models(), profile: FUSION_VALIDATE_WORKFLOW });

      assert.equal(calls.length, 5);
      assert.deepEqual(calls.filter((call) => call.stage === 'candidate').map((call) => call.capability), [FUSION_VALIDATE_CAPABILITY, FUSION_VALIDATE_CAPABILITY, FUSION_VALIDATE_CAPABILITY]);
      assert.deepEqual(calls.filter((call) => call.stage !== 'candidate').map((call) => call.capability), ['reason', 'reason']);
      assert.equal(calls[0]?.systemPrompt, FUSION_VALIDATE_CANDIDATE_SYSTEM_PROMPT);
      assert.equal(calls.find((call) => call.stage === 'evaluation')?.systemPrompt, FUSION_VALIDATE_EVALUATOR_SYSTEM_PROMPT);
      assert.equal(calls.find((call) => call.stage === 'merge')?.systemPrompt, FUSION_VALIDATE_MERGER_SYSTEM_PROMPT);
      assert.match(result.mergedText, /^# Validation report/);
      assert.match(result.mergedText, /Location: src\/file-/);
      assert.doesNotMatch(result.mergedText, /ignored free-form/);
      assert.equal(result.details.workflow, 'validate');
      assert.equal(result.details.schema_version, FUSION_RESULT_SCHEMA_VERSION);
      assert.equal(result.details.context.kind, 'clean_task');
    });
  });

  void it('rejects validate runs that attempt to carry a parent ledger', async () => {
    await withRoot(async (root) => {
      const built = buildFusionCleanTaskCanonicalInput({ cwd: root, source: 'tool', workflow: 'validate', request: 'validate' });
      const orchestrator = new FusionOrchestrator({ childRunner: async (options) => childResult(options, '{}') });
      await assert.rejects(() => orchestrator.run({ source: 'tool', cwd: root, canonicalInput: built.input, canonicalInputSerialized: built.serialized, contextLedger: { schema_version: 'pi-background-tasks.fusion-context-ledger.v2', policy_id: 'x', transform: 'visible-conversation-ledger-v2', entries: [], projection_map: [], root_sha256: 'a'.repeat(64) }, config: defaultFusionModelConfig(), models: models(), profile: FUSION_VALIDATE_WORKFLOW }), /clean-task fusion input must not carry/);
    });
  });
});

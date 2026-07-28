import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseJsonText } from '../../src/core/common.js';
import { FusionOrchestrator, type FusionChildRunner } from '../../src/core/fusion/orchestrator.js';
import { defaultFusionModelConfig } from '../../src/core/fusion/config.js';
import {
  FUSION_EVALUATION_SCHEMA_VERSION,
  type FusionCanonicalInputV1,
  type FusionChildRunResult,
  type FusionEvaluationV1,
  type ResolvedFusionModel,
  type ResolvedFusionModels,
} from '../../src/core/fusion/types.js';
import type { RunPiChildOptions } from '../../src/core/fusion/pi-child.js';

function resolved(qualifiedId: string): ResolvedFusionModel {
  const slash = qualifiedId.indexOf('/');
  const provider = qualifiedId.slice(0, slash);
  const model = qualifiedId.slice(slash + 1);
  return {
    selection: '$current',
    source: 'current',
    provider,
    model,
    qualifiedId,
    thinkingLevel: 'high',
    contextWindow: 1000,
  };
}

function models(): ResolvedFusionModels {
  return {
    candidates: [resolved('p/c1'), resolved('p/c2'), resolved('p/c3')],
    evaluator: resolved('p/eval'),
    merger: resolved('p/merge'),
  };
}

function canonicalInput(): FusionCanonicalInputV1 {
  return {
    schema_version: 'pi-background-tasks.fusion-input.v1',
    cwd: '/tmp/project',
    system_prompt: 'system',
    conversation_transcript: 'User: hello',
    request: 'solve',
  };
}

function evaluation(): FusionEvaluationV1 {
  return {
    schema_version: FUSION_EVALUATION_SCHEMA_VERSION,
    candidate_assessments: [
      { candidate_id: 'A', summary: 'a', strengths: ['a'], limitations: ['a'], useful_contributions: ['a'], risks: ['a'] },
      { candidate_id: 'B', summary: 'b', strengths: ['b'], limitations: ['b'], useful_contributions: ['b'], risks: ['b'] },
      { candidate_id: 'C', summary: 'c', strengths: ['c'], limitations: ['c'], useful_contributions: ['c'], risks: ['c'] },
    ],
    agreements: ['agree'],
    conflicts: [],
    synthesis_plan: { must_include: [{ candidate_id: 'A', contribution: 'a' }], must_resolve: [], must_avoid: [] },
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
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stdout: Buffer.from('{"type":"session","id":"s","cwd":"/tmp"}\n'),
    stderr: Buffer.alloc(0),
    exitCode: 0,
    signal: null,
  };
  if (options.slot !== undefined) result.slot = options.slot;
  return result;
}

function parseObject(text: string): object {
  const parsed = parseJsonText(text);
  assert.ok(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed));
  return parsed;
}

function field(record: object, key: string): unknown {
  return Reflect.get(record, key);
}

void describe('fusion orchestrator', () => {
  void it('runs parallel candidates, schema repair, and final merge', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-orchestrator-'));
    try {
      const calls: RunPiChildOptions[] = [];
      let releaseCandidates: () => void = () => undefined;
      const candidatesStarted = new Promise<void>((resolve) => {
        releaseCandidates = resolve;
      });
      const runner: FusionChildRunner = async (options) => {
        calls.push(options);
        if (options.stage === 'candidate') {
          if (calls.filter((call) => call.stage === 'candidate').length === 3) releaseCandidates();
          await candidatesStarted;
          return childResult(options, `candidate-${String(options.slot)}`);
        }
        if (options.stage === 'evaluation') {
          if (options.attempt === 1) return childResult(options, '{"not":"valid"}');
          return childResult(options, JSON.stringify(evaluation()));
        }
        assert.match(options.userPrompt, /candidate-/);
        assert.match(options.userPrompt, /synthesis_plan/);
        return childResult(options, 'merged final');
      };
      const orchestrator = new FusionOrchestrator({
        childRunner: runner,
        randomBytes: () => Buffer.from([0, 0, 0, 0]),
        now: () => new Date('2026-01-01T00:00:00.000Z'),
      });
      const canonical = canonicalInput();
      const result = await orchestrator.run({
        source: 'command',
        cwd: root,
        sessionId: 's1',
        canonicalInput: canonical,
        canonicalInputSerialized: JSON.stringify(canonical),
        config: defaultFusionModelConfig(),
        models: models(),
      });
      assert.equal(result.mergedText, 'merged final');
      assert.equal(result.details.evaluator_attempts, 2);
      assert.equal(result.details.usage.totalTokens, 12);
      assert.deepEqual(calls.slice(0, 3).map((call) => call.slot), [1, 2, 3]);
      assert.equal(calls[3]?.stage, 'evaluation');
      assert.equal(calls[4]?.attempt, 2);
      assert.equal(calls[5]?.stage, 'merge');
      assert.equal(calls.filter((call) => call.stage === 'candidate')[0]?.userPrompt, calls.filter((call) => call.stage === 'candidate')[1]?.userPrompt);
      const manifestPath = join(root, result.details.artifact_dir, 'manifest.json');
      const manifest = parseObject(await readFile(manifestPath, 'utf8'));
      assert.equal(field(manifest, 'state'), 'completed');
      const attempts = field(manifest, 'attempts');
      assert.ok(Array.isArray(attempts));
      assert.equal(attempts.length, 6);
      const map = field(manifest, 'anonymous_map');
      assert.ok(typeof map === 'object' && map !== null);
      assert.equal(field(map, 'A'), 2);
      assert.equal(field(map, 'B'), 3);
      assert.equal(field(map, 'C'), 1);
      assert.equal(await readFile(join(root, result.details.artifact_dir, 'merged.md'), 'utf8'), 'merged final');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

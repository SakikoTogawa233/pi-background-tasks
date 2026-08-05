import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseJsonText } from '../../src/core/common.js';
import { FusionArtifactStore } from '../../src/core/fusion/artifacts.js';
import { defaultFusionModelConfig } from '../../src/core/fusion/config.js';
import { readFusionCommittedResult } from '../../src/core/fusion/result-package.js';
import {
  FUSION_RESULT_SCHEMA_VERSION,
  FUSION_TOOL_CALL_LOG_SCHEMA_VERSION,
  addFusionUsage,
  cloneFusionUsage,
  createEmptyFusionUsage,
  type FusionChildRunResult,
  type FusionResultDetails,
  type ResolvedFusionModel,
  type ResolvedFusionModels,
} from '../../src/core/fusion/types.js';

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
    thinkingLevel: 'medium',
    contextWindow: 1000,
    maxOutputTokens: 128,
  };
}

function models(): ResolvedFusionModels {
  return {
    candidates: [resolved('p/a'), resolved('p/b'), resolved('p/c')],
    evaluator: resolved('p/e'),
    merger: resolved('p/m'),
  };
}

function childResult(
  stage: 'candidate' | 'evaluation' | 'merge',
  text: string,
): FusionChildRunResult {
  const result: FusionChildRunResult = {
    stage,
    attempt: 1,
    provider: 'p',
    model: 'a',
    qualifiedId: 'p/a',
    text,
    usage: {
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 3,
      cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
    },
    events: Buffer.from('{"schema_version":"pi-background-tasks.fusion-child-result.v4"}\n'),
    stderr: Buffer.from('stderr'),
    exitCode: 0,
    signal: null,
  };
  if (stage === 'candidate') result.slot = 1;
  return result;
}

function parseManifest(text: string): object {
  const parsed = parseJsonText(text);
  assert.ok(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed));
  return parsed;
}

function field(record: object, key: string): unknown {
  return Reflect.get(record, key);
}

void describe('fusion artifacts', () => {
  void it('preserves and aggregates one-hour cache writes and reasoning subsets', () => {
    const usage = {
      input: 10,
      output: 8,
      cacheRead: 6,
      cacheWrite: 4,
      cacheWrite1h: 3,
      reasoning: 5,
      totalTokens: 28,
      cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
    };
    assert.deepEqual(cloneFusionUsage(usage), usage);

    const total = createEmptyFusionUsage();
    addFusionUsage(total, usage);
    addFusionUsage(total, {
      input: 2,
      output: 3,
      cacheRead: 5,
      cacheWrite: 7,
      cacheWrite1h: 6,
      reasoning: 2,
      totalTokens: 17,
      cost: { input: 0.02, output: 0.03, cacheRead: 0.05, cacheWrite: 0.07, total: 0.17 },
    });
    assert.equal(total.cacheWrite1h, 9);
    assert.equal(total.reasoning, 7);
    assert.equal(total.cacheWrite, 11);
    assert.equal(total.output, 11);
  });

  void it('creates private run files and records child attempt artifacts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-artifacts-'));
    try {
      const store = await FusionArtifactStore.create({
        cwd: root,
        sessionId: 'session/id',
        runId: 'reason-00000000000000000000000000000000',
        source: 'command',
        config: defaultFusionModelConfig(),
        models: models(),
        capabilities: { candidate: 'inspect', evaluation: 'reason', merge: 'reason' },
        now: () => new Date('2026-01-01T00:00:00.000Z'),
      });
      // Normalize separators: the artifact dir uses native path separators, so
      // it is backslash-delimited on Windows.
      assert.match(store.artifactDir.replaceAll('\\', '/'), /^\.pi\/fusion\/session-id-/);
      const dirMode = (await stat(store.artifactDirAbs)).mode & 0o777;
      // Windows has no POSIX permission bits; NTFS ACLs are not modelled here.
      if (process.platform !== 'win32') assert.equal(dirMode, 0o700);
      await store.writeCanonicalInput('{"request":"x"}');
      await store.transition('candidates_running');
      await store.recordChildAttempt({
        result: childResult('candidate', 'answer'),
        systemPrompt: 'system prompt',
        prompt: 'prompt',
        responseKind: 'md',
      });
      const responsePath = join(store.artifactDirAbs, 'candidate-1.attempt-1.response.md');
      assert.equal(await readFile(responsePath, 'utf8'), 'answer');
      if (process.platform !== 'win32')
        assert.equal((await stat(responsePath)).mode & 0o777, 0o600);
      const manifest = parseManifest(
        await readFile(join(store.artifactDirAbs, 'manifest.json'), 'utf8'),
      );
      assert.equal(field(manifest, 'state'), 'candidates_running');
      assert.deepEqual(field(manifest, 'capabilities'), {
        candidate: 'inspect',
        evaluation: 'reason',
        merge: 'reason',
      });
      const attempts = field(manifest, 'attempts');
      assert.ok(Array.isArray(attempts));
      assert.equal(attempts.length, 1);
      const firstAttempt = attempts[0];
      assert.ok(typeof firstAttempt === 'object' && firstAttempt !== null);
      assert.equal(field(firstAttempt, 'response_path'), 'candidate-1.attempt-1.response.md');
      assert.equal(field(firstAttempt, 'tool_calls_path'), undefined);
      assert.equal(field(firstAttempt, 'tool_calls'), undefined);
      assert.equal(field(firstAttempt, 'provider'), 'p');
      assert.equal(field(firstAttempt, 'qualifiedId'), 'p/a');
      const usageRecord = field(firstAttempt, 'usage');
      assert.ok(typeof usageRecord === 'object' && usageRecord !== null);
      assert.equal(field(usageRecord, 'totalTokens'), 3);
      assert.deepEqual(field(usageRecord, 'cost'), {
        input: 0.01,
        output: 0.02,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.03,
      });
      assert.deepEqual(
        (await readdir(store.artifactDirAbs)).filter((entry) => entry.endsWith('.tmp')),
        [],
      );
      const artifacts = field(manifest, 'artifacts');
      assert.ok(typeof artifacts === 'object' && artifacts !== null);
      assert.ok(Reflect.has(artifacts, 'canonical-input.json'));
      assert.equal(Reflect.has(artifacts, 'candidate-1.attempt-1.tool-calls.jsonl'), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('records same-session output recovery without putting original text in the manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-artifacts-output-recovery-'));
    try {
      const store = await FusionArtifactStore.create({
        cwd: root,
        runId: 'reason-00000000000000000000000000000002',
        source: 'command',
        config: defaultFusionModelConfig(),
        models: models(),
      });
      const result = childResult('candidate', 'compressed answer');
      const original = 'o'.repeat(50_000);
      result.outputRecovery = {
        kind: 'same_session_compression',
        limit_bytes: 49_152,
        original_record_index: 0,
        replacement_record_index: 1,
        original_json_rendered_bytes: 50_002,
        replacement_json_rendered_bytes: 19,
        original_text_sha256: createHash('sha256').update(original).digest('hex'),
        original_text: original,
        status: 'completed',
      };
      await store.recordChildAttempt({
        result,
        systemPrompt: 'system prompt',
        prompt: 'prompt',
        responseKind: 'md',
      });
      assert.equal(
        await readFile(
          join(store.artifactDirAbs, 'candidate-1.attempt-1.response.oversized.md'),
          'utf8',
        ),
        original,
      );
      const manifest = parseManifest(
        await readFile(join(store.artifactDirAbs, 'manifest.json'), 'utf8'),
      );
      const attempts = field(manifest, 'attempts');
      assert.ok(Array.isArray(attempts));
      const attempt: unknown = attempts[0];
      assert.ok(typeof attempt === 'object' && attempt !== null);
      assert.equal(field(attempt, 'child_created'), true);
      assert.deepEqual(field(attempt, 'output_recovery'), {
        kind: 'same_session_compression',
        status: 'completed',
        limit_bytes: 49_152,
        original_response_path: 'candidate-1.attempt-1.response.oversized.md',
        original_record_index: 0,
        replacement_record_index: 1,
        original_json_rendered_bytes: 50_002,
        replacement_json_rendered_bytes: 19,
        original_text_sha256: createHash('sha256').update(original).digest('hex'),
      });
      assert.equal(JSON.stringify(manifest).includes(original), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('records completed child tool-call logs and summaries on attempts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-artifacts-tools-'));
    try {
      const store = await FusionArtifactStore.create({
        cwd: root,
        runId: 'reason-00000000000000000000000000000001',
        source: 'command',
        config: defaultFusionModelConfig(),
        models: models(),
        capabilities: { candidate: 'inspect', evaluation: 'reason', merge: 'reason' },
      });
      const result = childResult('candidate', 'answer');
      const logText =
        `${JSON.stringify({
          schema_version: FUSION_TOOL_CALL_LOG_SCHEMA_VERSION,
          ordinal: 0,
          tool_name: 'read',
          arguments_sha256: 'a'.repeat(64),
          arguments_bytes: 17,
          result_bytes: 23,
          result_sha256: 'b'.repeat(64),
          status: 'ok',
          duration_ms: 4,
        })}\n` +
        `${JSON.stringify({
          schema_version: FUSION_TOOL_CALL_LOG_SCHEMA_VERSION,
          ordinal: 1,
          tool_name: 'grep',
          arguments_sha256: 'c'.repeat(64),
          arguments_bytes: 19,
          result_bytes: 29,
          result_sha256: 'd'.repeat(64),
          status: 'error',
          duration_ms: 8,
        })}\n`;
      result.toolCallTrace = {
        bytes: Buffer.from(logText, 'utf8'),
        records: [],
        summary: { count: 2, total_result_bytes: 52, trace_complete: true },
      };
      await store.recordChildAttempt({
        result,
        systemPrompt: 'system prompt',
        prompt: 'prompt',
        responseKind: 'md',
      });
      assert.equal(
        await readFile(
          join(store.artifactDirAbs, 'candidate-1.attempt-1.tool-calls.jsonl'),
          'utf8',
        ),
        logText,
      );
      const manifest = parseManifest(
        await readFile(join(store.artifactDirAbs, 'manifest.json'), 'utf8'),
      );
      const attempts = field(manifest, 'attempts');
      assert.ok(Array.isArray(attempts));
      const firstAttempt = attempts[0];
      assert.ok(typeof firstAttempt === 'object' && firstAttempt !== null);
      assert.equal(
        field(firstAttempt, 'tool_calls_path'),
        'candidate-1.attempt-1.tool-calls.jsonl',
      );
      assert.deepEqual(field(firstAttempt, 'tool_calls'), {
        count: 2,
        total_result_bytes: 52,
        trace_complete: true,
      });
      const artifacts = field(manifest, 'artifacts');
      assert.ok(typeof artifacts === 'object' && artifacts !== null);
      assert.ok(Reflect.has(artifacts, 'candidate-1.attempt-1.tool-calls.jsonl'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('enforces lifecycle ordering and durable merge before completion', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-state-'));
    try {
      const store = await FusionArtifactStore.create({
        cwd: root,
        runId: 'reason-11111111111111111111111111111111',
        source: 'tool',
        config: defaultFusionModelConfig(),
        models: models(),
      });
      await assert.rejects(store.transition('evaluating'), /illegal fusion state transition/);
      await store.transition('candidates_running');
      await store.transition('candidates_complete');
      await store.transition('evaluating');
      await store.transition('evaluation_complete');
      await store.transition('merging');
      await assert.rejects(store.transition('completed'), /merged\.md/);
      const merged = await store.writeMerged('final');
      await assert.rejects(store.transition('completed'), /result\.json/);
      const details: FusionResultDetails = {
        schema_version: FUSION_RESULT_SCHEMA_VERSION,
        run_id: store.runId,
        workflow: 'reason',
        source: 'tool',
        status: 'completed',
        context: { kind: 'session_projection', policy_id: 'test-policy' },
        tool_policy: { candidate_tools: [], evaluation_tools: [], merge_tools: [] },
        artifact_dir: store.artifactDir,
        models: store.snapshot().models,
        evaluator_attempts: 1,
        usage: {
          input: 2,
          output: 13,
          cacheRead: 3,
          cacheWrite: 11,
          cacheWrite1h: 7,
          reasoning: 5,
          totalTokens: 29,
          cost: { input: 0.02, output: 0.13, cacheRead: 0.003, cacheWrite: 0.066, total: 0.219 },
        },
        budget: {
          policy_id: 'test-policy',
          calibration_version: 'test',
          route_table: [],
          rate_sources: [],
          unknown_provider_warnings: [],
          calibration_warnings: [],
        },
      };
      await store.writeCommittedResult(merged, details);
      await store.transition('completed');
      const manifest = parseManifest(
        await readFile(join(store.artifactDirAbs, 'manifest.json'), 'utf8'),
      );
      assert.equal(field(manifest, 'state'), 'completed');
      assert.equal(await readFile(join(store.artifactDirAbs, 'merged.md'), 'utf8'), 'final');
      const verified = await readFusionCommittedResult({
        artifactDirAbs: store.artifactDirAbs,
        artifactDir: store.artifactDir,
        runId: store.runId,
        workflow: 'reason',
      });
      assert.equal(verified.mergedText, 'final');
      assert.equal(verified.details.usage.cacheWrite1h, 7);
      assert.equal(verified.details.usage.reasoning, 5);
      await writeFile(join(store.artifactDirAbs, 'merged.md'), 'tampered', 'utf8');
      await assert.rejects(
        readFusionCommittedResult({
          artifactDirAbs: store.artifactDirAbs,
          artifactDir: store.artifactDir,
          runId: store.runId,
          workflow: 'reason',
        }),
        /does not match its committed hash and length/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  void it('writes terminal failure evidence loudly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'pi-fusion-failed-'));
    try {
      const store = await FusionArtifactStore.create({
        cwd: root,
        runId: 'reason-22222222222222222222222222222222',
        source: 'command',
        config: defaultFusionModelConfig(),
        models: models(),
      });
      await store.transition('candidates_running');
      await store.recordFailedAttempt({
        stage: 'candidate',
        slot: 2,
        attempt: 1,
        systemPrompt: 'system prompt',
        prompt: 'prompt',
        events: Buffer.from('compact-event'),
        partialResponse: Buffer.from('partial response'),
        stderr: Buffer.from('err'),
        error: 'boom',
        status: 'failed',
        childCreated: true,
        responseKind: 'md',
        provider: 'p',
        model: 'b',
        qualifiedId: 'p/b',
        usage: {
          input: 2,
          output: 3,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 5,
          cost: { input: 0.02, output: 0.03, cacheRead: 0, cacheWrite: 0, total: 0.05 },
        },
      });
      await store.writeError('failed', 'boom');
      assert.ok(existsSync(join(store.artifactDirAbs, 'error.json')));
      const manifest = parseManifest(
        await readFile(join(store.artifactDirAbs, 'manifest.json'), 'utf8'),
      );
      assert.equal(field(manifest, 'state'), 'failed');
      assert.equal(field(manifest, 'error'), 'boom');
      const attempts = field(manifest, 'attempts');
      assert.ok(Array.isArray(attempts));
      const firstAttempt: unknown = attempts[0];
      assert.ok(typeof firstAttempt === 'object' && firstAttempt !== null);
      assert.equal(field(firstAttempt, 'status'), 'failed');
      assert.equal(field(firstAttempt, 'child_created'), true);
      assert.equal(field(firstAttempt, 'response_path'), 'candidate-2.attempt-1.response.md');
      assert.equal(
        field(firstAttempt, 'partial_response_path'),
        'candidate-2.attempt-1.response.partial.md',
      );
      assert.equal(
        await readFile(join(store.artifactDirAbs, 'candidate-2.attempt-1.response.md'), 'utf8'),
        '',
      );
      assert.equal(
        await readFile(
          join(store.artifactDirAbs, 'candidate-2.attempt-1.response.partial.md'),
          'utf8',
        ),
        'partial response',
      );
      assert.equal(field(firstAttempt, 'qualifiedId'), 'p/b');
      const failedUsage = field(firstAttempt, 'usage');
      assert.ok(typeof failedUsage === 'object' && failedUsage !== null);
      assert.equal(field(failedUsage, 'totalTokens'), 5);
      assert.deepEqual(field(failedUsage, 'cost'), {
        input: 0.02,
        output: 0.03,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0.05,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

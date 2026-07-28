import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { parseJsonText } from '../common.js';
import {
  FusionArtifactStore,
  type CreateFusionArtifactStoreOptions,
  type RecordFusionFailedAttemptInput,
} from './artifacts.js';
import { boundedEvaluationErrors, validateFusionEvaluation } from './evaluation.js';
import {
  FusionChildRunError,
  runPiChild,
  type RunPiChildOptions,
} from './pi-child.js';
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
  type AnonymousFusionCandidate,
} from './prompts.js';
import {
  FUSION_RESULT_SCHEMA_VERSION,
  FusionError,
  type FusionCanonicalInputV1,
  type FusionCandidateId,
  type FusionChildRunResult,
  type FusionErrorDetails,
  type FusionEvaluationV1,
  type FusionModelConfigV1,
  type FusionProgressEvent,
  type FusionRunResult,
  type FusionSource,
  type FusionStage,
  type FusionUsage,
  type ResolvedFusionModel,
  type ResolvedFusionModels,
} from './types.js';

export type FusionChildRunner = (options: RunPiChildOptions) => Promise<FusionChildRunResult>;
export type FusionProgressSink = (event: FusionProgressEvent) => void;
export type FusionRandomBytes = (size: number) => Buffer;

type CandidateSlot = 1 | 2 | 3;

export interface FusionWorkflowInput {
  source: FusionSource;
  cwd: string;
  sessionId?: string | undefined;
  canonicalInput: FusionCanonicalInputV1;
  canonicalInputSerialized: string;
  config: FusionModelConfigV1;
  models: ResolvedFusionModels;
  signal?: AbortSignal | undefined;
  onProgress?: FusionProgressSink | undefined;
}

export interface FusionOrchestratorOptions {
  childRunner?: FusionChildRunner | undefined;
  randomBytes?: FusionRandomBytes | undefined;
  now?: () => Date;
  createArtifactStore?: ((options: CreateFusionArtifactStoreOptions) => Promise<FusionArtifactStore>) | undefined;
}

interface CandidateResult {
  slot: CandidateSlot;
  result: FusionChildRunResult;
}

interface EvaluationAttemptResult {
  result: FusionChildRunResult;
  evaluation: FusionEvaluationV1 | undefined;
  errors: readonly string[];
}

function emptyUsage(): FusionUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

function addUsage(target: FusionUsage, delta: FusionUsage): void {
  target.input += delta.input;
  target.output += delta.output;
  target.cacheRead += delta.cacheRead;
  target.cacheWrite += delta.cacheWrite;
  target.totalTokens += delta.totalTokens;
  if (delta.costTotal !== undefined) target.costTotal = (target.costTotal ?? 0) + delta.costTotal;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function asFusionError(error: unknown, artifactDir: string): FusionError {
  if (error instanceof FusionError) {
    const details: FusionErrorDetails = {
      code: error.code,
      artifactDir,
      transient: error.transient,
      childCreated: error.childCreated,
    };
    if (error.stage !== undefined) details.stage = error.stage;
    if (error.slot !== undefined) details.slot = error.slot;
    if (error.attempt !== undefined) details.attempt = error.attempt;
    return new FusionError(error.message, details);
  }
  return new FusionError(errorText(error), {
    code: 'orchestration_failed',
    artifactDir,
    childCreated: false,
  });
}

function recordFailureInput(
  error: unknown,
  stage: FusionStage,
  slot: CandidateSlot | undefined,
  attempt: number,
  prompt: string,
  responseKind: 'md' | 'txt',
): RecordFusionFailedAttemptInput {
  if (error instanceof FusionChildRunError) {
    const base: RecordFusionFailedAttemptInput = {
      stage,
      attempt,
      prompt,
      stdout: error.stdout,
      stderr: error.stderr,
      error: error.message,
      status: error.code === 'child_cancelled' ? 'cancelled' : 'failed',
      responseKind,
    };
    if (slot !== undefined) base.slot = slot;
    return base;
  }
  const base: RecordFusionFailedAttemptInput = {
    stage,
    attempt,
    prompt,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    error: errorText(error),
    status: error instanceof FusionError && error.code === 'child_cancelled' ? 'cancelled' : 'failed',
    responseKind,
  };
  if (slot !== undefined) base.slot = slot;
  return base;
}

function retryableSpawn(error: unknown, attempt: number): boolean {
  if (!(error instanceof FusionError)) return false;
  return (
    attempt === 1 &&
    error.code === 'child_spawn_failed' &&
    error.transient &&
    !error.childCreated
  );
}

function childOptions(
  input: FusionWorkflowInput,
  model: ResolvedFusionModel,
  stage: FusionStage,
  attempt: number,
  systemPrompt: string,
  userPrompt: string,
  signal: AbortSignal,
  slot?: CandidateSlot,
): RunPiChildOptions {
  const out: RunPiChildOptions = {
    stage,
    attempt,
    cwd: input.cwd,
    model,
    systemPrompt,
    userPrompt,
    signal,
  };
  if (slot !== undefined) out.slot = slot;
  return out;
}

function parseEvaluationAttempt(text: string): { evaluation: FusionEvaluationV1 | undefined; errors: readonly string[] } {
  let parsed: unknown;
  try {
    parsed = parseJsonText(text);
  } catch (error) {
    return { evaluation: undefined, errors: [`evaluation output must be JSON only: ${errorText(error)}`] };
  }
  const result = validateFusionEvaluation(parsed);
  if (result.ok) return { evaluation: result.value, errors: [] };
  return { evaluation: undefined, errors: result.errors };
}

function randomIndex(limit: number, randomBytes: FusionRandomBytes): number {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 0xffffffff) {
    throw new FusionError(`invalid random limit ${String(limit)}`, {
      code: 'orchestration_failed',
      childCreated: false,
    });
  }
  const range = 0x100000000;
  const ceiling = range - (range % limit);
  for (;;) {
    const bytes = randomBytes(4);
    if (bytes.length < 4) {
      throw new FusionError('random byte source returned too few bytes', {
        code: 'orchestration_failed',
        childCreated: false,
      });
    }
    const value = bytes.readUInt32BE(0);
    if (value < ceiling) return value % limit;
  }
}

function shuffledSlots(randomBytes: FusionRandomBytes): CandidateSlot[] {
  const slots: CandidateSlot[] = [1, 2, 3];
  for (let i = slots.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1, randomBytes);
    const left = slots[i];
    const right = slots[j];
    if (left === undefined || right === undefined) {
      throw new FusionError('random slot shuffle failed', {
        code: 'orchestration_failed',
        childCreated: false,
      });
    }
    slots[i] = right;
    slots[j] = left;
  }
  return slots;
}

function candidateBySlot(results: readonly CandidateResult[], slot: CandidateSlot): FusionChildRunResult {
  const found = results.find((candidate) => candidate.slot === slot);
  if (found === undefined) {
    throw new FusionError(`candidate slot ${String(slot)} is missing`, {
      code: 'orchestration_failed',
      childCreated: false,
    });
  }
  return found.result;
}

function candidateModel(models: ResolvedFusionModels, slot: CandidateSlot): ResolvedFusionModel {
  if (slot === 1) return models.candidates[0];
  if (slot === 2) return models.candidates[1];
  return models.candidates[2];
}

function anonymousCandidates(
  results: readonly CandidateResult[],
  slots: readonly CandidateSlot[],
): {
  map: Record<FusionCandidateId, CandidateSlot>;
  candidates: readonly [AnonymousFusionCandidate, AnonymousFusionCandidate, AnonymousFusionCandidate];
} {
  const firstSlot = slots[0];
  const secondSlot = slots[1];
  const thirdSlot = slots[2];
  if (firstSlot === undefined || secondSlot === undefined || thirdSlot === undefined) {
    throw new FusionError('anonymous candidate shuffle produced too few slots', {
      code: 'orchestration_failed',
      childCreated: false,
    });
  }
  const first = candidateBySlot(results, firstSlot);
  const second = candidateBySlot(results, secondSlot);
  const third = candidateBySlot(results, thirdSlot);
  return {
    map: { A: firstSlot, B: secondSlot, C: thirdSlot },
    candidates: [
      { candidate_id: 'A', response: first.text },
      { candidate_id: 'B', response: second.text },
      { candidate_id: 'C', response: third.text },
    ],
  };
}

export class FusionOrchestrator {
  private readonly childRunner: FusionChildRunner;
  private readonly randomBytes: FusionRandomBytes;
  private readonly now: (() => Date) | undefined;
  private readonly createArtifactStore: (options: CreateFusionArtifactStoreOptions) => Promise<FusionArtifactStore>;

  constructor(options: FusionOrchestratorOptions = {}) {
    this.childRunner = options.childRunner ?? runPiChild;
    this.randomBytes = options.randomBytes ?? nodeRandomBytes;
    this.now = options.now;
    this.createArtifactStore = options.createArtifactStore ?? FusionArtifactStore.create;
  }

  async run(input: FusionWorkflowInput): Promise<FusionRunResult> {
    const storeOptions: CreateFusionArtifactStoreOptions = {
      cwd: input.cwd,
      source: input.source,
      config: input.config,
      models: input.models,
    };
    if (input.sessionId !== undefined) storeOptions.sessionId = input.sessionId;
    if (this.now !== undefined) storeOptions.now = this.now;
    const store = await this.createArtifactStore(storeOptions);
    input.onProgress?.({ type: 'state', state: 'initializing' });
    const usage = emptyUsage();
    try {
      await store.writeCanonicalInput(input.canonicalInputSerialized);
      await store.transition('candidates_running');
      input.onProgress?.({ type: 'state', state: 'candidates_running' });
      const candidateResults = await this.runCandidates(input, store, usage);
      await store.transition('candidates_complete');
      input.onProgress?.({ type: 'state', state: 'candidates_complete' });

      const shuffled = anonymousCandidates(candidateResults, shuffledSlots(this.randomBytes));
      await store.setAnonymousMap(shuffled.map);
      const blindInput = buildBlindEvaluationInput(input.canonicalInput, shuffled.candidates);
      await store.writeBlindCandidates(buildEvaluationPrompt(blindInput));

      await store.transition('evaluating');
      input.onProgress?.({ type: 'state', state: 'evaluating' });
      const evaluation = await this.runEvaluation(input, store, usage, blindInput);
      await store.writeEvaluationJson(evaluation);
      await store.transition('evaluation_complete');
      input.onProgress?.({ type: 'state', state: 'evaluation_complete' });

      await store.transition('merging');
      input.onProgress?.({ type: 'state', state: 'merging' });
      const mergeInput = buildMergeInput(input.canonicalInput, shuffled.candidates, evaluation);
      const mergePrompt = buildMergePrompt(mergeInput);
      input.onProgress?.({ type: 'merge_started' });
      const merged = await this.runChildWithRetry(
        input,
        store,
        input.models.merger,
        'merge',
        FUSION_MERGER_SYSTEM_PROMPT,
        mergePrompt,
        input.signal ?? new AbortController().signal,
        undefined,
        'md',
      );
      addUsage(usage, merged.usage);
      await store.recordChildAttempt({ result: merged, prompt: mergePrompt, responseKind: 'md' });
      await store.writeMerged(merged.text);
      await store.setUsage(usage);
      await store.transition('completed');
      input.onProgress?.({ type: 'completed', runId: store.runId, artifactDir: store.artifactDir });
      return {
        mergedText: merged.text,
        details: {
          schema_version: FUSION_RESULT_SCHEMA_VERSION,
          run_id: store.runId,
          source: input.source,
          status: 'completed',
          artifact_dir: store.artifactDir,
          models: store.snapshot().models,
          evaluator_attempts: store.snapshot().attempts.filter((attempt) => attempt.stage === 'evaluation').length,
          usage,
        },
      };
    } catch (error) {
      const cancelled = input.signal?.aborted === true || (error instanceof FusionError && error.code === 'child_cancelled');
      const message = errorText(error);
      await store.writeError(cancelled ? 'cancelled' : 'failed', message);
      if (cancelled) {
        input.onProgress?.({ type: 'cancelled', runId: store.runId, artifactDir: store.artifactDir, reason: message });
      } else {
        input.onProgress?.({ type: 'failed', runId: store.runId, artifactDir: store.artifactDir, error: message });
      }
      throw asFusionError(error, store.artifactDir);
    }
  }

  private async runCandidates(
    input: FusionWorkflowInput,
    store: FusionArtifactStore,
    usage: FusionUsage,
  ): Promise<readonly CandidateResult[]> {
    const controller = new AbortController();
    const abortListener = () => controller.abort();
    input.signal?.addEventListener('abort', abortListener, { once: true });
    const prompt = buildCandidatePrompt(input.canonicalInput);
    let primaryError: unknown;
    let completed = 0;
    try {
      const tasks: Array<Promise<CandidateResult>> = ([1, 2, 3] as const).map((slot) => {
        const model = candidateModel(input.models, slot);
        const task = this.runChildWithRetry(
          input,
          store,
          model,
          'candidate',
          FUSION_CANDIDATE_SYSTEM_PROMPT,
          prompt,
          controller.signal,
          slot,
          'md',
        ).then(async (result) => {
          await store.recordChildAttempt({ result, prompt, responseKind: 'md' });
          completed += 1;
          addUsage(usage, result.usage);
          input.onProgress?.({ type: 'candidate_completed', slot, completed, total: 3 });
          return { slot, result };
        });
        return task.catch((error: unknown) => {
          if (primaryError === undefined) {
            primaryError = error;
            controller.abort();
          }
          throw error;
        });
      });
      const settled = await Promise.allSettled(tasks);
      if (primaryError !== undefined) throw primaryError;
      const results: CandidateResult[] = [];
      for (const item of settled) {
        if (item.status === 'fulfilled') results.push(item.value);
        else throw item.reason;
      }
      return results.sort((left, right) => left.slot - right.slot);
    } finally {
      input.signal?.removeEventListener('abort', abortListener);
    }
  }

  private async runEvaluation(
    input: FusionWorkflowInput,
    store: FusionArtifactStore,
    usage: FusionUsage,
    blindInput: Parameters<typeof buildEvaluationPrompt>[0],
  ): Promise<FusionEvaluationV1> {
    const firstPrompt = buildEvaluationPrompt(blindInput);
    const first = await this.runEvaluationAttempt(input, store, usage, firstPrompt, 1, false);
    if (first.evaluation !== undefined) return first.evaluation;
    const errors = boundedEvaluationErrors(first.errors);
    input.onProgress?.({ type: 'evaluation_retry', errors });
    const repairPrompt = buildEvaluationRepairPrompt({
      schema_version: 'pi-background-tasks.fusion-evaluation-repair-input.v1',
      original_blind_input: blindInput,
      invalid_output: first.result.text,
      validation_errors: errors,
    });
    const second = await this.runEvaluationAttempt(input, store, usage, repairPrompt, 2, true);
    if (second.evaluation !== undefined) return second.evaluation;
    throw new FusionError(`evaluation schema repair failed: ${second.errors.join('; ')}`, {
      code: 'evaluation_invalid',
      stage: 'evaluation',
      attempt: 2,
    });
  }

  private async runEvaluationAttempt(
    input: FusionWorkflowInput,
    store: FusionArtifactStore,
    usage: FusionUsage,
    prompt: string,
    attempt: 1 | 2,
    repair: boolean,
  ): Promise<EvaluationAttemptResult> {
    input.onProgress?.({ type: 'evaluation_started', attempt, repair });
    const systemPrompt = repair ? FUSION_EVALUATION_REPAIR_SYSTEM_PROMPT : FUSION_EVALUATOR_SYSTEM_PROMPT;
    const result = await this.runChildWithRetry(
      input,
      store,
      input.models.evaluator,
      'evaluation',
      systemPrompt,
      prompt,
      input.signal ?? new AbortController().signal,
      undefined,
      'txt',
      attempt,
    );
    addUsage(usage, result.usage);
    await store.recordChildAttempt({ result, prompt, responseKind: 'txt' });
    const parsed = parseEvaluationAttempt(result.text);
    return { result, evaluation: parsed.evaluation, errors: parsed.errors };
  }

  private async runChildWithRetry(
    input: FusionWorkflowInput,
    store: FusionArtifactStore,
    model: ResolvedFusionModel,
    stage: FusionStage,
    systemPrompt: string,
    userPrompt: string,
    signal: AbortSignal,
    slot: CandidateSlot | undefined,
    responseKind: 'md' | 'txt',
    fixedAttempt?: 1 | 2,
  ): Promise<FusionChildRunResult> {
    const logicalAttempt = fixedAttempt ?? 1;
    for (let launchTry = 1; launchTry <= 2; launchTry++) {
      if (stage === 'candidate' && slot !== undefined) {
        input.onProgress?.({ type: 'candidate_started', slot, attempt: logicalAttempt });
      }
      try {
        return await this.childRunner(
          childOptions(input, model, stage, logicalAttempt, systemPrompt, userPrompt, signal, slot),
        );
      } catch (error) {
        if (!signal.aborted && retryableSpawn(error, launchTry) && launchTry === 1) continue;
        await store.recordFailedAttempt(
          recordFailureInput(error, stage, slot, logicalAttempt, userPrompt, responseKind),
        );
        throw error;
      }
    }
    const details: FusionErrorDetails = {
      code: 'orchestration_failed',
      stage,
      childCreated: false,
    };
    if (slot !== undefined) details.slot = slot;
    throw new FusionError(`${stage} child did not produce a result`, details);
  }
}

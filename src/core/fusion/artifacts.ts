import { randomBytes } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import { canonicalJson, sha256Buffer } from '../attested-pi-run.js';
import { sanitizePathSegment } from '../common.js';
import { replaceFileDurable } from '../durable-fs.js';
import {
  EMPTY_FUSION_USAGE,
  FUSION_MANIFEST_SCHEMA_VERSION,
  FusionError,
  cloneFusionUsage,
  type FusionArtifactManifest,
  type FusionArtifactRef,
  type FusionAttemptArtifactRecord,
  type FusionBudgetPlanV1,
  type FusionCalibrationViolation,
  type FusionCandidateId,
  type FusionCapability,
  type FusionContextOmissionLedgerV2,
  type FusionChildRunResult,
  type FusionModelConfigV1,
  type FusionSource,
  type FusionStage,
  type FusionState,
  type FusionTerminalState,
  type FusionUsage,
  type FusionWorkflowId,
  type ResolvedFusionModels,
} from './types.js';
import { FUSION_BRAINSTORM_WORKFLOW, type FusionWorkflowProfile } from './workflows.js';

/**
 * Run ids are prefixed by workflow so an artifact directory is self-describing.
 * The prefix set is closed: an unknown prefix must fail rather than be accepted.
 */
const RUN_ID_PATTERN = /^[fv][0-9a-f]{32}$/;

interface MutableFusionArtifactManifest {
  schema_version: typeof FUSION_MANIFEST_SCHEMA_VERSION;
  run_id: string;
  workflow: FusionWorkflowId;
  source: FusionSource;
  state: FusionState;
  created_at: string;
  updated_at: string;
  cwd: string;
  config: FusionModelConfigV1;
  models: {
    candidates: [string, string, string];
    evaluator: string;
    merger: string;
    thinking_level: string;
  };
  capabilities: {
    candidate: FusionCapability;
    evaluation: FusionCapability;
    merge: FusionCapability;
  };
  usage: FusionUsage;
  attempts: FusionAttemptArtifactRecord[];
  artifacts: Record<string, FusionArtifactRef>;
  anonymous_map?: Record<FusionCandidateId, 1 | 2 | 3>;
  error?: string;
}

export interface CreateFusionArtifactStoreOptions {
  cwd: string;
  sessionId?: string | undefined;
  runId?: string | undefined;
  profile?: FusionWorkflowProfile | undefined;
  source: FusionSource;
  config: FusionModelConfigV1;
  models: ResolvedFusionModels;
  capabilities?: {
    candidate: FusionCapability;
    evaluation: FusionCapability;
    merge: FusionCapability;
  };
  now?: () => Date;
}

export interface RecordFusionChildAttemptInput {
  result: FusionChildRunResult;
  prompt: string;
  responseKind: 'md' | 'txt';
}

export interface RecordFusionFailedAttemptInput {
  stage: FusionStage;
  slot?: 1 | 2 | 3;
  attempt: number;
  prompt: string;
  events: Buffer;
  partialResponse: Buffer;
  stderr: Buffer;
  error: string;
  status: 'failed' | 'cancelled';
  responseKind: 'md' | 'txt';
  provider?: string;
  model?: string;
  qualifiedId?: string;
  usage?: FusionUsage;
}

function makeRunId(profile: FusionWorkflowProfile): string {
  return `${profile.runIdPrefix}${randomBytes(16).toString('hex')}`;
}

function modelsForManifest(models: ResolvedFusionModels): MutableFusionArtifactManifest['models'] {
  const first = models.candidates[0].qualifiedId;
  const second = models.candidates[1].qualifiedId;
  const third = models.candidates[2].qualifiedId;
  return {
    candidates: [first, second, third],
    evaluator: models.evaluator.qualifiedId,
    merger: models.merger.qualifiedId,
    thinking_level: models.evaluator.thinkingLevel,
  };
}

function terminalStates(): ReadonlySet<FusionState> {
  return new Set<FusionState>(['completed', 'failed', 'cancelled']);
}

const TERMINAL_STATES = terminalStates();

const NEXT_STATES: Readonly<Record<FusionState, readonly FusionState[]>> = {
  initializing: ['candidates_running', 'failed', 'cancelled'],
  candidates_running: ['candidates_complete', 'failed', 'cancelled'],
  candidates_complete: ['evaluating', 'failed', 'cancelled'],
  evaluating: ['evaluation_complete', 'failed', 'cancelled'],
  evaluation_complete: ['merging', 'failed', 'cancelled'],
  merging: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

function canTransition(from: FusionState, to: FusionState): boolean {
  return NEXT_STATES[from].includes(to);
}

function pathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return (
    rel === '' || (!rel.startsWith('..') && !isAbsolute(rel) && !rel.split(sep).includes('..'))
  );
}

function errorForArtifact(message: string): FusionError {
  return new FusionError(message, { code: 'artifact_error', childCreated: false });
}

async function writePrivateFile(
  absPath: string,
  data: Buffer | string,
): Promise<FusionArtifactRef> {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  await replaceFileDurable(absPath, data);
  return { path: basename(absPath), byte_length: bytes.length, sha256: sha256Buffer(bytes) };
}

async function writeJsonAtomic(absPath: string, value: unknown): Promise<FusionArtifactRef> {
  return writePrivateFile(absPath, `${JSON.stringify(value, null, 2)}\n`);
}

function publicManifest(manifest: MutableFusionArtifactManifest): FusionArtifactManifest {
  const out: FusionArtifactManifest = {
    schema_version: manifest.schema_version,
    run_id: manifest.run_id,
    workflow: manifest.workflow,
    source: manifest.source,
    state: manifest.state,
    created_at: manifest.created_at,
    updated_at: manifest.updated_at,
    cwd: manifest.cwd,
    config: manifest.config,
    models: manifest.models,
    capabilities: manifest.capabilities,
    usage: cloneFusionUsage(manifest.usage),
    attempts: [...manifest.attempts],
    artifacts: { ...manifest.artifacts },
  };
  if (manifest.anonymous_map !== undefined) out.anonymous_map = { ...manifest.anonymous_map };
  if (manifest.error !== undefined) out.error = manifest.error;
  return out;
}

function attemptPrefix(stage: FusionStage, slot: 1 | 2 | 3 | undefined, attempt: number): string {
  if (stage === 'candidate') {
    if (slot === undefined) throw errorForArtifact('candidate attempt requires slot');
    return `candidate-${String(slot)}.attempt-${String(attempt)}`;
  }
  if (slot !== undefined)
    throw errorForArtifact(`${stage} attempt must not include candidate slot`);
  return `${stage === 'evaluation' ? 'evaluation' : 'merge'}.attempt-${String(attempt)}`;
}

function responseName(prefix: string, kind: 'md' | 'txt'): string {
  return `${prefix}.response.${kind}`;
}

function calibrationViolationName(prefix: string): string {
  return `${prefix}.calibration-violation.json`;
}

export class FusionArtifactStore {
  private readonly runDirAbs: string;
  private readonly runDirDisplay: string;
  private readonly now: () => Date;
  private manifest: MutableFusionArtifactManifest;
  private manifestWriteChain: Promise<void> = Promise.resolve();

  private constructor(
    runDirAbs: string,
    runDirDisplay: string,
    now: () => Date,
    manifest: MutableFusionArtifactManifest,
  ) {
    this.runDirAbs = runDirAbs;
    this.runDirDisplay = runDirDisplay;
    this.now = now;
    this.manifest = manifest;
  }

  static async create(options: CreateFusionArtifactStoreOptions): Promise<FusionArtifactStore> {
    const profile = options.profile ?? FUSION_BRAINSTORM_WORKFLOW;
    const runId = options.runId ?? makeRunId(profile);
    if (!RUN_ID_PATTERN.test(runId)) throw errorForArtifact(`invalid fusion run id: ${runId}`);
    if (!runId.startsWith(profile.runIdPrefix)) {
      throw errorForArtifact(
        `fusion run id ${runId} does not carry the ${profile.id} workflow prefix ${profile.runIdPrefix}`,
      );
    }
    const sessionSegment = sanitizePathSegment(
      options.sessionId ?? `session-${String(process.pid)}`,
    );
    const sessionDirName = `${sessionSegment}-${String(process.pid)}`;
    const runDirAbs = join(options.cwd, '.pi', 'fusion', sessionDirName, runId);
    const runDirDisplay = join('.pi', 'fusion', sessionDirName, runId);
    await mkdir(runDirAbs, { recursive: true, mode: 0o700 });
    await chmod(runDirAbs, 0o700);
    const timestamp = (options.now ?? (() => new Date()))().toISOString();
    const manifest: MutableFusionArtifactManifest = {
      schema_version: FUSION_MANIFEST_SCHEMA_VERSION,
      run_id: runId,
      workflow: profile.id,
      source: options.source,
      state: 'initializing',
      created_at: timestamp,
      updated_at: timestamp,
      cwd: options.cwd,
      config: options.config,
      models: modelsForManifest(options.models),
      capabilities: options.capabilities ?? {
        candidate: 'reason',
        evaluation: 'reason',
        merge: 'reason',
      },
      usage: cloneFusionUsage(EMPTY_FUSION_USAGE),
      attempts: [],
      artifacts: {},
    };
    const store = new FusionArtifactStore(
      runDirAbs,
      runDirDisplay,
      options.now ?? (() => new Date()),
      manifest,
    );
    await store.writeManifest();
    return store;
  }

  get runId(): string {
    return this.manifest.run_id;
  }

  get artifactDir(): string {
    return this.runDirDisplay;
  }

  get artifactDirAbs(): string {
    return this.runDirAbs;
  }

  childToolCallLogPath(stage: FusionStage, slot: 1 | 2 | 3 | undefined, attempt: number): string {
    return this.artifactPath(`${attemptPrefix(stage, slot, attempt)}.tool-calls.jsonl`);
  }

  snapshot(): FusionArtifactManifest {
    return publicManifest(this.manifest);
  }

  async transition(to: FusionState): Promise<void> {
    await this.updateManifest((manifest) => {
      if (!canTransition(manifest.state, to)) {
        throw new FusionError(`illegal fusion state transition ${manifest.state} -> ${to}`, {
          code: 'state_transition_invalid',
          childCreated: false,
        });
      }
      if (to === 'completed' && manifest.artifacts['merged.md'] === undefined) {
        throw new FusionError('fusion cannot complete before merged.md is durable', {
          code: 'state_transition_invalid',
          childCreated: false,
        });
      }
      manifest.state = to;
    });
  }

  async setAnonymousMap(map: Record<FusionCandidateId, 1 | 2 | 3>): Promise<void> {
    await this.updateManifest((manifest) => {
      manifest.anonymous_map = { ...map };
    });
  }

  async setUsage(usage: FusionUsage): Promise<void> {
    await this.updateManifest((manifest) => {
      manifest.usage = cloneFusionUsage(usage);
    });
  }

  async writeCanonicalInput(serialized: string): Promise<void> {
    await this.writeArtifact('canonical-input.json', serialized);
  }

  /**
   * Complete, source-ordered ledger of every omitted conversation event. Kept in
   * a separate artifact so canonical input carries only compact run receipts
   * while the full omission accounting stays locally auditable.
   */
  async writeContextLedger(ledger: FusionContextOmissionLedgerV2): Promise<void> {
    await this.writeArtifact('context-omission-ledger.json', canonicalJson(ledger));
  }

  /** Route capacities and the pre-candidate whole-workflow feasibility decision. */
  async writeBudgetPlan(plan: FusionBudgetPlanV1): Promise<void> {
    await this.writeArtifact('budget-plan.json', canonicalJson(plan));
  }

  async writeBlindCandidates(serialized: string): Promise<void> {
    await this.writeArtifact('blind-candidates.json', serialized);
  }

  async writeEvaluationJson(value: unknown): Promise<void> {
    await this.writeArtifact('evaluation.json', canonicalJson(value));
  }

  async writeMerged(text: string): Promise<void> {
    await this.writeArtifact('merged.md', text);
  }

  async writeError(state: Exclude<FusionTerminalState, 'completed'>, error: string): Promise<void> {
    await this.writeArtifact('error.json', `${JSON.stringify({ state, error }, null, 2)}\n`);
    await this.updateManifest((manifest) => {
      if (!TERMINAL_STATES.has(state)) throw errorForArtifact(`invalid terminal state ${state}`);
      if (!canTransition(manifest.state, state)) {
        throw new FusionError(`illegal fusion state transition ${manifest.state} -> ${state}`, {
          code: 'state_transition_invalid',
          childCreated: false,
        });
      }
      manifest.state = state;
      manifest.error = error;
    });
  }

  async recordChildAttempt(input: RecordFusionChildAttemptInput): Promise<void> {
    const prefix = attemptPrefix(input.result.stage, input.result.slot, input.result.attempt);
    const promptRef = await this.writeArtifact(`${prefix}.prompt.txt`, input.prompt);
    const eventsRef = await this.writeArtifact(`${prefix}.events.jsonl`, input.result.events);
    const stderrRef = await this.writeArtifact(`${prefix}.stderr.txt`, input.result.stderr);
    const responseRef = await this.writeArtifact(
      responseName(prefix, input.responseKind),
      input.result.text,
    );
    const toolCallsRef =
      input.result.toolCallTrace === undefined
        ? undefined
        : await this.writeArtifact(`${prefix}.tool-calls.jsonl`, input.result.toolCallTrace.bytes);
    await this.updateManifest((manifest) => {
      const record: FusionAttemptArtifactRecord = {
        stage: input.result.stage,
        attempt: input.result.attempt,
        status: 'completed',
        prompt_path: promptRef.path,
        events_path: eventsRef.path,
        stderr_path: stderrRef.path,
        response_path: responseRef.path,
        provider: input.result.provider,
        model: input.result.model,
        qualifiedId: input.result.qualifiedId,
        usage: cloneFusionUsage(input.result.usage),
      };
      if (toolCallsRef !== undefined && input.result.toolCallTrace !== undefined) {
        record.tool_calls_path = toolCallsRef.path;
        record.tool_calls = { ...input.result.toolCallTrace.summary };
      }
      if (input.result.slot !== undefined) record.slot = input.result.slot;
      manifest.attempts.push(record);
    });
  }

  async recordCalibrationViolation(input: {
    stage: FusionStage;
    slot?: 1 | 2 | 3;
    attempt: number;
    violation: FusionCalibrationViolation;
  }): Promise<FusionArtifactRef> {
    const prefix = attemptPrefix(input.stage, input.slot, input.attempt);
    return this.writeArtifact(calibrationViolationName(prefix), `${canonicalJson(input.violation)}\n`);
  }

  async recordFailedAttempt(input: RecordFusionFailedAttemptInput): Promise<void> {
    const prefix = attemptPrefix(input.stage, input.slot, input.attempt);
    const promptRef = await this.writeArtifact(`${prefix}.prompt.txt`, input.prompt);
    const eventsRef = await this.writeArtifact(`${prefix}.events.jsonl`, input.events);
    const stderrRef = await this.writeArtifact(`${prefix}.stderr.txt`, input.stderr);
    const responseRef = await this.writeArtifact(responseName(prefix, input.responseKind), '');
    const partialResponseRef =
      input.partialResponse.length === 0
        ? undefined
        : await this.writeArtifact(
            `${prefix}.response.partial.${input.responseKind}`,
            input.partialResponse,
          );
    await this.updateManifest((manifest) => {
      const record: FusionAttemptArtifactRecord = {
        stage: input.stage,
        attempt: input.attempt,
        status: input.status,
        prompt_path: promptRef.path,
        events_path: eventsRef.path,
        stderr_path: stderrRef.path,
        response_path: responseRef.path,
        error: input.error,
      };
      if (partialResponseRef !== undefined) record.partial_response_path = partialResponseRef.path;
      if (input.provider !== undefined) record.provider = input.provider;
      if (input.model !== undefined) record.model = input.model;
      if (input.qualifiedId !== undefined) record.qualifiedId = input.qualifiedId;
      if (input.usage !== undefined) record.usage = cloneFusionUsage(input.usage);
      if (input.slot !== undefined) record.slot = input.slot;
      manifest.attempts.push(record);
    });
  }

  private async writeArtifact(name: string, data: Buffer | string): Promise<FusionArtifactRef> {
    const absPath = this.artifactPath(name);
    const ref = await writePrivateFile(absPath, data);
    await this.updateManifest((manifest) => {
      manifest.artifacts[name] = ref;
    });
    return ref;
  }

  private artifactPath(name: string): string {
    if (name.length === 0 || name.includes('/') || name.includes('\\')) {
      throw errorForArtifact(`invalid fusion artifact name: ${name}`);
    }
    const absPath = join(this.runDirAbs, name);
    if (!pathInside(this.runDirAbs, absPath)) {
      throw errorForArtifact(`fusion artifact path escapes run directory: ${name}`);
    }
    return absPath;
  }

  private async writeManifest(): Promise<void> {
    await writeJsonAtomic(join(this.runDirAbs, 'manifest.json'), publicManifest(this.manifest));
  }

  private async updateManifest(
    mutator: (manifest: MutableFusionArtifactManifest) => void,
  ): Promise<void> {
    const write = async () => {
      mutator(this.manifest);
      this.manifest.updated_at = this.now().toISOString();
      await this.writeManifest();
    };
    const next = this.manifestWriteChain.then(write, write);
    this.manifestWriteChain = next.catch(() => undefined);
    await next;
  }
}

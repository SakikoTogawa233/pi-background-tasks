import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Buffer } from '../attested-pi-run.js';
import { parseJsonText, type JsonObject } from '../common.js';
import {
  FUSION_COMMITTED_RESULT_SCHEMA_VERSION,
  FUSION_MANIFEST_SCHEMA_VERSION,
  FUSION_RESULT_SCHEMA_VERSION,
  FusionError,
  type FusionArtifactRef,
  type FusionResultDetails,
  type FusionRunResult,
  type FusionUsage,
  type FusionWorkflowId,
} from './types.js';

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(message: string, artifactDir: string): never {
  throw new FusionError(`fusion committed result invalid: ${message}`, {
    code: 'artifact_error',
    childCreated: true,
    artifactDir,
  });
}

function assertOnlyKeys(
  value: JsonObject,
  allowed: readonly string[],
  label: string,
  artifactDir: string,
): void {
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0)
    fail(`${label} contains unexpected keys: ${unexpected.join(', ')}`, artifactDir);
}

function artifactRef(value: unknown, label: string, artifactDir: string): FusionArtifactRef {
  if (!isRecord(value)) fail(`${label} must be an object`, artifactDir);
  assertOnlyKeys(value, ['path', 'byte_length', 'sha256'], label, artifactDir);
  const path = value['path'];
  const byteLength = value['byte_length'];
  const sha256 = value['sha256'];
  if (typeof path !== 'string' || path.length === 0 || path.includes('/') || path.includes('\\')) {
    fail(`${label}.path is invalid`, artifactDir);
  }
  if (!Number.isSafeInteger(byteLength) || Number(byteLength) < 0) {
    fail(`${label}.byte_length is invalid`, artifactDir);
  }
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    fail(`${label}.sha256 is invalid`, artifactDir);
  }
  return { path, byte_length: Number(byteLength), sha256 };
}

function usage(value: unknown, artifactDir: string): FusionUsage {
  if (!isRecord(value)) fail('details.usage must be an object', artifactDir);
  assertOnlyKeys(
    value,
    ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'cost'],
    'details.usage',
    artifactDir,
  );
  const cost = value['cost'];
  if (!isRecord(cost)) fail('details.usage.cost must be an object', artifactDir);
  assertOnlyKeys(
    cost,
    ['input', 'output', 'cacheRead', 'cacheWrite', 'total'],
    'details.usage.cost',
    artifactDir,
  );
  const finiteNonnegative = (entry: unknown, label: string): number => {
    if (typeof entry !== 'number' || !Number.isFinite(entry) || entry < 0)
      fail(`${label} is invalid`, artifactDir);
    return entry;
  };
  return {
    input: finiteNonnegative(value['input'], 'details.usage.input'),
    output: finiteNonnegative(value['output'], 'details.usage.output'),
    cacheRead: finiteNonnegative(value['cacheRead'], 'details.usage.cacheRead'),
    cacheWrite: finiteNonnegative(value['cacheWrite'], 'details.usage.cacheWrite'),
    totalTokens: finiteNonnegative(value['totalTokens'], 'details.usage.totalTokens'),
    cost: {
      input: finiteNonnegative(cost['input'], 'details.usage.cost.input'),
      output: finiteNonnegative(cost['output'], 'details.usage.cost.output'),
      cacheRead: finiteNonnegative(cost['cacheRead'], 'details.usage.cost.cacheRead'),
      cacheWrite: finiteNonnegative(cost['cacheWrite'], 'details.usage.cost.cacheWrite'),
      total: finiteNonnegative(cost['total'], 'details.usage.cost.total'),
    },
  };
}

function resultDetails(
  value: unknown,
  expected: { runId: string; workflow: FusionWorkflowId; artifactDir: string },
): FusionResultDetails {
  if (!isRecord(value)) fail('details must be an object', expected.artifactDir);
  assertOnlyKeys(
    value,
    [
      'schema_version',
      'run_id',
      'workflow',
      'source',
      'status',
      'context',
      'tool_policy',
      'artifact_dir',
      'models',
      'evaluator_attempts',
      'usage',
      'budget',
    ],
    'details',
    expected.artifactDir,
  );
  if (value['schema_version'] !== FUSION_RESULT_SCHEMA_VERSION)
    fail('details schema version mismatch', expected.artifactDir);
  if (value['run_id'] !== expected.runId) fail('details run id mismatch', expected.artifactDir);
  if (value['workflow'] !== expected.workflow)
    fail('details workflow mismatch', expected.artifactDir);
  if (value['source'] !== 'command' && value['source'] !== 'tool')
    fail('details source is invalid', expected.artifactDir);
  if (value['status'] !== 'completed')
    fail('details status is not completed', expected.artifactDir);
  if (value['artifact_dir'] !== expected.artifactDir)
    fail('details artifact directory mismatch', expected.artifactDir);
  const context = value['context'];
  const toolPolicy = value['tool_policy'];
  const models = value['models'];
  const budget = value['budget'];
  if (!isRecord(context) || !isRecord(toolPolicy) || !isRecord(models) || !isRecord(budget)) {
    fail('details nested contract is malformed', expected.artifactDir);
  }
  assertOnlyKeys(context, ['kind', 'policy_id'], 'details.context', expected.artifactDir);
  if (
    (context['kind'] !== 'session_projection' && context['kind'] !== 'clean_task') ||
    typeof context['policy_id'] !== 'string'
  ) {
    fail('details.context is invalid', expected.artifactDir);
  }
  assertOnlyKeys(
    toolPolicy,
    ['candidate_tools', 'evaluation_tools', 'merge_tools'],
    'details.tool_policy',
    expected.artifactDir,
  );
  const stringArray = (entry: unknown): entry is string[] =>
    Array.isArray(entry) && entry.every((item) => typeof item === 'string');
  if (
    !stringArray(toolPolicy['candidate_tools']) ||
    !Array.isArray(toolPolicy['evaluation_tools']) ||
    toolPolicy['evaluation_tools'].length !== 0 ||
    !Array.isArray(toolPolicy['merge_tools']) ||
    toolPolicy['merge_tools'].length !== 0
  ) {
    fail('details.tool_policy is invalid', expected.artifactDir);
  }
  assertOnlyKeys(
    models,
    ['candidates', 'evaluator', 'merger', 'thinking_level'],
    'details.models',
    expected.artifactDir,
  );
  if (
    !stringArray(models['candidates']) ||
    models['candidates'].length !== 3 ||
    typeof models['evaluator'] !== 'string' ||
    typeof models['merger'] !== 'string' ||
    typeof models['thinking_level'] !== 'string'
  ) {
    fail('details.models is invalid', expected.artifactDir);
  }
  assertOnlyKeys(
    budget,
    [
      'policy_id',
      'calibration_version',
      'route_table',
      'rate_sources',
      'unknown_provider_warnings',
      'calibration_warnings',
    ],
    'details.budget',
    expected.artifactDir,
  );
  if (
    typeof budget['policy_id'] !== 'string' ||
    typeof budget['calibration_version'] !== 'string' ||
    !Array.isArray(budget['route_table']) ||
    !Array.isArray(budget['rate_sources']) ||
    !stringArray(budget['unknown_provider_warnings']) ||
    !Array.isArray(budget['calibration_warnings'])
  ) {
    fail('details.budget is invalid', expected.artifactDir);
  }
  if (
    !Number.isSafeInteger(value['evaluator_attempts']) ||
    ![1, 2].includes(Number(value['evaluator_attempts']))
  ) {
    fail('details evaluator_attempts is invalid', expected.artifactDir);
  }
  const checkedUsage = usage(value['usage'], expected.artifactDir);
  const candidates = models['candidates'];
  if (!stringArray(candidates) || candidates.length !== 3)
    fail('details.models candidates are invalid', expected.artifactDir);
  const candidate1 = candidates[0];
  const candidate2 = candidates[1];
  const candidate3 = candidates[2];
  if (candidate1 === undefined || candidate2 === undefined || candidate3 === undefined) {
    fail('details.models candidates are incomplete', expected.artifactDir);
  }
  const source = value['source'];
  const contextKind = context['kind'];
  return {
    schema_version: FUSION_RESULT_SCHEMA_VERSION,
    run_id: expected.runId,
    workflow: expected.workflow,
    source,
    status: 'completed',
    context: { kind: contextKind, policy_id: context['policy_id'] },
    tool_policy: {
      candidate_tools: [...toolPolicy['candidate_tools']],
      evaluation_tools: [],
      merge_tools: [],
    },
    artifact_dir: expected.artifactDir,
    models: {
      candidates: [candidate1, candidate2, candidate3],
      evaluator: models['evaluator'],
      merger: models['merger'],
      thinking_level: models['thinking_level'],
    },
    evaluator_attempts: Number(value['evaluator_attempts']),
    usage: checkedUsage,
    budget: {
      policy_id: budget['policy_id'],
      calibration_version: budget['calibration_version'],
      route_table: budget['route_table'] as FusionResultDetails['budget']['route_table'],
      rate_sources: budget['rate_sources'] as FusionResultDetails['budget']['rate_sources'],
      unknown_provider_warnings: [...budget['unknown_provider_warnings']],
      calibration_warnings: budget[
        'calibration_warnings'
      ] as FusionResultDetails['budget']['calibration_warnings'],
    },
  };
}

function sameRef(left: FusionArtifactRef, right: FusionArtifactRef): boolean {
  return (
    left.path === right.path &&
    left.byte_length === right.byte_length &&
    left.sha256 === right.sha256
  );
}

async function readUtf8(
  path: string,
  label: string,
  artifactDir: string,
): Promise<{ bytes: Buffer; text: string }> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    fail(
      `${label} is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      artifactDir,
    );
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(`${label} is not well-formed UTF-8`, artifactDir);
  }
  return { bytes, text };
}

export interface ReadFusionCommittedResultOptions {
  artifactDirAbs: string;
  artifactDir: string;
  runId: string;
  workflow: FusionWorkflowId;
}

/** Verify the manifest-bound Fusion commit before returning merged bytes. */
export async function readFusionCommittedResult(
  options: ReadFusionCommittedResultOptions,
): Promise<FusionRunResult> {
  const manifestFile = await readUtf8(
    join(options.artifactDirAbs, 'manifest.json'),
    'manifest.json',
    options.artifactDir,
  );
  let manifestValue: unknown;
  try {
    manifestValue = parseJsonText(manifestFile.text);
  } catch (error) {
    fail(
      `manifest.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      options.artifactDir,
    );
  }
  if (!isRecord(manifestValue)) fail('manifest.json must be an object', options.artifactDir);
  if (manifestValue['schema_version'] !== FUSION_MANIFEST_SCHEMA_VERSION)
    fail('manifest schema version mismatch', options.artifactDir);
  if (manifestValue['run_id'] !== options.runId || manifestValue['workflow'] !== options.workflow)
    fail('manifest identity mismatch', options.artifactDir);
  if (manifestValue['state'] !== 'completed')
    fail('manifest is not committed', options.artifactDir);
  const artifacts = manifestValue['artifacts'];
  if (!isRecord(artifacts)) fail('manifest artifacts map is invalid', options.artifactDir);
  const manifestMerged = artifactRef(
    artifacts['merged.md'],
    'manifest artifacts merged.md',
    options.artifactDir,
  );
  const manifestResult = artifactRef(
    artifacts['result.json'],
    'manifest artifacts result.json',
    options.artifactDir,
  );
  if (manifestMerged.path !== 'merged.md' || manifestResult.path !== 'result.json')
    fail('manifest fixed artifact paths are invalid', options.artifactDir);

  const resultFile = await readUtf8(
    join(options.artifactDirAbs, 'result.json'),
    'result.json',
    options.artifactDir,
  );
  if (
    resultFile.bytes.length !== manifestResult.byte_length ||
    sha256Buffer(resultFile.bytes) !== manifestResult.sha256
  ) {
    fail('result.json does not match its manifest hash and length', options.artifactDir);
  }
  let resultValue: unknown;
  try {
    resultValue = parseJsonText(resultFile.text);
  } catch (error) {
    fail(
      `result.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      options.artifactDir,
    );
  }
  if (!isRecord(resultValue)) fail('result.json must be an object', options.artifactDir);
  assertOnlyKeys(
    resultValue,
    ['schema_version', 'run_id', 'merged', 'details'],
    'result.json',
    options.artifactDir,
  );
  if (
    resultValue['schema_version'] !== FUSION_COMMITTED_RESULT_SCHEMA_VERSION ||
    resultValue['run_id'] !== options.runId
  ) {
    fail('result.json identity mismatch', options.artifactDir);
  }
  const committedMerged = artifactRef(
    resultValue['merged'],
    'result.json merged',
    options.artifactDir,
  );
  if (!sameRef(committedMerged, manifestMerged))
    fail('result.json merged reference does not match manifest', options.artifactDir);
  const details = resultDetails(resultValue['details'], options);

  const mergedFile = await readUtf8(
    join(options.artifactDirAbs, 'merged.md'),
    'merged.md',
    options.artifactDir,
  );
  if (
    mergedFile.bytes.length !== committedMerged.byte_length ||
    sha256Buffer(mergedFile.bytes) !== committedMerged.sha256
  ) {
    fail('merged.md does not match its committed hash and length', options.artifactDir);
  }
  return { mergedText: mergedFile.text, details };
}

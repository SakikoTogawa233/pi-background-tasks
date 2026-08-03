import { parseJsonText, type JsonObject } from '../common.js';
import {
  FUSION_CANDIDATE_IDS,
  FUSION_EVALUATION_SCHEMA_VERSION,
  FusionError,
  type CandidateAssessment,
  type FusionCandidateId,
  type FusionConflict,
  type FusionConflictPosition,
  type FusionEvaluationV1,
  type FusionSynthesisContribution,
  type FusionSynthesisPlan,
} from './types.js';

const MAX_REPAIR_ERROR_CHARS = 500;
const MAX_REPAIR_ERROR_COUNT = 24;
const MAX_REPAIR_ERROR_TOTAL_CHARS = 4000;

export type FusionEvaluationValidationResult =
  | { ok: true; value: FusionEvaluationV1 }
  | { ok: false; errors: readonly string[] };

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function closed(
  record: JsonObject,
  keys: readonly string[],
  label: string,
  errors: string[],
): void {
  const expected = new Set(keys);
  for (const key of Object.keys(record)) {
    if (!expected.has(key)) errors.push(`${label} contains unknown key ${key}`);
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key))
      errors.push(`${label} is missing key ${key}`);
  }
}

function nonBlankString(value: unknown, label: string, errors: string[]): string | undefined {
  if (typeof value !== 'string') {
    errors.push(`${label} must be a string`);
    return undefined;
  }
  if (value.trim().length === 0) {
    errors.push(`${label} must be non-blank`);
    return undefined;
  }
  return value;
}

function stringList(
  value: unknown,
  label: string,
  errors: string[],
): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return undefined;
  }
  const out: string[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = nonBlankString(item, `${label}[${String(index)}]`, errors);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

function candidateId(
  value: unknown,
  label: string,
  errors: string[],
): FusionCandidateId | undefined {
  if (value === 'A' || value === 'B' || value === 'C') return value;
  errors.push(`${label} must be A, B, or C`);
  return undefined;
}

function tuple3<T>(
  items: readonly T[],
  label: string,
  errors: string[],
): readonly [T, T, T] | undefined {
  if (items.length !== 3) {
    errors.push(`${label} must contain exactly three entries`);
    return undefined;
  }
  const first = items[0];
  const second = items[1];
  const third = items[2];
  if (first === undefined || second === undefined || third === undefined) {
    errors.push(`${label} must not contain empty positions`);
    return undefined;
  }
  return [first, second, third];
}

function parseAssessment(
  value: unknown,
  label: string,
  errors: string[],
): CandidateAssessment | undefined {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return undefined;
  }
  closed(
    value,
    ['candidate_id', 'summary', 'strengths', 'limitations', 'useful_contributions', 'risks'],
    label,
    errors,
  );
  const id = candidateId(value['candidate_id'], `${label}.candidate_id`, errors);
  const summary = nonBlankString(value['summary'], `${label}.summary`, errors);
  const strengths = stringList(value['strengths'], `${label}.strengths`, errors);
  const limitations = stringList(value['limitations'], `${label}.limitations`, errors);
  const useful = stringList(value['useful_contributions'], `${label}.useful_contributions`, errors);
  const risks = stringList(value['risks'], `${label}.risks`, errors);
  if (
    id === undefined ||
    summary === undefined ||
    strengths === undefined ||
    limitations === undefined ||
    useful === undefined ||
    risks === undefined
  ) {
    return undefined;
  }
  return { candidate_id: id, summary, strengths, limitations, useful_contributions: useful, risks };
}

function parsePosition(
  value: unknown,
  label: string,
  errors: string[],
): FusionConflictPosition | undefined {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return undefined;
  }
  closed(value, ['candidate_id', 'position'], label, errors);
  const id = candidateId(value['candidate_id'], `${label}.candidate_id`, errors);
  const position = nonBlankString(value['position'], `${label}.position`, errors);
  if (id === undefined || position === undefined) return undefined;
  return { candidate_id: id, position };
}

function parseConflict(
  value: unknown,
  label: string,
  errors: string[],
): FusionConflict | undefined {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return undefined;
  }
  closed(value, ['topic', 'positions', 'resolution'], label, errors);
  const topic = nonBlankString(value['topic'], `${label}.topic`, errors);
  const positionsRaw = value['positions'];
  const positions: FusionConflictPosition[] = [];
  if (!Array.isArray(positionsRaw)) {
    errors.push(`${label}.positions must be an array`);
  } else {
    for (const [index, item] of positionsRaw.entries()) {
      const parsed = parsePosition(item, `${label}.positions[${String(index)}]`, errors);
      if (parsed !== undefined) positions.push(parsed);
    }
    const distinctIds = new Set(positions.map((position) => position.candidate_id));
    if (distinctIds.size < 2)
      errors.push(`${label}.positions must include at least two distinct candidates`);
    if (distinctIds.size !== positions.length)
      errors.push(`${label}.positions candidate_id values must be unique`);
  }
  const resolution = nonBlankString(value['resolution'], `${label}.resolution`, errors);
  if (topic === undefined || resolution === undefined || !Array.isArray(positionsRaw))
    return undefined;
  return { topic, positions, resolution };
}

function parseContribution(
  value: unknown,
  label: string,
  errors: string[],
): FusionSynthesisContribution | undefined {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return undefined;
  }
  closed(value, ['candidate_id', 'contribution'], label, errors);
  const id = candidateId(value['candidate_id'], `${label}.candidate_id`, errors);
  const contribution = nonBlankString(value['contribution'], `${label}.contribution`, errors);
  if (id === undefined || contribution === undefined) return undefined;
  return { candidate_id: id, contribution };
}

function parseContributionList(
  value: unknown,
  label: string,
  errors: string[],
): readonly FusionSynthesisContribution[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return undefined;
  }
  const out: FusionSynthesisContribution[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = parseContribution(item, `${label}[${String(index)}]`, errors);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

function parseSynthesisPlan(
  value: unknown,
  label: string,
  errors: string[],
): FusionSynthesisPlan | undefined {
  if (!isRecord(value)) {
    errors.push(`${label} must be an object`);
    return undefined;
  }
  closed(value, ['must_include', 'must_resolve', 'must_avoid'], label, errors);
  const include = parseContributionList(value['must_include'], `${label}.must_include`, errors);
  const resolve = stringList(value['must_resolve'], `${label}.must_resolve`, errors);
  const avoid = stringList(value['must_avoid'], `${label}.must_avoid`, errors);
  if (include === undefined || resolve === undefined || avoid === undefined) return undefined;
  return { must_include: include, must_resolve: resolve, must_avoid: avoid };
}

function parseAssessmentList(
  value: unknown,
  label: string,
  errors: string[],
): readonly [CandidateAssessment, CandidateAssessment, CandidateAssessment] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return undefined;
  }
  const parsed: CandidateAssessment[] = [];
  for (const [index, item] of value.entries()) {
    const assessment = parseAssessment(item, `${label}[${String(index)}]`, errors);
    if (assessment !== undefined) parsed.push(assessment);
  }
  const ids = new Set(parsed.map((assessment) => assessment.candidate_id));
  for (const id of FUSION_CANDIDATE_IDS) {
    if (!ids.has(id)) errors.push(`${label} must contain candidate ${id}`);
  }
  if (ids.size !== parsed.length) errors.push(`${label} candidate_id values must be unique`);
  return tuple3(parsed, label, errors);
}

function parseConflictList(
  value: unknown,
  label: string,
  errors: string[],
): readonly FusionConflict[] | undefined {
  if (!Array.isArray(value)) {
    errors.push(`${label} must be an array`);
    return undefined;
  }
  const out: FusionConflict[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = parseConflict(item, `${label}[${String(index)}]`, errors);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

export function validateFusionEvaluation(value: unknown): FusionEvaluationValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ['evaluation must be a JSON object'] };
  closed(
    value,
    ['schema_version', 'candidate_assessments', 'agreements', 'conflicts', 'synthesis_plan'],
    'evaluation',
    errors,
  );
  if (value['schema_version'] !== FUSION_EVALUATION_SCHEMA_VERSION) {
    errors.push('evaluation.schema_version mismatch');
  }
  const assessments = parseAssessmentList(
    value['candidate_assessments'],
    'evaluation.candidate_assessments',
    errors,
  );
  const agreements = stringList(value['agreements'], 'evaluation.agreements', errors);
  const conflicts = parseConflictList(value['conflicts'], 'evaluation.conflicts', errors);
  const plan = parseSynthesisPlan(value['synthesis_plan'], 'evaluation.synthesis_plan', errors);
  if (
    errors.length > 0 ||
    assessments === undefined ||
    agreements === undefined ||
    conflicts === undefined ||
    plan === undefined
  ) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      schema_version: FUSION_EVALUATION_SCHEMA_VERSION,
      candidate_assessments: assessments,
      agreements,
      conflicts,
      synthesis_plan: plan,
    },
  };
}

export function parseFusionEvaluation(text: string): FusionEvaluationV1 {
  let parsed: unknown;
  try {
    parsed = parseJsonText(text);
  } catch (error) {
    throw new FusionError(
      `evaluation output must be JSON only: ${error instanceof Error ? error.message : String(error)}`,
      {
        code: 'evaluation_invalid',
        stage: 'evaluation',
      },
    );
  }
  const result = validateFusionEvaluation(parsed);
  if (!result.ok) {
    throw new FusionError(
      `evaluation output failed schema validation: ${formatEvaluationErrors(result.errors)}`,
      {
        code: 'evaluation_invalid',
        stage: 'evaluation',
      },
    );
  }
  return result.value;
}

export function boundedEvaluationErrors(errors: readonly string[]): readonly string[] {
  const bounded: string[] = [];
  let total = 0;
  for (const error of errors) {
    if (bounded.length >= MAX_REPAIR_ERROR_COUNT) break;
    const perError =
      error.length <= MAX_REPAIR_ERROR_CHARS
        ? error
        : `${error.slice(0, MAX_REPAIR_ERROR_CHARS - 1)}…`;
    const remaining = MAX_REPAIR_ERROR_TOTAL_CHARS - total;
    if (remaining <= 0) break;
    const next =
      perError.length <= remaining ? perError : `${perError.slice(0, Math.max(0, remaining - 1))}…`;
    bounded.push(next);
    total += next.length;
  }
  if (errors.length > bounded.length)
    bounded.push(`… ${String(errors.length - bounded.length)} more validation errors omitted`);
  return bounded;
}

export function formatEvaluationErrors(errors: readonly string[]): string {
  return boundedEvaluationErrors(errors).join('; ');
}

export type FusionValidationSeverity = 'critical' | 'high' | 'minor';

export interface FusionValidationFindingRecord {
  id: string;
  candidate_id: FusionCandidateId;
  severity: FusionValidationSeverity;
  location: string;
  evidence: string;
  impact: string;
  summary: string;
}

export interface FusionValidationFindingDecision {
  source_id: string;
  disposition: 'include' | 'exclude';
  rationale: string;
  group_id?: string | undefined;
}

export interface FusionValidationFindingAccounting {
  findings: readonly FusionValidationFindingRecord[];
  decisions: readonly FusionValidationFindingDecision[];
}

export function stableFusionFindingId(candidateId: FusionCandidateId, ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal <= 0) {
    throw new FusionError('validation finding ordinal must be a positive integer', {
      code: 'evaluation_invalid',
      stage: 'evaluation',
    });
  }
  return `${candidateId}-F${String(ordinal).padStart(3, '0')}`;
}

export function validateFusionFindingAccounting(
  accounting: FusionValidationFindingAccounting,
): readonly string[] {
  const errors: string[] = [];
  const sourceIds = new Set<string>();
  for (const [index, finding] of accounting.findings.entries()) {
    const label = `finding[${String(index)}]`;
    if (finding.id !== stableFusionFindingId(finding.candidate_id, index + 1)) {
      errors.push(`${label}.id must be the stable host id for its candidate and ordinal`);
    }
    if (!['critical', 'high', 'minor'].includes(finding.severity)) errors.push(`${label}.severity invalid`);
    for (const key of ['location', 'evidence', 'impact', 'summary'] as const) {
      if (finding[key].trim().length === 0) errors.push(`${label}.${key} must be non-blank`);
    }
    if (sourceIds.has(finding.id)) errors.push(`${label}.id duplicate`);
    sourceIds.add(finding.id);
  }
  const accounted = new Set<string>();
  for (const [index, decision] of accounting.decisions.entries()) {
    const label = `decision[${String(index)}]`;
    if (!sourceIds.has(decision.source_id)) errors.push(`${label}.source_id does not name a candidate finding`);
    if (accounted.has(decision.source_id)) errors.push(`${label}.source_id accounted more than once`);
    accounted.add(decision.source_id);
    if (decision.disposition !== 'include' && decision.disposition !== 'exclude') errors.push(`${label}.disposition invalid`);
    if (decision.rationale.trim().length === 0) errors.push(`${label}.rationale must be non-blank`);
    if (decision.disposition === 'include' && (decision.group_id === undefined || decision.group_id.trim().length === 0)) {
      errors.push(`${label}.group_id required for included findings`);
    }
  }
  for (const id of sourceIds) {
    if (!accounted.has(id)) errors.push(`source finding ${id} was not accounted exactly once`);
  }
  return errors;
}

export function assertMergerFindingCoverage(
  accounting: FusionValidationFindingAccounting,
  renderedSourceIds: readonly string[],
): void {
  const errors = [...validateFusionFindingAccounting(accounting)];
  const included = new Set(
    accounting.decisions
      .filter((decision) => decision.disposition === 'include')
      .map((decision) => decision.source_id),
  );
  const rendered = new Set(renderedSourceIds);
  for (const id of included) if (!rendered.has(id)) errors.push(`merger dropped included finding ${id}`);
  for (const id of rendered) if (!included.has(id)) errors.push(`merger invented or revived finding ${id}`);
  if (errors.length > 0) {
    throw new FusionError(`validation finding preservation failed: ${formatEvaluationErrors(errors)}`, {
      code: 'evaluation_invalid',
      stage: 'merge',
    });
  }
}

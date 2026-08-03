import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertMergerFindingCoverage,
  boundedEvaluationErrors,
  parseFusionEvaluation,
  renderValidatedFusionValidationReport,
  validateFusionEvaluation,
  validateFusionFindingAccounting,
} from '../../src/core/fusion/evaluation.js';
import { FUSION_EVALUATION_SCHEMA_VERSION, FusionError, type FusionValidationFindingAccounting } from '../../src/core/fusion/types.js';

function validEvaluation(): Record<string, unknown> {
  return {
    schema_version: FUSION_EVALUATION_SCHEMA_VERSION,
    candidate_assessments: [
      {
        candidate_id: 'A',
        summary: 'solid',
        strengths: ['clear'],
        limitations: ['brief'],
        useful_contributions: ['structure'],
        risks: ['misses edge case'],
      },
      {
        candidate_id: 'B',
        summary: 'detailed',
        strengths: ['coverage'],
        limitations: ['wordy'],
        useful_contributions: ['tests'],
        risks: ['overstates'],
      },
      {
        candidate_id: 'C',
        summary: 'balanced',
        strengths: ['tradeoffs'],
        limitations: ['few examples'],
        useful_contributions: ['risk list'],
        risks: ['needs cleanup'],
      },
    ],
    agreements: ['all address the request'],
    conflicts: [
      {
        topic: 'scope',
        positions: [
          { candidate_id: 'A', position: 'small' },
          { candidate_id: 'B', position: 'broad' },
        ],
        resolution: 'use the smallest complete scope',
      },
    ],
    synthesis_plan: {
      must_include: [{ candidate_id: 'C', contribution: 'risk list' }],
      must_resolve: ['scope'],
      must_avoid: ['unsupported claims'],
    },
  };
}

function singletonAccounting(): FusionValidationFindingAccounting {
  return {
    findings: [
      {
        id: 'A-F001',
        candidate_id: 'A',
        severity: 'high',
        location: 'src/fusion.ts:12',
        evidence: 'read line 12',
        impact: 'breaks workflow',
        summary: 'workflow bug',
      },
    ],
    decisions: [
      {
        source_id: 'A-F001',
        disposition: 'include',
        rationale: 'candidate A: A-F001 is supported by evidence',
        group_id: 'G001',
      },
    ],
  };
}

void describe('fusion evaluation schema', () => {
  void it('accepts a closed valid evaluation object', () => {
    const parsed = parseFusionEvaluation(JSON.stringify(validEvaluation()));
    assert.equal(parsed.schema_version, FUSION_EVALUATION_SCHEMA_VERSION);
    assert.deepEqual(
      parsed.candidate_assessments.map((entry) => entry.candidate_id),
      ['A', 'B', 'C'],
    );
  });

  void it('rejects wrappers and invalid JSON without substring extraction', () => {
    assert.throws(() => parseFusionEvaluation('```json\n{}\n```'), /JSON only/);
    assert.throws(
      () => parseFusionEvaluation(`${JSON.stringify(validEvaluation())}\nprose`),
      /JSON only/,
    );
  });

  void it('rejects unknown fields, duplicate IDs, and blank strings', () => {
    const withExtra = validEvaluation();
    withExtra['winner'] = 'A';
    const extra = validateFusionEvaluation(withExtra);
    assert.equal(extra.ok, false);
    if (!extra.ok) assert.match(extra.errors.join('\n'), /unknown key winner/);

    const duplicate = validEvaluation();
    const assessments = duplicate['candidate_assessments'];
    assert.ok(Array.isArray(assessments));
    const first = assessments[0];
    assert.ok(typeof first === 'object' && first !== null && !Array.isArray(first));
    Reflect.set(first, 'candidate_id', 'B');
    const duplicateResult = validateFusionEvaluation(duplicate);
    assert.equal(duplicateResult.ok, false);
    if (!duplicateResult.ok) assert.match(duplicateResult.errors.join('\n'), /unique/);

    const blank = validEvaluation();
    blank['agreements'] = ['   '];
    const blankResult = validateFusionEvaluation(blank);
    assert.equal(blankResult.ok, false);
    if (!blankResult.ok) assert.match(blankResult.errors.join('\n'), /non-blank/);
  });

  void it('requires conflict positions from distinct candidates without duplicate IDs', () => {
    const invalid = validEvaluation();
    invalid['conflicts'] = [
      {
        topic: 'scope',
        positions: [
          { candidate_id: 'A', position: 'small' },
          { candidate_id: 'A', position: 'also small' },
        ],
        resolution: 'compare real disagreement',
      },
    ];
    const result = validateFusionEvaluation(invalid);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.errors.join('\n'), /two distinct|unique/);

    const duplicateWithTwoIds = validEvaluation();
    duplicateWithTwoIds['conflicts'] = [
      {
        topic: 'scope',
        positions: [
          { candidate_id: 'A', position: 'small' },
          { candidate_id: 'A', position: 'duplicate small' },
          { candidate_id: 'B', position: 'broad' },
        ],
        resolution: 'compare real disagreement',
      },
    ];
    const duplicateResult = validateFusionEvaluation(duplicateWithTwoIds);
    assert.equal(duplicateResult.ok, false);
    if (!duplicateResult.ok) assert.match(duplicateResult.errors.join('\n'), /unique/);
  });

  void it('validates validation finding singleton, duplicate, and exclusion contracts', () => {
    const singleton = singletonAccounting();
    assert.deepEqual(validateFusionFindingAccounting(singleton), []);
    const rendered = renderValidatedFusionValidationReport(singleton);
    assert.match(rendered, /# Validation report/);
    assert.match(rendered, /workflow bug/);
    assert.doesNotMatch(rendered, /A-F001|candidate A/i, 'rendered rationale must not expose source ids or candidate labels');

    const duplicateDecision: FusionValidationFindingAccounting = {
      ...singleton,
      decisions: [singleton.decisions[0]!, { ...singleton.decisions[0]!, rationale: 'duplicate' }],
    };
    assert.match(validateFusionFindingAccounting(duplicateDecision).join('\n'), /accounted more than once/);

    const includeWithoutGroup: FusionValidationFindingAccounting = {
      ...singleton,
      decisions: [{ source_id: 'A-F001', disposition: 'include', rationale: 'supported' }],
    };
    assert.match(validateFusionFindingAccounting(includeWithoutGroup).join('\n'), /group_id required/);

    const excludedWithGroup: FusionValidationFindingAccounting = {
      ...singleton,
      decisions: [
        { source_id: 'A-F001', disposition: 'exclude', rationale: 'duplicate of stronger finding', group_id: 'G001' },
      ],
    };
    assert.match(validateFusionFindingAccounting(excludedWithGroup).join('\n'), /group_id must be omitted/);

    const excluded: FusionValidationFindingAccounting = {
      ...singleton,
      decisions: [{ source_id: 'A-F001', disposition: 'exclude', rationale: 'candidate A: not supported' }],
    };
    assert.deepEqual(validateFusionFindingAccounting(excluded), []);
    const excludedReport = renderValidatedFusionValidationReport(excluded);
    assert.match(excludedReport, /No included findings/);
    assert.match(excludedReport, /Excluded source findings/);
    assert.doesNotMatch(excludedReport, /candidate A|A-F001/i);
  });

  void it('rejects validation merger dropped and invented finding IDs', () => {
    const singleton = singletonAccounting();
    assert.doesNotThrow(() => assertMergerFindingCoverage(singleton, ['A-F001']));
    assert.throws(
      () => assertMergerFindingCoverage(singleton, []),
      /merger dropped included finding A-F001/,
    );
    assert.throws(
      () => assertMergerFindingCoverage(singleton, ['A-F001', 'B-F001']),
      /invented or revived finding B-F001/,
    );
  });

  void it('bounds validation errors for repair prompts and user-facing failures', () => {
    const errors = Array.from(
      { length: 200 },
      (_, index) => `error-${String(index)}-${'x'.repeat(800)}`,
    );
    const bounded = boundedEvaluationErrors(errors);
    assert.ok(bounded.length < errors.length);
    assert.ok(bounded.join('').length < 4300);
    assert.match(bounded.at(-1) ?? '', /omitted/);
  });

  void it('throws a typed error for invalid parsed content', () => {
    assert.throws(
      () =>
        parseFusionEvaluation(JSON.stringify({ schema_version: FUSION_EVALUATION_SCHEMA_VERSION })),
      (error: unknown) => {
        assert.ok(error instanceof FusionError);
        assert.equal(error.code, 'evaluation_invalid');
        return true;
      },
    );
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  boundedEvaluationErrors,
  parseFusionEvaluation,
  validateFusionEvaluation,
} from '../../src/core/fusion/evaluation.js';
import { FUSION_EVALUATION_SCHEMA_VERSION, FusionError } from '../../src/core/fusion/types.js';

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

void describe('fusion evaluation schema', () => {
  void it('accepts a closed valid evaluation object', () => {
    const parsed = parseFusionEvaluation(JSON.stringify(validEvaluation()));
    assert.equal(parsed.schema_version, FUSION_EVALUATION_SCHEMA_VERSION);
    assert.deepEqual(parsed.candidate_assessments.map((entry) => entry.candidate_id), ['A', 'B', 'C']);
  });

  void it('rejects wrappers and invalid JSON without substring extraction', () => {
    assert.throws(() => parseFusionEvaluation('```json\n{}\n```'), /JSON only/);
    assert.throws(() => parseFusionEvaluation(`${JSON.stringify(validEvaluation())}\nprose`), /JSON only/);
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

  void it('bounds validation errors for repair prompts and user-facing failures', () => {
    const errors = Array.from({ length: 200 }, (_, index) => `error-${String(index)}-${'x'.repeat(800)}`);
    const bounded = boundedEvaluationErrors(errors);
    assert.ok(bounded.length < errors.length);
    assert.ok(bounded.join('').length < 4300);
    assert.match(bounded.at(-1) ?? '', /omitted/);
  });

  void it('throws a typed error for invalid parsed content', () => {
    assert.throws(
      () => parseFusionEvaluation(JSON.stringify({ schema_version: FUSION_EVALUATION_SCHEMA_VERSION })),
      (error: unknown) => {
        assert.ok(error instanceof FusionError);
        assert.equal(error.code, 'evaluation_invalid');
        return true;
      },
    );
  });
});

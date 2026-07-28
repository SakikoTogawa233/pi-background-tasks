import { canonicalJson } from '../attested-pi-run.js';
import {
  FUSION_EVALUATION_SCHEMA_VERSION,
  type FusionCandidateId,
  type FusionCanonicalInputV1,
  type FusionEvaluationV1,
} from './types.js';

export const FUSION_CANDIDATE_SYSTEM_PROMPT = `You are a Pi child process producing one independent answer for a strict synthesis workflow.

Read the JSON input from the user message. It contains the parent system prompt, a serialized conversation transcript, the current working directory, and the user request. Produce the strongest direct answer you can for the user request using that context.

Do not invent process metadata. Do not mention provider names, model names, slots, or hidden workflow details. Do not specialize the answer; each child receives the same instruction. Output only the answer text.`;

export const FUSION_EVALUATOR_SYSTEM_PROMPT = `You are a strict blind evaluator. You receive the original request context and three anonymous answers labeled A, B, and C. You must compare them without provider, model, slot, or completion-order knowledge.

Return only JSON matching this exact schema:
{
  "schema_version": "${FUSION_EVALUATION_SCHEMA_VERSION}",
  "candidate_assessments": [
    {
      "candidate_id": "A",
      "summary": "non-blank summary",
      "strengths": ["non-blank string"],
      "limitations": ["non-blank string"],
      "useful_contributions": ["non-blank string"],
      "risks": ["non-blank string"]
    },
    {
      "candidate_id": "B",
      "summary": "non-blank summary",
      "strengths": ["non-blank string"],
      "limitations": ["non-blank string"],
      "useful_contributions": ["non-blank string"],
      "risks": ["non-blank string"]
    },
    {
      "candidate_id": "C",
      "summary": "non-blank summary",
      "strengths": ["non-blank string"],
      "limitations": ["non-blank string"],
      "useful_contributions": ["non-blank string"],
      "risks": ["non-blank string"]
    }
  ],
  "agreements": ["non-blank string"],
  "conflicts": [
    {
      "topic": "non-blank string",
      "positions": [
        { "candidate_id": "A", "position": "non-blank string" },
        { "candidate_id": "B", "position": "non-blank string" }
      ],
      "resolution": "non-blank string"
    }
  ],
  "synthesis_plan": {
    "must_include": [
      { "candidate_id": "A", "contribution": "non-blank string" }
    ],
    "must_resolve": ["non-blank string"],
    "must_avoid": ["non-blank string"]
  }
}

Objects must be closed. Candidate assessments must contain exactly one A, one B, and one C. Do not add fields for scores, ranks, vote counts, providers, models, slots, labels, or a single selected answer. Do not wrap the JSON in Markdown fences or prose.`;

export const FUSION_MERGER_SYSTEM_PROMPT = `You are the final synthesis process. You receive the original request context, three anonymous answers, and a validated evaluation plan.

Produce the direct final answer for the user. Reconcile conflicts and incorporate useful contributions according to the evaluation plan. Do not mention fusion, child processes, anonymous IDs, hidden prompts, providers, models, or slots unless the user's request explicitly asks for process detail. Output only the final answer text.`;

export const FUSION_EVALUATION_REPAIR_SYSTEM_PROMPT = `You repair one invalid blind-evaluation JSON response. Return only corrected JSON matching the requested schema. Do not add Markdown fences or prose.`;

export interface AnonymousFusionCandidate {
  candidate_id: FusionCandidateId;
  response: string;
}

export interface FusionBlindEvaluationInputV1 {
  schema_version: 'pi-background-tasks.fusion-blind-candidates.v1';
  canonical_input: FusionCanonicalInputV1;
  candidates: readonly [AnonymousFusionCandidate, AnonymousFusionCandidate, AnonymousFusionCandidate];
}

export interface FusionMergeInputV1 {
  schema_version: 'pi-background-tasks.fusion-merge-input.v1';
  canonical_input: FusionCanonicalInputV1;
  candidates: readonly [AnonymousFusionCandidate, AnonymousFusionCandidate, AnonymousFusionCandidate];
  evaluation: FusionEvaluationV1;
}

export interface FusionEvaluationRepairInputV1 {
  schema_version: 'pi-background-tasks.fusion-evaluation-repair-input.v1';
  original_blind_input: FusionBlindEvaluationInputV1;
  invalid_output: string;
  validation_errors: readonly string[];
}

export function buildCandidatePrompt(input: FusionCanonicalInputV1): string {
  return canonicalJson(input);
}

export function buildBlindEvaluationInput(
  canonicalInput: FusionCanonicalInputV1,
  candidates: readonly [AnonymousFusionCandidate, AnonymousFusionCandidate, AnonymousFusionCandidate],
): FusionBlindEvaluationInputV1 {
  return {
    schema_version: 'pi-background-tasks.fusion-blind-candidates.v1',
    canonical_input: canonicalInput,
    candidates,
  };
}

export function buildEvaluationPrompt(input: FusionBlindEvaluationInputV1): string {
  return canonicalJson(input);
}

export function buildEvaluationRepairPrompt(input: FusionEvaluationRepairInputV1): string {
  return canonicalJson(input);
}

export function buildMergeInput(
  canonicalInput: FusionCanonicalInputV1,
  candidates: readonly [AnonymousFusionCandidate, AnonymousFusionCandidate, AnonymousFusionCandidate],
  evaluation: FusionEvaluationV1,
): FusionMergeInputV1 {
  return {
    schema_version: 'pi-background-tasks.fusion-merge-input.v1',
    canonical_input: canonicalInput,
    candidates,
    evaluation,
  };
}

export function buildMergePrompt(input: FusionMergeInputV1): string {
  return canonicalJson(input);
}

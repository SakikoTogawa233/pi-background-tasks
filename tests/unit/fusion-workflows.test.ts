import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FUSION_BRAINSTORM_WORKFLOW,
  FUSION_BRAINSTORM_TOOL_NAME,
  FUSION_VALIDATE_TOOL_NAME,
  FUSION_VALIDATE_WORKFLOW,
  fusionWorkflowProfile,
  resolveWorkflowCapability,
} from '../../src/core/fusion/workflows.js';
import {
  FUSION_CANDIDATE_INSPECT_SYSTEM_PROMPT,
  FUSION_CANDIDATE_SYSTEM_PROMPT,
  FUSION_EVALUATION_REPAIR_SYSTEM_PROMPT,
  FUSION_EVALUATOR_SYSTEM_PROMPT,
  FUSION_MERGER_SYSTEM_PROMPT,
  FUSION_VALIDATE_CANDIDATE_SYSTEM_PROMPT,
  FUSION_VALIDATE_EVALUATION_REPAIR_SYSTEM_PROMPT,
  FUSION_VALIDATE_EVALUATOR_SYSTEM_PROMPT,
  FUSION_VALIDATE_MERGER_SYSTEM_PROMPT,
  fusionValidateCandidateSystemPrompt,
} from '../../src/core/fusion/prompts.js';
import {
  FUSION_BRAINSTORM_DEFAULT_CAPABILITY,
  FUSION_NO_TOOLS_CAPABILITY,
  FUSION_VALIDATE_CAPABILITY,
  FUSION_WORKFLOW_IDS,
} from '../../src/core/fusion/types.js';

void describe('fusion workflow profiles', () => {
  void it('binds the brainstorm profile to the exact pre-extraction constants', () => {
    // The workflow seam was introduced by extracting these strings. If one binding
    // drifts, brainstorm silently changes behaviour even though its own prompt
    // constants are untouched, so the identity is pinned explicitly.
    assert.equal(FUSION_BRAINSTORM_WORKFLOW.id, 'brainstorm');
    assert.equal(FUSION_BRAINSTORM_WORKFLOW.toolName, FUSION_BRAINSTORM_TOOL_NAME);
    assert.equal(FUSION_BRAINSTORM_WORKFLOW.toolName, 'fusion_brainstorm');
    assert.equal(FUSION_BRAINSTORM_WORKFLOW.runIdPrefix, 'f');
    assert.equal(FUSION_BRAINSTORM_WORKFLOW.capabilityPolicy, 'caller_selected');
    assert.equal(FUSION_BRAINSTORM_WORKFLOW.fixedCapability, undefined);
    assert.equal(
      FUSION_BRAINSTORM_WORKFLOW.defaultCapability,
      FUSION_BRAINSTORM_DEFAULT_CAPABILITY,
    );
    assert.equal(FUSION_BRAINSTORM_WORKFLOW.defaultCapability, 'inspect');
    assert.equal(FUSION_BRAINSTORM_WORKFLOW.evaluatorSystemPrompt, FUSION_EVALUATOR_SYSTEM_PROMPT);
    assert.equal(
      FUSION_BRAINSTORM_WORKFLOW.evaluationRepairSystemPrompt,
      FUSION_EVALUATION_REPAIR_SYSTEM_PROMPT,
    );
    assert.equal(FUSION_BRAINSTORM_WORKFLOW.mergerSystemPrompt, FUSION_MERGER_SYSTEM_PROMPT);
    assert.equal(
      FUSION_BRAINSTORM_WORKFLOW.candidateSystemPrompt('reason'),
      FUSION_CANDIDATE_SYSTEM_PROMPT,
    );
    assert.equal(
      FUSION_BRAINSTORM_WORKFLOW.candidateSystemPrompt('inspect'),
      FUSION_CANDIDATE_INSPECT_SYSTEM_PROMPT,
    );
  });

  void it('binds the validate profile to its own stage framing', () => {
    assert.equal(FUSION_VALIDATE_WORKFLOW.id, 'validate');
    assert.equal(FUSION_VALIDATE_WORKFLOW.toolName, FUSION_VALIDATE_TOOL_NAME);
    assert.equal(FUSION_VALIDATE_WORKFLOW.toolName, 'fusion_validate');
    assert.equal(FUSION_VALIDATE_WORKFLOW.runIdPrefix, 'v');
    assert.equal(FUSION_VALIDATE_WORKFLOW.capabilityPolicy, 'fixed');
    assert.equal(FUSION_VALIDATE_WORKFLOW.fixedCapability, FUSION_VALIDATE_CAPABILITY);
    assert.equal(
      FUSION_VALIDATE_WORKFLOW.evaluatorSystemPrompt,
      FUSION_VALIDATE_EVALUATOR_SYSTEM_PROMPT,
    );
    assert.equal(
      FUSION_VALIDATE_WORKFLOW.evaluationRepairSystemPrompt,
      FUSION_VALIDATE_EVALUATION_REPAIR_SYSTEM_PROMPT,
    );
    assert.equal(FUSION_VALIDATE_WORKFLOW.mergerSystemPrompt, FUSION_VALIDATE_MERGER_SYSTEM_PROMPT);
    assert.equal(
      FUSION_VALIDATE_WORKFLOW.candidateSystemPrompt(FUSION_VALIDATE_CAPABILITY),
      FUSION_VALIDATE_CANDIDATE_SYSTEM_PROMPT,
    );
  });

  void it('keeps validate stage framing distinct from brainstorm', () => {
    assert.notEqual(
      FUSION_VALIDATE_CANDIDATE_SYSTEM_PROMPT,
      FUSION_CANDIDATE_INSPECT_SYSTEM_PROMPT,
    );
    assert.notEqual(FUSION_VALIDATE_EVALUATOR_SYSTEM_PROMPT, FUSION_EVALUATOR_SYSTEM_PROMPT);
    assert.notEqual(FUSION_VALIDATE_MERGER_SYSTEM_PROMPT, FUSION_MERGER_SYSTEM_PROMPT);
    assert.notEqual(
      FUSION_VALIDATE_EVALUATION_REPAIR_SYSTEM_PROMPT,
      FUSION_EVALUATION_REPAIR_SYSTEM_PROMPT,
    );
    assert.notEqual(FUSION_VALIDATE_WORKFLOW.runIdPrefix, FUSION_BRAINSTORM_WORKFLOW.runIdPrefix);
  });

  void it('validate candidates always run with the inspect capability', () => {
    // The validate capability must remain inspect: a reasoning-only reviewer cannot
    // read the code it is judging, so an accepted downgrade would turn validation
    // into unverified opinion while still reporting success.
    assert.equal(FUSION_VALIDATE_CAPABILITY, 'inspect');
    assert.equal(FUSION_BRAINSTORM_DEFAULT_CAPABILITY, 'inspect');
    assert.equal(FUSION_NO_TOOLS_CAPABILITY, 'reason');
    assert.throws(
      () => fusionValidateCandidateSystemPrompt('reason'),
      /always run with the inspect capability; received reason/,
    );
  });

  void it('states severity, evidence, and scope discipline in the validate candidate prompt', () => {
    for (const clause of [
      'critical:',
      'high:',
      'minor:',
      'Read before you judge',
      'Do not inflate severity',
      'Stay in scope',
    ]) {
      assert.ok(
        FUSION_VALIDATE_CANDIDATE_SYSTEM_PROMPT.includes(clause),
        `validate candidate prompt must state ${clause}`,
      );
    }
  });

  void it('requires the evaluator and merger to preserve single-source findings', () => {
    // A defect only one reviewer noticed is the highest-value output of a
    // three-model review. Both stages must be instructed to carry it forward, or a
    // real finding disappears by silent majority vote.
    assert.match(
      FUSION_VALIDATE_EVALUATOR_SYSTEM_PROMPT,
      /including claims raised by only one report/,
    );
    assert.match(
      FUSION_VALIDATE_MERGER_SYSTEM_PROMPT,
      /Do not drop a finding because only one report raised it/,
    );
    assert.match(
      FUSION_VALIDATE_MERGER_SYSTEM_PROMPT,
      /Do not add a finding that no report raised/,
    );
  });

  void it('shares one evaluation schema contract across both workflows', () => {
    // Both evaluators are judged by the same validateFusionEvaluation, so the schema
    // text they are given must be the identical block, not a hand-copied variant.
    const marker = 'Return only JSON matching this exact schema:';
    const brainstormSchema = FUSION_EVALUATOR_SYSTEM_PROMPT.slice(
      FUSION_EVALUATOR_SYSTEM_PROMPT.indexOf(marker),
    );
    const validateSchema = FUSION_VALIDATE_EVALUATOR_SYSTEM_PROMPT.slice(
      FUSION_VALIDATE_EVALUATOR_SYSTEM_PROMPT.indexOf(marker),
    );
    assert.ok(brainstormSchema.length > 0);
    assert.equal(brainstormSchema, validateSchema);
  });

  void it('appends the identical repair framing to each evaluator contract', () => {
    assert.ok(
      FUSION_EVALUATION_REPAIR_SYSTEM_PROMPT.startsWith(FUSION_EVALUATOR_SYSTEM_PROMPT),
    );
    assert.ok(
      FUSION_VALIDATE_EVALUATION_REPAIR_SYSTEM_PROMPT.startsWith(
        FUSION_VALIDATE_EVALUATOR_SYSTEM_PROMPT,
      ),
    );
    const brainstormSuffix = FUSION_EVALUATION_REPAIR_SYSTEM_PROMPT.slice(
      FUSION_EVALUATOR_SYSTEM_PROMPT.length,
    );
    const validateSuffix = FUSION_VALIDATE_EVALUATION_REPAIR_SYSTEM_PROMPT.slice(
      FUSION_VALIDATE_EVALUATOR_SYSTEM_PROMPT.length,
    );
    assert.equal(brainstormSuffix, validateSuffix);
    assert.match(brainstormSuffix, /repairing one invalid blind-evaluation JSON response/);
  });

  void it('resolves capability under each workflow policy', () => {
    assert.equal(
      resolveWorkflowCapability(FUSION_BRAINSTORM_WORKFLOW, undefined),
      FUSION_BRAINSTORM_DEFAULT_CAPABILITY,
    );
    assert.equal(resolveWorkflowCapability(FUSION_BRAINSTORM_WORKFLOW, 'inspect'), 'inspect');
    assert.equal(
      resolveWorkflowCapability(FUSION_VALIDATE_WORKFLOW, undefined),
      FUSION_VALIDATE_CAPABILITY,
    );
    assert.equal(
      resolveWorkflowCapability(FUSION_VALIDATE_WORKFLOW, FUSION_VALIDATE_CAPABILITY),
      FUSION_VALIDATE_CAPABILITY,
    );
  });

  void it('rejects a mismatched capability for a fixed workflow instead of substituting', () => {
    assert.throws(
      () => resolveWorkflowCapability(FUSION_VALIDATE_WORKFLOW, 'reason'),
      /always runs candidates with the inspect capability; received reason/,
    );
  });

  void it('resolves every declared workflow id', () => {
    assert.deepEqual([...FUSION_WORKFLOW_IDS], ['brainstorm', 'validate']);
    for (const id of FUSION_WORKFLOW_IDS) {
      assert.equal(fusionWorkflowProfile(id).id, id);
    }
    const prefixes = FUSION_WORKFLOW_IDS.map((id) => fusionWorkflowProfile(id).runIdPrefix);
    assert.equal(new Set(prefixes).size, prefixes.length, 'run id prefixes must be unique');
    const toolNames = FUSION_WORKFLOW_IDS.map((id) => fusionWorkflowProfile(id).toolName);
    assert.equal(new Set(toolNames).size, toolNames.length, 'tool names must be unique');
  });
});

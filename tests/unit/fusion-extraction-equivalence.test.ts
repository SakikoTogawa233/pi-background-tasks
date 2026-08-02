import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { canonicalJson } from '../../src/core/attested-pi-run.js';
import type { Message } from '@earendil-works/pi-ai';
import {
  buildFusionCanonicalInput,
  projectFusionConversation,
} from '../../src/core/fusion/context.js';
import {
  buildFusionCanonicalInput as buildPreExtraction,
  projectFusionConversation as projectPreExtraction,
} from '../oracle/fusion-context-pre-extraction.js';
import { FUSION_BRANCH_FILTER_ID, type FusionBranchFilterDescriptor } from '../../src/core/fusion/types.js';
import { FusionBudget } from '../../src/core/fusion/budget.js';
import { sessionWith } from '../helpers/fusion-canonical.js';
import {
  FUSION_GOLDEN_CASES,
  FUSION_GOLDEN_MODEL_SETS,
  type FusionGoldenCase,
} from '../helpers/fusion-golden-corpus.js';

/**
 * Old-versus-new differential equivalence gate for the shared-projection
 * extraction.
 *
 * `tests/oracle/fusion-context-pre-extraction.ts` is a verbatim copy of the
 * Fusion projection implementation as it existed immediately before the shared
 * transform was extracted. This gate proves the extracted implementation is
 * byte-identical to that independent oracle, rather than merely self-consistent
 * with goldens it generated itself.
 */

type Builder = typeof buildFusionCanonicalInput;

const BRANCH_FILTER: FusionBranchFilterDescriptor = {
  id: FUSION_BRANCH_FILTER_ID,
  tool_name: 'fusion_brainstorm',
  tool_call_id: null,
  active_tool_call_leaf_excluded: false,
};

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

interface Rendered {
  serialized: string;
  ledger: string;
  leafPresent: boolean;
  plans: Record<string, string>;
}

function render(build: Builder, testCase: FusionGoldenCase): Rendered {
  const session = sessionWith(testCase.messages);
  const options: Parameters<Builder>[1] = {
    source: testCase.source,
    request: testCase.request,
  };
  if (testCase.toolCallId !== undefined) options.toolCallId = testCase.toolCallId;
  if (testCase.toolName !== undefined) options.toolName = testCase.toolName;
  const built = build(
    { cwd: '/tmp/project', sessionManager: session, getSystemPrompt: () => testCase.systemPrompt },
    options,
  );
  const plans: Record<string, string> = {};
  for (const set of FUSION_GOLDEN_MODEL_SETS) {
    const budget = new FusionBudget(set.models, built.input.conversation_projection.policy.id);
    plans[set.id] = canonicalJson(budget.plan(built.input));
  }
  return {
    serialized: built.serialized,
    ledger: canonicalJson(built.ledger),
    leafPresent: built.transcriptLeafId !== null,
    plans,
  };
}

void describe('fusion shared-projection extraction equivalence', () => {
  for (const testCase of FUSION_GOLDEN_CASES) {
    void it(`produces identical bytes to the pre-extraction oracle: ${testCase.id}`, () => {
      const before = render(buildPreExtraction, testCase);
      const after = render(buildFusionCanonicalInput, testCase);

      assert.equal(
        sha256(after.serialized),
        sha256(before.serialized),
        `canonical-input.json bytes changed for ${testCase.id}`,
      );
      assert.equal(after.serialized, before.serialized);

      assert.equal(
        sha256(after.ledger),
        sha256(before.ledger),
        `context-omission-ledger.json bytes changed for ${testCase.id}`,
      );
      assert.equal(after.ledger, before.ledger);

      assert.equal(after.leafPresent, before.leafPresent);

      assert.deepEqual(Object.keys(after.plans).sort(), Object.keys(before.plans).sort());
      for (const [id, plan] of Object.entries(after.plans)) {
        assert.equal(plan, before.plans[id], `budget-plan.json bytes changed for ${testCase.id}/${id}`);
      }
    });
  }

  void it('produces identical numeric budget fields under Object.is, not just JSON equality', () => {
    for (const testCase of FUSION_GOLDEN_CASES) {
      const session = sessionWith(testCase.messages);
      const options: Parameters<Builder>[1] = {
        source: testCase.source,
        request: testCase.request,
      };
      if (testCase.toolCallId !== undefined) options.toolCallId = testCase.toolCallId;
      if (testCase.toolName !== undefined) options.toolName = testCase.toolName;
      const source = {
        cwd: '/tmp/project',
        sessionManager: session,
        getSystemPrompt: () => testCase.systemPrompt,
      };
      const before = buildPreExtraction(source, options);
      const after = buildFusionCanonicalInput(source, options);
      for (const set of FUSION_GOLDEN_MODEL_SETS) {
        const policyId = after.input.conversation_projection.policy.id;
        const planBefore = new FusionBudget(set.models, policyId).plan(before.input);
        const planAfter = new FusionBudget(set.models, policyId).plan(after.input);
        assert.equal(planAfter.stages.length, planBefore.stages.length);
        for (const [index, stage] of planAfter.stages.entries()) {
          const reference = planBefore.stages[index];
          assert.ok(reference);
          // Object.is catches float drift that JSON rendering would hide.
          assert.ok(
            Object.is(stage.utilization, reference.utilization),
            `utilization float drift for ${testCase.id}/${set.id}/${stage.budget_stage}`,
          );
          assert.ok(Object.is(stage.forecast_utf8_bytes, reference.forecast_utf8_bytes));
          assert.ok(
            Object.is(
              stage.forecast_input_tokens_upper_bound,
              reference.forecast_input_tokens_upper_bound,
            ),
          );
          assert.ok(Object.is(stage.signed_headroom_tokens, reference.signed_headroom_tokens));
          assert.ok(Object.is(stage.allowed_input_tokens, reference.allowed_input_tokens));
          assert.equal(stage.fits, reference.fits);
        }
      }
    }
  });

  void it('preserves the exact accounting record field-for-field', () => {
    for (const testCase of FUSION_GOLDEN_CASES) {
      const session = sessionWith(testCase.messages);
      const options: Parameters<Builder>[1] = {
        source: testCase.source,
        request: testCase.request,
      };
      if (testCase.toolCallId !== undefined) options.toolCallId = testCase.toolCallId;
      if (testCase.toolName !== undefined) options.toolName = testCase.toolName;
      const source = {
        cwd: '/tmp/project',
        sessionManager: session,
        getSystemPrompt: () => testCase.systemPrompt,
      };
      const before = buildPreExtraction(source, options).input.conversation_projection;
      const after = buildFusionCanonicalInput(source, options).input.conversation_projection;
      assert.deepEqual(
        Object.keys(after.accounting).sort(),
        Object.keys(before.accounting).sort(),
        `accounting field set changed for ${testCase.id}`,
      );
      assert.deepEqual(after.accounting, before.accounting);
      assert.deepEqual(after.policy, before.policy);
      assert.deepEqual(after.branch_filter, before.branch_filter);
      assert.equal(
        after.accounting.ledger_root_sha256,
        before.accounting.ledger_root_sha256,
        `ledger root hash changed for ${testCase.id}`,
      );
    }
  });

  void it('preserves the loud unknown-block failure type and message', () => {
    // Unknown block types are rejected at the projection layer, so the two
    // projection engines are compared directly on identical malformed input.
    const unknownBlockMessages: readonly unknown[] = [
      { role: 'assistant', content: [{ type: 'unknown_block_kind' }] },
      { role: 'user', content: [{ type: 'unknown_block_kind' }] },
      {
        role: 'toolResult',
        toolCallId: 'x',
        toolName: 'y',
        isError: false,
        content: [{ type: 'unknown_block_kind' }],
      },
      { role: 'unknown_role_kind', content: [] },
    ];
    for (const message of unknownBlockMessages) {
      const messages = [message] as readonly Message[];
      let beforeMessage: string | undefined;
      let afterMessage: string | undefined;
      try {
        projectPreExtraction(messages, 'tool', BRANCH_FILTER);
      } catch (error) {
        beforeMessage = error instanceof Error ? error.message : String(error);
      }
      try {
        projectFusionConversation(messages, 'tool', BRANCH_FILTER);
      } catch (error) {
        afterMessage = error instanceof Error ? error.message : String(error);
      }
      assert.ok(beforeMessage, 'the pre-extraction oracle must reject unknown blocks loudly');
      assert.equal(
        afterMessage,
        beforeMessage,
        'the extracted transform must reject unknown blocks with the identical message',
      );
      assert.match(afterMessage ?? '', /unsupported conversation block/);
    }
  });

  void it('rejects a blank request identically in both implementations', () => {
    const source = {
      cwd: '/tmp/project',
      sessionManager: { getLeafId: () => null, getLeafEntry: () => undefined, getEntries: () => [] },
      getSystemPrompt: () => 'sys',
    };
    for (const request of ['', '   ', '\n\t']) {
      let beforeMessage: string | undefined;
      let afterMessage: string | undefined;
      let beforeCode: unknown;
      let afterCode: unknown;
      try {
        buildPreExtraction(source, { source: 'tool', request });
      } catch (error) {
        beforeMessage = error instanceof Error ? error.message : String(error);
        beforeCode = Reflect.get(Object(error), 'code');
      }
      try {
        buildFusionCanonicalInput(source, { source: 'tool', request });
      } catch (error) {
        afterMessage = error instanceof Error ? error.message : String(error);
        afterCode = Reflect.get(Object(error), 'code');
      }
      assert.equal(afterMessage, beforeMessage);
      assert.equal(afterCode, beforeCode);
      assert.equal(afterCode, 'context_capture_failed');
    }
  });
});

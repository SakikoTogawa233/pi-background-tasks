import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildFusionCleanTaskCanonicalInput } from '../../src/core/fusion/clean-context.js';
import { buildFusionCanonicalInput } from '../../src/core/fusion/context.js';
import { canonicalJson } from '../../src/core/attested-pi-run.js';
import { sessionWith, userMessage } from '../helpers/fusion-canonical.js';

void describe('fusion v5 context boundaries', () => {
  void it('keeps reason as the only workflow that projects parent conversation', () => {
    const sessionManager = sessionWith([userMessage('visible parent text')]);
    const built = buildFusionCanonicalInput({ cwd: '/repo', sessionManager, getSystemPrompt: () => 'parent system' }, { source: 'tool', request: 'reason about this', toolName: 'fusion_reason' });
    assert.equal(built.input.workflow, 'reason');
    assert.equal(built.input.context?.kind, 'session_projection');
    assert.match(built.serialized, /visible parent text/);
    assert.match(built.serialized, /parent system/);
  });

  void it('clean canonical input is byte-identical across unrelated parent sessions with same request and cwd', () => {
    const request = canonicalJson({ objective: 'inspect', background: [], deliverable: 'answer', scope: [], constraints: [] });
    const left = buildFusionCleanTaskCanonicalInput({ cwd: '/repo', source: 'tool', workflow: 'investigate', request });
    const right = buildFusionCleanTaskCanonicalInput({ cwd: '/repo', source: 'tool', workflow: 'investigate', request });
    assert.equal(left.serialized, right.serialized);
    assert.equal(left.input.context.kind, 'clean_task');
    assert.equal('system_prompt' in left.input, false);
    assert.equal('conversation_projection' in left.input, false);
  });
});

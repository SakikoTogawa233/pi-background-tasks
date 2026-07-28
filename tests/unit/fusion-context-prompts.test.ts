import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import {
  buildFusionCanonicalInput,
  normalizeFusionCommandRequest,
} from '../../src/core/fusion/context.js';
import {
  FUSION_CANDIDATE_SYSTEM_PROMPT,
  FUSION_EVALUATION_REPAIR_SYSTEM_PROMPT,
  buildBlindEvaluationInput,
  buildCandidatePrompt,
  buildEvaluationPrompt,
  buildMergeInput,
  buildMergePrompt,
} from '../../src/core/fusion/prompts.js';
import { FUSION_EVALUATION_SCHEMA_VERSION, type FusionEvaluationV1 } from '../../src/core/fusion/types.js';

function usage() {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function evaluation(): FusionEvaluationV1 {
  return {
    schema_version: FUSION_EVALUATION_SCHEMA_VERSION,
    candidate_assessments: [
      { candidate_id: 'A', summary: 'a', strengths: ['a'], limitations: ['a'], useful_contributions: ['a'], risks: ['a'] },
      { candidate_id: 'B', summary: 'b', strengths: ['b'], limitations: ['b'], useful_contributions: ['b'], risks: ['b'] },
      { candidate_id: 'C', summary: 'c', strengths: ['c'], limitations: ['c'], useful_contributions: ['c'], risks: ['c'] },
    ],
    agreements: ['agree'],
    conflicts: [],
    synthesis_plan: { must_include: [{ candidate_id: 'A', contribution: 'a' }], must_resolve: [], must_avoid: [] },
  };
}

void describe('fusion context and prompts', () => {
  void it('trims only command edges and preserves internal whitespace', () => {
    assert.equal(normalizeFusionCommandRequest('  line one\n\n  line two  '), 'line one\n\n  line two');
  });

  void it('builds deterministic canonical command input', () => {
    const session = SessionManager.inMemory('/tmp/project');
    session.appendMessage({ role: 'user', content: 'hello', timestamp: 1 });
    const built = buildFusionCanonicalInput(
      { cwd: '/tmp/project', sessionManager: session, getSystemPrompt: () => 'system' },
      { source: 'command', request: 'answer' },
    );
    assert.equal(built.input.cwd, '/tmp/project');
    assert.equal(built.input.system_prompt, 'system');
    assert.match(built.input.conversation_transcript, /hello/);
    assert.equal(buildCandidatePrompt(built.input), built.serialized);
    assert.equal(buildCandidatePrompt(built.input), buildCandidatePrompt(built.input));
  });

  void it('serializes image-containing context as explicit text omissions without raw image data', () => {
    const session = SessionManager.inMemory('/tmp/project');
    session.appendMessage({
      role: 'user',
      content: [
        { type: 'text', text: 'user text before image ' },
        { type: 'image', data: 'raw-user-image-base64', mimeType: 'image/png' },
        { type: 'text', text: ' user text after image' },
      ],
      timestamp: 1,
    });
    session.appendMessage({
      role: 'toolResult',
      toolCallId: 'tool-image',
      toolName: 'image_tool',
      content: [
        { type: 'text', text: 'tool text before image ' },
        { type: 'image', data: 'raw-tool-image-base64', mimeType: 'image/jpeg' },
      ],
      details: { ok: true },
      isError: false,
      timestamp: 2,
    });
    const built = buildFusionCanonicalInput(
      { cwd: '/tmp/project', sessionManager: session, getSystemPrompt: () => 'system' },
      { source: 'command', request: 'answer' },
    );
    assert.match(built.input.conversation_transcript, /user text before image/);
    assert.match(built.input.conversation_transcript, /user text after image/);
    assert.match(built.input.conversation_transcript, /\[Image omitted from fusion text transcript: image\/png\]/);
    assert.match(built.input.conversation_transcript, /\[Image omitted from fusion text transcript: image\/jpeg\]/);
    assert.doesNotMatch(built.serialized, /raw-user-image-base64|raw-tool-image-base64/);
  });

  void it('serializes tool results without summarization truncation', () => {
    const session = SessionManager.inMemory('/tmp/project');
    const longText = 'z'.repeat(3000);
    session.appendMessage({ role: 'user', content: 'inspect tool output', timestamp: 1 });
    session.appendMessage({
      role: 'toolResult',
      toolCallId: 'tool-long',
      toolName: 'read',
      content: [{ type: 'text', text: longText }],
      details: { path: 'large.txt' },
      isError: false,
      timestamp: 2,
    });
    const built = buildFusionCanonicalInput(
      { cwd: '/tmp/project', sessionManager: session, getSystemPrompt: () => 'system' },
      { source: 'command', request: 'answer' },
    );
    assert.match(built.input.conversation_transcript, new RegExp(`z{${String(longText.length)}}`));
    assert.doesNotMatch(built.input.conversation_transcript, /truncated/);
  });

  void it('excludes the active tool-call leaf from tool context', () => {
    const session = SessionManager.inMemory('/tmp/project');
    session.appendMessage({ role: 'user', content: 'root question', timestamp: 1 });
    session.appendMessage({
      role: 'assistant',
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      model: 'gpt-5.5',
      usage: usage(),
      stopReason: 'toolUse',
      content: [
        { type: 'text', text: 'partial parent text' },
        { type: 'toolCall', id: 'tool-1', name: 'fusion_brainstorm', arguments: { prompt: 'x' } },
      ],
      timestamp: 2,
    });
    const built = buildFusionCanonicalInput(
      { cwd: '/tmp/project', sessionManager: session, getSystemPrompt: () => 'system' },
      { source: 'tool', request: 'brainstorm', toolCallId: 'tool-1' },
    );
    assert.match(built.input.conversation_transcript, /root question/);
    assert.doesNotMatch(built.input.conversation_transcript, /partial parent text/);
    assert.equal(built.transcriptLeafId, session.getLeafEntry()?.parentId ?? null);
  });

  void it('keeps model metadata out of blind evaluator and merger inputs', () => {
    const session = SessionManager.inMemory('/tmp/project');
    const built = buildFusionCanonicalInput(
      { cwd: '/tmp/project', sessionManager: session, getSystemPrompt: () => 'system' },
      { source: 'command', request: 'request' },
    );
    const anonymous = [
      { candidate_id: 'A' as const, response: 'alpha' },
      { candidate_id: 'B' as const, response: 'beta' },
      { candidate_id: 'C' as const, response: 'gamma' },
    ] as const;
    const blind = buildBlindEvaluationInput(built.input, anonymous);
    const evalPrompt = buildEvaluationPrompt(blind);
    const mergePrompt = buildMergePrompt(buildMergeInput(built.input, anonymous, evaluation()));
    assert.doesNotMatch(evalPrompt, /openai|anthropic|slot|provider|model/i);
    assert.doesNotMatch(mergePrompt, /openai|anthropic|slot|provider|model/i);
    assert.match(FUSION_CANDIDATE_SYSTEM_PROMPT, /same instruction/);
  });

  void it('gives the evaluation repair child the full closed schema and blind constraints', () => {
    assert.match(FUSION_EVALUATION_REPAIR_SYSTEM_PROMPT, new RegExp(FUSION_EVALUATION_SCHEMA_VERSION));
    assert.match(FUSION_EVALUATION_REPAIR_SYSTEM_PROMPT, /candidate_assessments/);
    assert.match(FUSION_EVALUATION_REPAIR_SYSTEM_PROMPT, /Objects must be closed/);
    assert.match(FUSION_EVALUATION_REPAIR_SYSTEM_PROMPT, /Preserve blindness/);
  });
});

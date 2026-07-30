import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import {
  buildFusionCanonicalInput,
  normalizeFusionCommandRequest,
} from '../../src/core/fusion/context.js';
import {
  FUSION_CANDIDATE_SYSTEM_PROMPT,
  FUSION_CANONICAL_INPUT_GUIDE,
  FUSION_EVALUATION_REPAIR_SYSTEM_PROMPT,
  buildBlindEvaluationInput,
  buildCandidatePrompt,
  buildEvaluationPrompt,
  buildMergeInput,
  buildMergePrompt,
} from '../../src/core/fusion/prompts.js';
import {
  FUSION_COMMAND_CONTEXT_POLICY_ID,
  FUSION_CONTEXT_TRANSFORM_ID,
  FUSION_EVALUATION_SCHEMA_VERSION,
  FUSION_INPUT_SCHEMA_VERSION,
  FUSION_TOOL_CONTEXT_POLICY_ID,
  FusionError,
  type FusionEvaluationV1,
} from '../../src/core/fusion/types.js';
import {
  assistantMessage,
  buildFrom,
  entryKinds,
  omissionEntries,
  projectedText,
  testUsage,
  textEntries,
  toolResultMessage,
  userMessage,
} from '../helpers/fusion-canonical.js';

function evaluation(): FusionEvaluationV1 {
  return {
    schema_version: FUSION_EVALUATION_SCHEMA_VERSION,
    candidate_assessments: [
      {
        candidate_id: 'A',
        summary: 'a',
        strengths: ['a'],
        limitations: ['a'],
        useful_contributions: ['a'],
        risks: ['a'],
      },
      {
        candidate_id: 'B',
        summary: 'b',
        strengths: ['b'],
        limitations: ['b'],
        useful_contributions: ['b'],
        risks: ['b'],
      },
      {
        candidate_id: 'C',
        summary: 'c',
        strengths: ['c'],
        limitations: ['c'],
        useful_contributions: ['c'],
        risks: ['c'],
      },
    ],
    agreements: ['agree'],
    conflicts: [],
    synthesis_plan: {
      must_include: [{ candidate_id: 'A', contribution: 'a' }],
      must_resolve: [],
      must_avoid: [],
    },
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

void describe('fusion context projection and prompts', () => {
  void it('trims only command edges and preserves internal whitespace', () => {
    assert.equal(
      normalizeFusionCommandRequest('  line one\n\n  line two  '),
      'line one\n\n  line two',
    );
  });

  void it('builds deterministic v2 canonical command input with an authoritative request', () => {
    const built = buildFrom([userMessage('hello')], { source: 'command', request: 'answer' });
    assert.equal(built.input.schema_version, FUSION_INPUT_SCHEMA_VERSION);
    assert.equal(built.input.cwd, '/tmp/project');
    assert.equal(built.input.system_prompt, 'system');
    assert.equal(built.input.request.text, 'answer');
    assert.equal(built.input.request.source, 'command');
    assert.equal(built.input.request.authority, 'directive_over_projected_conversation');
    assert.equal(built.input.request.sha256, sha256('answer'));
    assert.match(projectedText(built.input), /hello/);
    assert.equal(buildCandidatePrompt(built.input), built.serialized);
    assert.equal(buildCandidatePrompt(built.input), buildCandidatePrompt(built.input));
  });

  void it('marks the tool entry point as explicitly authoritative under its own policy id', () => {
    const toolBuilt = buildFrom([userMessage('hello')], {
      source: 'tool',
      request: 'explicit fusion request',
    });
    assert.equal(toolBuilt.input.request.authority, 'explicit_text');
    assert.equal(
      toolBuilt.input.conversation_projection.policy.id,
      FUSION_TOOL_CONTEXT_POLICY_ID,
    );
    const commandBuilt = buildFrom([userMessage('hello')], {
      source: 'command',
      request: 'command request',
    });
    assert.equal(
      commandBuilt.input.conversation_projection.policy.id,
      FUSION_COMMAND_CONTEXT_POLICY_ID,
    );
    // Both entry points share the same payload-exclusion transform.
    assert.equal(
      toolBuilt.input.conversation_projection.policy.transform,
      FUSION_CONTEXT_TRANSFORM_ID,
    );
    assert.equal(
      commandBuilt.input.conversation_projection.policy.transform,
      FUSION_CONTEXT_TRANSFORM_ID,
    );
    assert.equal(toolBuilt.input.conversation_projection.policy.tool_payload_preview_bytes, 0);
  });

  void it('keeps a >1 MB tool-heavy session bounded while preserving all conversational text', () => {
    const hugeArgs = 'A'.repeat(600_000);
    const hugeResult = 'R'.repeat(700_000);
    const thinking = 'T'.repeat(20_000);
    const built = buildFrom(
      [
        userMessage('USER-SENTINEL question about the repository'),
        assistantMessage([
          { type: 'thinking', thinking },
          { type: 'text', text: 'ASSISTANT-SENTINEL visible reasoning summary' },
          { type: 'toolCall', id: 'call-read', name: 'read', arguments: { blob: hugeArgs } },
        ]),
        toolResultMessage('call-read', 'read', [{ type: 'text', text: hugeResult }]),
        userMessage('USER-SENTINEL-2 follow-up', 4),
      ],
      { source: 'tool', request: 'summarize' },
    );

    // Conversational text survives verbatim.
    const text = projectedText(built.input);
    assert.match(text, /USER-SENTINEL question about the repository/);
    assert.match(text, /ASSISTANT-SENTINEL visible reasoning summary/);
    assert.match(text, /USER-SENTINEL-2 follow-up/);

    // Bulky payloads and thinking never reach the prompt.
    assert.doesNotMatch(built.serialized, /A{100}/);
    assert.doesNotMatch(built.serialized, /R{100}/);
    assert.doesNotMatch(built.serialized, /T{100}/);

    // Result is orders of magnitude smaller than the 1.3 MB of raw payload.
    assert.ok(
      built.serialized.length < 20_000,
      `canonical input must stay small, saw ${String(built.serialized.length)}`,
    );

    const accounting = built.input.conversation_projection.accounting;
    assert.equal(accounting.omitted_tool_call_argument_bytes, Buffer.byteLength(
      JSON.stringify({ blob: hugeArgs }),
      'utf8',
    ));
    assert.equal(accounting.omitted_tool_result_text_bytes, hugeResult.length);
    assert.equal(accounting.omitted_thinking_bytes, thinking.length);
    assert.equal(accounting.omitted_tool_call_count, 1);
    assert.equal(accounting.omitted_tool_result_text_count, 1);
    assert.deepEqual(accounting.tool_call_names, [{ name: 'read', calls: 1 }]);
  });

  void it('produces byte-identical canonical input and stable hashes across repeated construction', () => {
    const messages = [
      userMessage('repeatable question'),
      assistantMessage([
        { type: 'thinking', thinking: 'hidden' },
        { type: 'text', text: 'visible' },
        { type: 'toolCall', id: 'c1', name: 'bash', arguments: { command: 'ls', z: 1, a: 2 } },
      ]),
      toolResultMessage('c1', 'bash', [{ type: 'text', text: 'file listing' }]),
    ];
    const first = buildFrom(messages, { source: 'tool', request: 'again' });
    const second = buildFrom(messages, { source: 'tool', request: 'again' });
    assert.equal(first.serialized, second.serialized);
    assert.equal(
      first.input.conversation_projection.accounting.ledger_root_sha256,
      second.input.conversation_projection.accounting.ledger_root_sha256,
    );
    assert.deepEqual(first.ledger, second.ledger);
  });

  void it('changes only the affected hashes when an omitted payload byte changes', () => {
    const base = buildFrom(
      [toolResultMessage('c1', 'read', [{ type: 'text', text: 'payload-a' }])],
      { source: 'tool', request: 'r' },
    );
    const mutated = buildFrom(
      [toolResultMessage('c1', 'read', [{ type: 'text', text: 'payload-b' }])],
      { source: 'tool', request: 'r' },
    );
    const baseRoot = base.input.conversation_projection.accounting.ledger_root_sha256;
    const mutatedRoot = mutated.input.conversation_projection.accounting.ledger_root_sha256;
    assert.notEqual(baseRoot, mutatedRoot);
    // Same byte length, so the declared accounting is unchanged; only hashes move.
    assert.equal(
      base.input.conversation_projection.accounting.omitted_tool_result_text_bytes,
      mutated.input.conversation_projection.accounting.omitted_tool_result_text_bytes,
    );
    // The payload itself is never exposed by the hash.
    assert.doesNotMatch(base.serialized, /payload-a/);
    assert.doesNotMatch(mutated.serialized, /payload-b/);
  });

  void it('records omitted payload hashes that match the exact omitted bytes', () => {
    const built = buildFrom(
      [toolResultMessage('c1', 'read', [{ type: 'text', text: 'exact-omitted-bytes' }])],
      { source: 'tool', request: 'r' },
    );
    const row = built.ledger.entries.find((entry) => entry.kind === 'tool_result_text');
    assert.ok(row, 'tool result must produce a ledger row');
    assert.equal(row.payload_sha256, sha256('exact-omitted-bytes'));
    assert.equal(row.payload_bytes, 'exact-omitted-bytes'.length);
    assert.equal(row.tool_name, 'read');
    assert.equal(row.tool_call_id, 'c1');
  });

  void it('collapses contiguous omissions into deterministic source-ordered runs', () => {
    const built = buildFrom(
      [
        userMessage('first'),
        assistantMessage([
          { type: 'toolCall', id: 'c1', name: 't1', arguments: {} },
          { type: 'toolCall', id: 'c2', name: 't2', arguments: {} },
        ]),
        toolResultMessage('c1', 't1', [{ type: 'text', text: 'r1' }], 3),
        toolResultMessage('c2', 't2', [{ type: 'text', text: 'r2' }], 4),
        userMessage('second', 5),
      ],
      { source: 'tool', request: 'r' },
    );
    // text, one collapsed omission run, text
    assert.deepEqual(entryKinds(built.input), ['text', 'omitted_activity', 'text']);
    const runs = omissionEntries(built.input);
    assert.equal(runs.length, 1);
    const run = runs[0];
    assert.ok(run);
    assert.equal(run.counts.tool_calls, 2);
    assert.equal(run.counts.tool_result_texts, 2);
    assert.equal(run.ledger_index_first, 0);
    assert.equal(run.ledger_index_last, 3);
    assert.equal(run.source_ordinal_first, 1);
    assert.equal(run.source_ordinal_last, 3);
    assert.equal(built.input.conversation_projection.accounting.omitted_event_count, 4);
    assert.equal(built.ledger.entries.length, 4);
    // Ledger indices are dense and in source order.
    assert.deepEqual(
      built.ledger.entries.map((entry) => entry.index),
      [0, 1, 2, 3],
    );
  });

  void it('never carries a head, tail, or preview of omitted tool payloads', () => {
    const payload = `HEAD-SENTINEL${'x'.repeat(400)}TAIL-SENTINEL`;
    const built = buildFrom(
      [
        assistantMessage([
          { type: 'toolCall', id: 'c1', name: 'read', arguments: { probe: payload } },
        ]),
        toolResultMessage('c1', 'read', [{ type: 'text', text: payload }]),
      ],
      { source: 'tool', request: 'r' },
    );
    for (const sentinel of ['HEAD-SENTINEL', 'TAIL-SENTINEL', 'xxxxxxxxxx']) {
      assert.doesNotMatch(built.serialized, new RegExp(sentinel), sentinel);
    }
    assert.equal(built.input.conversation_projection.policy.tool_payload_preview_bytes, 0);
  });

  void it('keeps user and tool-result images marker-only or ledger-only without raw bytes', () => {
    const built = buildFrom(
      [
        userMessage([
          { type: 'text', text: 'user text before image ' },
          { type: 'image', data: 'raw-user-image-base64', mimeType: 'image/png' },
          { type: 'text', text: ' user text after image' },
        ]),
        toolResultMessage('tool-image', 'image_tool', [
          { type: 'text', text: 'tool text before image ' },
          { type: 'image', data: 'raw-tool-image-base64', mimeType: 'image/jpeg' },
        ]),
      ],
      { source: 'command', request: 'answer' },
    );
    const text = projectedText(built.input);
    assert.match(text, /user text before image/);
    assert.match(text, /user text after image/);
    assert.match(text, /\[Image omitted from fusion text transcript: image\/png\]/);
    assert.doesNotMatch(built.serialized, /raw-user-image-base64|raw-tool-image-base64/);
    // Tool-result images are ledger-only under the payload-exclusion transform.
    assert.equal(built.input.conversation_projection.accounting.omitted_tool_result_image_count, 1);
    const imageRow = built.ledger.entries.find((entry) => entry.kind === 'tool_result_image');
    assert.ok(imageRow);
    assert.equal(imageRow.mime_type, 'image/jpeg');
    assert.equal(built.input.conversation_projection.accounting.included_image_marker_count, 1);
  });

  void it('excludes the active tool-call leaf and its sibling calls from tool context', () => {
    const session = SessionManager.inMemory('/tmp/project');
    session.appendMessage({ role: 'user', content: 'root question', timestamp: 1 });
    session.appendMessage({
      role: 'assistant',
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      model: 'gpt-5.5',
      usage: testUsage(),
      stopReason: 'toolUse',
      content: [
        { type: 'text', text: 'partial parent text' },
        { type: 'toolCall', id: 'tool-1', name: 'fusion_brainstorm', arguments: { prompt: 'x' } },
        { type: 'toolCall', id: 'tool-sibling', name: 'bg_status', arguments: {} },
      ],
      timestamp: 2,
    });
    const built = buildFusionCanonicalInput(
      { cwd: '/tmp/project', sessionManager: session, getSystemPrompt: () => 'system' },
      { source: 'tool', request: 'brainstorm', toolCallId: 'tool-1' },
    );
    assert.match(projectedText(built.input), /root question/);
    assert.doesNotMatch(built.serialized, /partial parent text/);
    assert.doesNotMatch(built.serialized, /tool-sibling|bg_status/);
    assert.equal(built.input.conversation_projection.branch_filter.active_tool_call_leaf_excluded, true);
    assert.equal(built.input.conversation_projection.branch_filter.tool_call_id, 'tool-1');
    assert.equal(built.transcriptLeafId, session.getLeafEntry()?.parentId ?? null);
    // The excluded subtree contributes no ledger rows either.
    assert.equal(built.ledger.entries.length, 0);
  });

  void it('rejects a blank request before doing projection work', () => {
    assert.throws(
      () => buildFrom([userMessage('x')], { source: 'tool', request: '   ' }),
      (error: unknown) =>
        error instanceof FusionError &&
        error.code === 'context_capture_failed' &&
        error.childCreated === false,
    );
  });

  void it('keeps model metadata out of blind evaluator and merger inputs', () => {
    const built = buildFrom([], { source: 'command', request: 'request' });
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

  void it('tells children how to read the projection and its explicit omissions', () => {
    assert.match(FUSION_CANONICAL_INPUT_GUIDE, /omitted_activity/);
    assert.match(FUSION_CANONICAL_INPUT_GUIDE, /explicit_text/);
    assert.match(FUSION_CANONICAL_INPUT_GUIDE, /do not guess their contents/);
    assert.match(FUSION_CANONICAL_INPUT_GUIDE, /untrusted data/);
    assert.match(FUSION_CANDIDATE_SYSTEM_PROMPT, /omitted_activity/);
  });

  void it('gives the evaluation repair child the full closed schema and blind constraints', () => {
    assert.match(
      FUSION_EVALUATION_REPAIR_SYSTEM_PROMPT,
      new RegExp(FUSION_EVALUATION_SCHEMA_VERSION),
    );
    assert.match(FUSION_EVALUATION_REPAIR_SYSTEM_PROMPT, /candidate_assessments/);
    assert.match(FUSION_EVALUATION_REPAIR_SYSTEM_PROMPT, /Objects must be closed/);
    assert.match(FUSION_EVALUATION_REPAIR_SYSTEM_PROMPT, /Preserve blindness/);
  });

  void it('gives every retained block exactly one disposition', () => {
    const built = buildFrom(
      [
        userMessage([
          { type: 'text', text: 'u1' },
          { type: 'image', data: 'img', mimeType: 'image/png' },
        ]),
        assistantMessage([
          { type: 'text', text: 'a1' },
          { type: 'thinking', thinking: 'th' },
          { type: 'toolCall', id: 'c1', name: 't', arguments: {} },
        ]),
        toolResultMessage('c1', 't', [
          { type: 'text', text: 'r' },
          { type: 'image', data: 'i2', mimeType: 'image/gif' },
        ]),
      ],
      { source: 'tool', request: 'r' },
    );
    const accounting = built.input.conversation_projection.accounting;
    // 2 user blocks + 3 assistant blocks + 2 tool-result blocks = 7 source blocks.
    const included = textEntries(built.input).length;
    const omitted = accounting.omitted_event_count;
    assert.equal(included + omitted + accounting.empty_text_block_count, 7);
    assert.equal(included, 3); // u1, image marker, a1
    assert.equal(omitted, 4); // thinking, tool call, tool result text, tool result image
  });
});

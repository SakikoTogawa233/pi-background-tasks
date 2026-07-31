import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalJson } from '../../src/core/attested-pi-run.js';
import {
  FUSION_CANDIDATE_MAX_OUTPUT_BYTES,
  FUSION_DIAGNOSTICS_MAX_BYTES,
  FUSION_EVALUATION_MAX_OUTPUT_BYTES,
  fusionTokenUpperBound,
} from '../../src/core/fusion/budget.js';
import type { FusionProjectionOmissionEntry } from '../../src/core/fusion/types.js';
import { buildFrom, omissionEntries, projectedText } from '../helpers/fusion-canonical.js';
import { buildHighCardinalitySession } from '../helpers/fusion-high-cardinality.js';

/**
 * Regression coverage for the production incident in which omission receipts
 * grew to 43% of a 290 KB projected prompt (340 runs over 1,465 omitted
 * events). Existing fixtures used a few very large tool results and therefore
 * could not reproduce it: the cost came from receipt cardinality, not payload
 * size.
 */
void describe('fusion high-cardinality tool activity', () => {
  void it('keeps receipt metadata small when omitted events are numerous and short', () => {
    const session = buildHighCardinalitySession();
    const built = buildFrom(session.messages, { source: 'tool', request: 'summarize' });
    const projection = built.input.conversation_projection;
    const receipts = omissionEntries(built.input);

    // One receipt per retained-text separated run, and every event ledgered.
    assert.equal(receipts.length, session.expectedRuns);
    assert.equal(built.ledger.entries.length, session.expectedLedgerEvents);
    assert.equal(projection.accounting.omitted_run_count, session.expectedRuns);
    assert.equal(projection.accounting.omitted_event_count, session.expectedLedgerEvents);

    // Per-receipt cost is the quantity that regressed: the incident averaged
    // 356 bytes per receipt because each carried a run hash, ledger indices,
    // and a per-kind byte map. Pin the compact cost directly, since the ratio
    // to total payload depends on how much visible text a fixture happens to
    // contain and is therefore not a stable signal.
    const receiptBytes = projection.accounting.omission_receipt_utf8_bytes;
    const perReceipt = receiptBytes / receipts.length;
    assert.ok(
      perReceipt < 140,
      `each receipt must stay compact, saw ${perReceipt.toFixed(1)} bytes`,
    );

    // Receipt metadata must never exceed the conversational text it annotates.
    const visibleBytes =
      projection.accounting.included_user_text_bytes +
      projection.accounting.included_assistant_text_bytes;
    assert.ok(
      receiptBytes < visibleBytes,
      `receipts (${String(receiptBytes)} B) must not outweigh visible text (${String(visibleBytes)} B)`,
    );
  });

  void it('emits only the compact model-facing receipt fields', () => {
    const session = buildHighCardinalitySession({ runs: 8 });
    const built = buildFrom(session.messages, { source: 'tool', request: 'r' });
    for (const receipt of omissionEntries(built.input)) {
      assert.deepEqual(Object.keys(receipt).sort(), ['at', 'bytes', 'counts', 'kind']);
      assert.equal(receipt.kind, 'omitted_activity');
      assert.equal(receipt.at.length, 2);
      assert.ok(receipt.at[0] <= receipt.at[1]);
      assert.ok(Number.isSafeInteger(receipt.bytes) && receipt.bytes >= 0);
      for (const key of Object.keys(receipt.counts)) {
        assert.ok(
          ['assistant_thinking', 'tool_calls', 'tool_result_texts'].includes(key),
          `unexpected count key ${key}`,
        );
      }
      // Zero-valued kinds must be absent, never serialized as zero.
      for (const value of Object.values(receipt.counts)) {
        assert.ok(typeof value === 'number' && value > 0, 'zero counts must be absent');
      }
    }
    // Retired coordinates and hashes must not reappear in the prompt bytes.
    for (const banned of [
      'ledger_run_sha256',
      'ledger_index_first',
      'ledger_index_last',
      'source_ordinal_first',
      'payload_bytes',
    ]) {
      assert.doesNotMatch(built.serialized, new RegExp(banned), banned);
    }
  });

  void it('reconciles every receipt against the ledger it summarizes', () => {
    const session = buildHighCardinalitySession({ runs: 12 });
    const built = buildFrom(session.messages, { source: 'tool', request: 'r' });
    const map = built.ledger.projection_map;

    // Every ledger row is represented exactly once.
    const covered = new Set<number>();
    for (const entry of map) {
      for (let i = entry.ledger_index_first; i <= entry.ledger_index_last; i++) {
        assert.equal(covered.has(i), false, `ledger row ${String(i)} mapped twice`);
        covered.add(i);
      }
    }
    assert.equal(covered.size, built.ledger.entries.length);

    // Receipt byte totals recompute exactly from the mapped ledger rows.
    const receipts = omissionEntries(built.input);
    const receiptMaps = map.filter((entry) => entry.entry_kind === 'omitted_activity');
    assert.equal(receiptMaps.length, receipts.length);
    for (const [index, entry] of receiptMaps.entries()) {
      const rows = built.ledger.entries.slice(
        entry.ledger_index_first,
        entry.ledger_index_last + 1,
      );
      const expected = rows
        .filter((row) => row.kind !== 'tool_result_image')
        .reduce((total, row) => total + row.payload_bytes, 0);
      const receipt = receipts[index];
      assert.ok(receipt);
      assert.equal(receipt.bytes, expected, `receipt ${String(index)} byte total mismatch`);
    }
  });

  void it('preserves all conversational text and forwards no tool payload', () => {
    const session = buildHighCardinalitySession({ runs: 20 });
    const built = buildFrom(session.messages, { source: 'tool', request: 'r' });
    const text = projectedText(built.input);
    for (let run = 0; run < 20; run++) {
      assert.match(text, new RegExp(`USER-TURN-${String(run)} `));
      assert.match(text, new RegExp(`ASSISTANT-TURN-${String(run)} `));
    }
    // Payload and thinking sentinels never reach the prompt.
    assert.doesNotMatch(built.serialized, /g{50}/);
    assert.doesNotMatch(built.serialized, /z{50}/);
    assert.doesNotMatch(built.serialized, /k{50}/);
  });

  void it('keeps the whole workflow inside a real route budget at contract maxima', () => {
    const session = buildHighCardinalitySession();
    const built = buildFrom(session.messages, { source: 'tool', request: 'summarize' });
    const canonical = Buffer.byteLength(built.serialized, 'utf8');
    // Mirrors the limiting route from the incident: 272,000-token window.
    const allowed = 231_040;
    const wrapper = 16 * 1024;
    const stages: Array<[string, number]> = [
      ['candidate', canonical],
      ['evaluation', canonical + 3 * FUSION_CANDIDATE_MAX_OUTPUT_BYTES + wrapper],
      [
        'merge',
        canonical +
          3 * FUSION_CANDIDATE_MAX_OUTPUT_BYTES +
          FUSION_EVALUATION_MAX_OUTPUT_BYTES +
          wrapper,
      ],
      [
        'evaluation_repair',
        canonical +
          3 * FUSION_CANDIDATE_MAX_OUTPUT_BYTES +
          FUSION_EVALUATION_MAX_OUTPUT_BYTES +
          FUSION_DIAGNOSTICS_MAX_BYTES +
          wrapper,
      ],
    ];
    for (const [stage, bytes] of stages) {
      const tokens = fusionTokenUpperBound(bytes);
      assert.ok(
        tokens <= allowed,
        `${stage} must fit the limiting route, saw ${String(tokens)} of ${String(allowed)}`,
      );
    }
  });

  void it('produces byte-identical output for repeated construction', () => {
    const session = buildHighCardinalitySession({ runs: 30 });
    const first = buildFrom(session.messages, { source: 'tool', request: 'same' });
    const second = buildFrom(session.messages, { source: 'tool', request: 'same' });
    assert.equal(first.serialized, second.serialized);
    assert.equal(canonicalJson(first.ledger), canonicalJson(second.ledger));
    const receipts: readonly FusionProjectionOmissionEntry[] = omissionEntries(first.input);
    assert.equal(receipts.length, session.expectedRuns);
  });
});

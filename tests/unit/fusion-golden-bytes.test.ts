import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  FUSION_GOLDEN_CASES,
  computeFusionGoldenCorpus,
  serializeFusionGoldenCorpus,
} from '../helpers/fusion-golden-corpus.js';

/**
 * Fusion artifact-byte immutability gate.
 *
 * Fusion's persisted artifact bytes are a frozen format. This gate renders an
 * exhaustive differential corpus through the live implementation and compares
 * the raw bytes against a committed golden file. Any refactor that moves,
 * shares, or "cleans up" the projection or budget engine must leave these bytes
 * bit-identical, or this gate fails.
 *
 * The golden file is deliberately NOT auto-updated when it already exists.
 */
const goldenPath = fileURLToPath(new URL('../fixtures/fusion-golden-bytes.json', import.meta.url));

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

void describe('fusion artifact byte immutability', () => {
  void it('matches the committed golden corpus byte-for-byte', async () => {
    const serialized = serializeFusionGoldenCorpus();
    if (!existsSync(goldenPath)) {
      await writeFile(goldenPath, serialized, 'utf8');
      return;
    }
    const committed = await readFile(goldenPath, 'utf8');
    assert.equal(
      sha256(serialized),
      sha256(committed),
      'Fusion artifact bytes changed. This is a breaking change to a frozen format, not a refactor detail. Diff tests/fixtures/fusion-golden-bytes.json against the recomputed corpus before doing anything else.',
    );
    // Byte-level comparison, not just the digest, so the failure output is useful.
    assert.equal(serialized, committed);
  });

  void it('produces byte-identical output across repeated construction in one process', () => {
    const first = serializeFusionGoldenCorpus();
    const second = serializeFusionGoldenCorpus();
    assert.equal(first, second);
  });

  void it('covers every documented projection and budget branch', () => {
    const ids = FUSION_GOLDEN_CASES.map((testCase) => testCase.id);
    assert.equal(new Set(ids).size, ids.length, 'golden case ids must be unique');
    for (const required of [
      'empty-conversation',
      'omission-only',
      'omission-at-start',
      'omission-at-end',
      'cross-message-contiguous-run',
      'adjacent-tool-result-images-coalesce',
      'image-splits-omission-run',
      'non-adjacent-tool-result-images',
      'repeated-and-unsorted-tool-names',
      'unicode-heavy-visible-text',
      'unicode-heavy-omitted-payload',
      'active-tool-call-leaf-excluded',
      'command-source-authority',
      'tool-source-with-tool-call-id',
    ]) {
      assert.ok(ids.includes(required), `golden corpus must cover ${required}`);
    }
  });

  void it('never emits raw image bytes into canonical input or ledger', () => {
    for (const record of computeFusionGoldenCorpus()) {
      for (const marker of ['IMG1', 'IMG2', 'IMG3', 'MID', 'MIX', 'AAAA']) {
        assert.ok(
          !record.canonical_input.includes(marker),
          `${record.case_id} canonical input must not contain raw image bytes (${marker})`,
        );
        assert.ok(
          !record.context_ledger.includes(marker),
          `${record.case_id} ledger must not contain raw image bytes (${marker})`,
        );
      }
    }
  });

  void it('never leaks omitted payload text into canonical input', () => {
    for (const record of computeFusionGoldenCorpus()) {
      for (const secret of ['secret reasoning', 'payload one', 'payload two', 'only result']) {
        assert.ok(
          !record.canonical_input.includes(secret),
          `${record.case_id} canonical input must not contain omitted payload ${secret}`,
        );
      }
    }
  });
});

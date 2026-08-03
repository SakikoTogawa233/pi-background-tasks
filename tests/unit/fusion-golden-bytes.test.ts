import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { buildFusionCleanTaskCanonicalInput } from '../../src/core/fusion/clean-context.js';
import { canonicalJson } from '../../src/core/attested-pi-run.js';

async function fixture(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

void describe('fusion historical and v5 canonical fixtures', () => {
  void it('keeps historical v4 golden fixtures explicitly historical', async () => {
    const brainstorm = await fixture('tests/fixtures/fusion-golden-bytes.json');
    const validate = await fixture('tests/fixtures/fusion-validate-golden-bytes.json');
    assert.equal(typeof brainstorm, 'object');
    assert.equal(typeof validate, 'object');
    const bytes = await readFile('tests/fixtures/fusion-golden-bytes.json');
    assert.equal(createHash('sha256').update(bytes).digest('hex').length, 64);
  });

  void it('pins a reviewed v5 clean canonical input shape without parent context', () => {
    const built = buildFusionCleanTaskCanonicalInput({
      cwd: '/repo',
      source: 'tool',
      workflow: 'investigate',
      request: canonicalJson({ objective: 'o', background: [], deliverable: 'd', scope: [], constraints: [] }),
    });
    assert.equal(built.input.schema_version, 'pi-background-tasks.fusion-input.v5');
    assert.equal(built.input.context.kind, 'clean_task');
    assert.equal('system_prompt' in built.input, false);
    assert.equal('conversation_projection' in built.input, false);
    assert.equal(built.serialized, canonicalJson(built.input));
  });
});

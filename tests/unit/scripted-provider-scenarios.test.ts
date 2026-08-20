import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseScenario } from '../scripted-provider/scripted-provider-extension.js';

void describe('scripted provider scenario selection', () => {
  void it('supports only the packaged background-task scenarios', () => {
    for (const scenario of [
      'bg-run-follow-up',
      'notify-false',
      'wake-false',
      'failed-follow-up',
      'display-only-bg',
      'foreground-bash-follow-up',
      'foreground-bash-manual-pty',
      'json-tool-telemetry',
    ]) {
      assert.equal(parseScenario(scenario), scenario);
    }
  });

  void it('falls back to the default scenario for removed or unknown values', () => {
    assert.equal(parseScenario(undefined), 'bg-run-follow-up');
    assert.equal(parseScenario(''), 'bg-run-follow-up');
    assert.equal(parseScenario('fusion-reason'), 'bg-run-follow-up');
  });
});

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { resolve } from 'node:path';
import { PTY_SKIP_REASON, ptyInputSupported, runExpect } from '../helpers/pty-harness.js';

const extensionPath = resolve('extensions/background-tasks.ts');
const scriptedProviderPath = resolve('tests/scripted-provider/scripted-provider-extension.ts');

function foregroundOptions(scenario: 'foreground-bash-follow-up' | 'foreground-bash-manual-pty') {
  return {
    extensionPaths: [scriptedProviderPath, extensionPath],
    model: 'pi-bg-scripted/scripted-model',
    env: {
      PI_BG_SCRIPTED_API_KEY: 'scripted-api-key',
      PI_BG_SCRIPTED_SCENARIO: scenario,
    },
  } as const;
}

void describe('foreground bash interactive PTY production E2E', { concurrency: false }, () => {
  void it(
    'sends real ASCII STX Ctrl+B only after the running sentinel and adopts the live command',
    { timeout: 45_000 },
    async (t) => {
      if (!(await ptyInputSupported())) {
        t.skip(PTY_SKIP_REASON);
        return;
      }
      const output = await runExpect(
        `
send "Run the manual foreground bash scenario."
send "\\r"
expect {
  -re "FG_MANUAL_RUNNING_SENTINEL" {}
  timeout { puts "FOREGROUND_MANUAL_SENTINEL_TIMEOUT"; exit 51 }
}
send "\\002"
expect {
  -re "backgrounded(.|\\n)*b[0-9a-f]+|b[0-9a-f]+(.|\\n)*backgrounded" {}
  timeout { puts "FOREGROUND_MANUAL_HANDOFF_TIMEOUT"; exit 52 }
}
expect {
  -re "\\[bg completed\\]" {}
  timeout { puts "FOREGROUND_MANUAL_COMPLETION_TIMEOUT"; exit 53 }
}
`,
        35,
        undefined,
        foregroundOptions('foreground-bash-manual-pty'),
      );
      assert.match(output, /FG_MANUAL_RUNNING_SENTINEL|Ctrl\+B/);
      assert.match(output, /backgrounded/i);
      assert.match(output, /\[bg completed\]/);
    },
  );

  void it(
    'auto-backgrounds at public timeout:1 without a keypress',
    { timeout: 45_000 },
    async (t) => {
      if (!(await ptyInputSupported())) {
        t.skip(PTY_SKIP_REASON);
        return;
      }
      const output = await runExpect(
        `
send "Run the automatic foreground bash scenario."
send "\\r"
expect {
  -re "FG_AUTO_RUNNING_SENTINEL" {}
  timeout { puts "FOREGROUND_AUTO_SENTINEL_TIMEOUT"; exit 54 }
}
expect {
  -re "backgrounded(.|\\n)*b[0-9a-f]+|b[0-9a-f]+(.|\\n)*backgrounded" {}
  timeout { puts "FOREGROUND_AUTO_HANDOFF_TIMEOUT"; exit 55 }
}
expect {
  -re "\\[bg completed\\]" {}
  timeout { puts "FOREGROUND_AUTO_COMPLETION_TIMEOUT"; exit 56 }
}
`,
        35,
        undefined,
        foregroundOptions('foreground-bash-follow-up'),
      );
      assert.match(output, /FG_AUTO_RUNNING_SENTINEL/);
      assert.match(output, /backgrounded/i);
      assert.match(output, /\[bg completed\]/);
    },
  );

  void it('treats idle Ctrl+B as a no-op without creating a task or breaking the TUI', { timeout: 35_000 }, async (t) => {
    if (!(await ptyInputSupported())) {
      t.skip(PTY_SKIP_REASON);
      return;
    }
    const output = await runExpect(
      `
send "\\002"
after 250
send "/jobs"
send "\\r"
expect {
  -re "No background tasks" {}
  timeout { puts "FOREGROUND_IDLE_JOBS_TIMEOUT"; exit 57 }
}
`,
      25,
    );
    assert.match(output, /No background tasks/);
    assert.doesNotMatch(output, /Started background task|\bb[0-9a-f]{8}\b/);
    assert.doesNotMatch(output, /Shortcut handler error|TypeError|uncaught/i);
  });

  void it(
    'keeps the adopted process alive when Escape and editor input arrive after handoff',
    { timeout: 45_000 },
    async (t) => {
      if (!(await ptyInputSupported())) {
        t.skip(PTY_SKIP_REASON);
        return;
      }
      const output = await runExpect(
        `
send "Run the manual ownership foreground bash scenario."
send "\\r"
expect {
  -re "FG_MANUAL_RUNNING_SENTINEL" {}
  timeout { puts "FOREGROUND_OWNERSHIP_SENTINEL_TIMEOUT"; exit 58 }
}
send "\\002"
expect {
  -re "backgrounded(.|\\n)*b[0-9a-f]+|b[0-9a-f]+(.|\\n)*backgrounded" {}
  timeout { puts "FOREGROUND_OWNERSHIP_HANDOFF_TIMEOUT"; exit 59 }
}
send "\\033"
send "ownership-input-must-not-kill-task"
after 100
send "\\025"
expect {
  -re "\\[bg completed\\]" {}
  timeout { puts "FOREGROUND_OWNERSHIP_COMPLETION_TIMEOUT"; exit 60 }
}
`,
        35,
        undefined,
        foregroundOptions('foreground-bash-manual-pty'),
      );
      assert.match(output, /backgrounded/i);
      assert.match(output, /\[bg completed\]/);
      assert.doesNotMatch(output, /\[bg killed\]|Command aborted/i);
    },
  );
});

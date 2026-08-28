import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import {
  createTmuxTuiHarness,
  resolveRealPiBinary,
  type TmuxTuiHarness,
} from '../helpers/tmux-tui-harness.js';

const extensionPath = resolve('extensions/background-tasks.ts');
const scriptedProviderPath = resolve('tests/scripted-provider/scripted-provider-extension.ts');

interface FooterSnapshot {
  readonly lines: string[];
  readonly pwdIndex: number;
  readonly pwdLine: string;
  readonly statsLine: string;
}

function footerSnapshot(screen: string): FooterSnapshot {
  const lines = screen.split('\n');
  let statsIndex = -1;
  for (let index = lines.length - 1; index >= 0; index--) {
    if (lines[index]?.includes('scripted-model')) {
      statsIndex = index;
      break;
    }
  }
  assert.ok(statsIndex > 0, `native footer model line missing\n${screen}`);
  const pwdIndex = statsIndex - 1;
  const pwdLine = lines[pwdIndex];
  const statsLine = lines[statsIndex];
  assert.ok(pwdLine);
  assert.ok(statsLine);
  return { lines, pwdIndex, pwdLine, statsLine };
}

function assertNativeFooterUnchanged(
  baseline: FooterSnapshot,
  current: FooterSnapshot,
): void {
  assert.equal(current.pwdLine, baseline.pwdLine);
  assert.equal(current.statsLine, baseline.statsLine);
}

function assertDedicatedRow(
  baseline: FooterSnapshot,
  screen: string,
  expectedText: string,
): void {
  const current = footerSnapshot(screen);
  assertNativeFooterUnchanged(baseline, current);
  const rowIndex = current.lines.findIndex((line) => line.includes(expectedText));
  assert.equal(
    rowIndex,
    current.pwdIndex - 1,
    `task row must be immediately above the native footer\n${screen}`,
  );
  assert.match(
    current.lines[rowIndex - 1] ?? '',
    /[─╭╮╰╯]/u,
    `task row must follow the editor border\n${screen}`,
  );
  assert.equal(
    current.lines.filter((line) => line.includes(expectedText)).length,
    1,
    `task label must render exactly once\n${screen}`,
  );
}

async function waitForCurrentScreen(
  harness: TmuxTuiHarness,
  predicate: (screen: string) => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<string> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const screen = harness.capture();
    if (predicate(screen)) return screen;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error(`Timed out waiting for ${description}\n${harness.capture()}`);
}

async function statusRowHarness(
  t: TestContext,
  cols: number,
): Promise<TmuxTuiHarness> {
  const harness = await createTmuxTuiHarness({
    command: [
      resolveRealPiBinary(),
      '--offline',
      '--no-session',
      '--no-extensions',
      '-e',
      scriptedProviderPath,
      '-e',
      extensionPath,
      '--no-skills',
      '--no-prompt-templates',
      '--no-context-files',
      '--no-themes',
      '--model',
      'pi-bg-scripted/scripted-model',
    ],
    env: {
      PI_BG_SCRIPTED_API_KEY: 'scripted-api-key',
    },
    cols,
    rows: 24,
  });
  t.after(async () => harness.cleanup());
  await harness.start();
  return harness;
}

void describe('dedicated background status row in real Pi TUI', { concurrency: false }, () => {
  void it(
    'renders above the unchanged native footer at wide and narrow widths, then clears without a spacer',
    { timeout: 60_000 },
    async (t) => {
      for (const cols of [120, 52]) {
        const harness = await statusRowHarness(t, cols);
        const baseline = footerSnapshot(harness.capture());
        harness.sendText(
          `/bg --name "Tmux Row ${String(cols)}" node -e ${JSON.stringify('setTimeout(() => {}, 2500)')}`,
        );
        harness.sendKeys('Enter');
        await harness.waitFor(new RegExp(`Started Tmux Row ${String(cols)}`), `task start at ${String(cols)} columns`);
        const running = await waitForCurrentScreen(
          harness,
          (screen) => screen.includes('bg 1 running · Shift↓'),
          `running dedicated row at ${String(cols)} columns`,
        );
        assertDedicatedRow(baseline, running, 'bg 1 running · Shift↓');

        const done = await waitForCurrentScreen(
          harness,
          (screen) => screen.includes('bg 1 done · Shift↓ · /bg-clear'),
          `done dedicated row at ${String(cols)} columns`,
        );
        assertDedicatedRow(baseline, done, 'bg 1 done · Shift↓ · /bg-clear');

        harness.sendText('/bg-clear');
        harness.sendKeys('Enter');
        await harness.waitFor(/Cleared 1 finished background task notice/, `clear notice at ${String(cols)} columns`);
        const cleared = await waitForCurrentScreen(
          harness,
          (screen) => !screen.includes('bg 1 done · Shift↓ · /bg-clear'),
          `cleared dedicated row at ${String(cols)} columns`,
        );
        const clearedFooter = footerSnapshot(cleared);
        assertNativeFooterUnchanged(baseline, clearedFooter);
        assert.match(
          clearedFooter.lines[clearedFooter.pwdIndex - 1] ?? '',
          /[─╭╮╰╯]/u,
          `clearing the widget must leave no empty spacer above the native footer\n${cleared}`,
        );
      }
    },
  );
});

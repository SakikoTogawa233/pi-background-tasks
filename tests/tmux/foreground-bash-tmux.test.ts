import assert from 'node:assert/strict';
import { globSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import {
  createTmuxTuiHarness,
  resolveRealPiBinary,
  type TmuxTuiHarness,
} from '../helpers/tmux-tui-harness.js';

const extensionPath = resolve('extensions/background-tasks.ts');
const scriptedProviderPath = resolve('tests/scripted-provider/scripted-provider-extension.ts');

interface ProviderEvent {
  readonly callCount: number;
  readonly customTypes: string[];
  readonly summaries: string[];
}

interface TaskMetadata {
  readonly id: string;
  readonly status: string;
  readonly outputPath: string;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await delay(50);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function foregroundHarness(
  t: TestContext,
  scenario: 'foreground-bash-follow-up' | 'foreground-bash-manual-pty',
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
      '--tools',
      'bash',
      '--model',
      'pi-bg-scripted/scripted-model',
    ],
    env: {
      PI_BG_SCRIPTED_API_KEY: 'scripted-api-key',
      PI_BG_SCRIPTED_SCENARIO: scenario,
      PI_BG_SCRIPTED_EVENTS: join('..', 'provider-events.jsonl'),
    },
  });
  t.after(async () => harness.cleanup());
  await harness.start();
  assert.match(harness.tmuxVersion, /^tmux /);
  return harness;
}

function taskMetadataPaths(harness: TmuxTuiHarness): string[] {
  return globSync(join(harness.cwd, '.pi', 'tasks', '**', 'b*.json'));
}

async function completedTask(harness: TmuxTuiHarness, taskId: string): Promise<TaskMetadata> {
  await waitUntil(async () => {
    const paths = taskMetadataPaths(harness);
    if (paths.length !== 1) return false;
    const metadata = JSON.parse(await readFile(paths[0]!, 'utf8')) as TaskMetadata;
    return metadata.id === taskId && metadata.status === 'completed';
  }, `completed metadata for ${taskId}`);
  const paths = taskMetadataPaths(harness);
  assert.equal(paths.length, 1);
  return JSON.parse(await readFile(paths[0]!, 'utf8')) as TaskMetadata;
}

function receiptTaskId(screen: string): string {
  const match = /backgrounded as task\s+(b[0-9a-f]{8})/i.exec(screen);
  assert.ok(match?.[1], `background receipt did not contain a task id\n${screen}`);
  return match[1];
}

async function providerEvents(harness: TmuxTuiHarness): Promise<ProviderEvent[]> {
  const raw = await readFile(harness.providerEventsPath, 'utf8');
  return raw
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as ProviderEvent);
}

async function assertOneCompletionNotification(
  harness: TmuxTuiHarness,
  taskId: string,
): Promise<void> {
  await harness.waitFor(
    new RegExp(`\\[bg completed\\].*${taskId}`),
    `completion notification for ${taskId}`,
    10_000,
  );
  const screen = harness.capture();
  assert.match(screen, new RegExp(`\\[bg completed\\].*${taskId}`));
  assert.equal([...screen.matchAll(/\[bg completed\]/g)].length, 1, screen);
  await waitUntil(async () => (await providerEvents(harness)).length === 3, 'completion follow-up');
  const events = await providerEvents(harness);
  assert.equal(events.length, 3, 'one initial call, one receipt call, and one completion call');
  assert.deepEqual(
    events.map((event) => event.callCount),
    [1, 2, 3],
  );
  const terminalEvent = events[2];
  assert.ok(terminalEvent);
  assert.equal(
    [...terminalEvent.summaries.join('\n').matchAll(/<background-task-notification>/g)].length,
    1,
    'completion follow-up context must contain exactly one terminal notification',
  );
}

void describe('foreground bash real Pi TUI through tmux', { concurrency: false }, () => {
  void it(
    'delivers tmux C-b after the running sentinel, keeps the TUI usable, and completes exactly once',
    { timeout: 30_000 },
    async (t) => {
      const harness = await foregroundHarness(t, 'foreground-bash-manual-pty');
      harness.sendText('Run the manual foreground bash scenario.');
      harness.sendKeys('Enter');
      await harness.waitFor(/FG_MANUAL_RUNNING_SENTINEL/, 'manual running sentinel');

      harness.sendKeys('C-b');
      await harness.waitFor(/Reason: manual/, 'collapsed manual foreground handoff receipt');
      harness.sendKeys('C-o');
      const receipt = await harness.waitFor(
        /backgrounded as task\s+b[0-9a-f]{8}/i,
        'expanded manual foreground handoff receipt',
      );
      const taskId = receiptTaskId(receipt);
      assert.match(receipt, new RegExp(taskId));
      await harness.waitFor(/yielding without\s+polling/i, 'post-receipt assistant yield');

      harness.sendText('/jobs');
      harness.sendKeys('Enter');
      const running = await harness.waitFor(
        new RegExp(`${taskId} running`),
        'running adopted task from a usable command editor',
      );
      assert.match(running, /▶/);
      harness.sendText('editor-still-usable');
      await harness.waitFor(/editor-still-usable/, 'editor input after handoff');
      harness.sendKeys('C-u');

      const metadata = await completedTask(harness, taskId);
      const output = await readFile(join(harness.cwd, metadata.outputPath), 'utf8');
      assert.match(output, /FG_MANUAL_RUNNING_SENTINEL/);
      assert.match(output, /FG_MANUAL_COMPLETED/);
      await assertOneCompletionNotification(harness, taskId);
    },
  );

  void it('auto-backgrounds public timeout:1 without a keypress', { timeout: 25_000 }, async (t) => {
    const harness = await foregroundHarness(t, 'foreground-bash-follow-up');
    const startedAt = Date.now();
    harness.sendText('Run the automatic foreground bash scenario.');
    harness.sendKeys('Enter');
    await harness.waitFor(/Reason: timeout/, 'collapsed timeout foreground handoff receipt');
    harness.sendKeys('C-o');
    const receipt = await harness.waitFor(
      /backgrounded as task\s+b[0-9a-f]{8}/i,
      'expanded timeout foreground handoff receipt',
    );
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 700, `timeout:1 handed off too early after ${String(elapsed)}ms`);
    assert.ok(elapsed < 3000, `timeout:1 handoff took ${String(elapsed)}ms`);
    assert.match(receipt, /FG_AUTO_RUNNING_SENTINEL/);
    assert.match(receipt, /Reason: timeout after 1 seconds/);
    const taskId = receiptTaskId(receipt);

    const metadata = await completedTask(harness, taskId);
    const output = await readFile(join(harness.cwd, metadata.outputPath), 'utf8');
    assert.match(output, /FG_AUTO_COMPLETED/);
    await assertOneCompletionNotification(harness, taskId);
  });

  void it('treats idle Ctrl+B as a no-op and preserves subsequent editor input', { timeout: 20_000 }, async (t) => {
    const harness = await foregroundHarness(t, 'foreground-bash-manual-pty');
    assert.match(
      harness.captureHistory(),
      /Extension shortcut conflict: 'ctrl\+b'[\s\S]*tui\.editor\.cursorLeft/,
      'the TUI must expose Pi\'s default Ctrl+B cursor-left conflict',
    );
    harness.sendText('idle-editor');
    await harness.waitFor(/idle-editor/, 'initial idle editor text');
    harness.sendKeys('C-b');
    await delay(200);
    harness.sendText('-after');
    const editor = await harness.waitFor(/idle-editor-after/, 'editor text after idle Ctrl+B no-op');
    assert.doesNotMatch(editor, /idle-edito-afterr/);
    harness.sendKeys('C-u');

    harness.sendText('/jobs');
    harness.sendKeys('Enter');
    const jobs = await harness.waitFor(/No background tasks in this Pi extension runtime/, 'idle jobs list');
    assert.doesNotMatch(jobs, /\bb[0-9a-f]{8}\b/);
    assert.deepEqual(taskMetadataPaths(harness), []);
  });

  void it('does not kill the adopted process on Escape or editor input after handoff', { timeout: 30_000 }, async (t) => {
    const harness = await foregroundHarness(t, 'foreground-bash-manual-pty');
    harness.sendText('Run the manual ownership foreground bash scenario.');
    harness.sendKeys('Enter');
    await harness.waitFor(/FG_MANUAL_RUNNING_SENTINEL/, 'ownership running sentinel');
    harness.sendKeys('C-b');
    await harness.waitFor(/Reason: manual/, 'collapsed ownership handoff receipt');
    harness.sendKeys('C-o');
    const receipt = await harness.waitFor(
      /backgrounded as task\s+b[0-9a-f]{8}/i,
      'expanded ownership handoff receipt',
    );
    const taskId = receiptTaskId(receipt);
    await harness.waitFor(/yielding without\s+polling/i, 'ownership post-receipt yield');

    harness.sendKeys('Escape');
    await delay(200);
    harness.sendText('ownership-editor-input');
    await harness.waitFor(/ownership-editor-input/, 'ownership editor input');
    harness.sendKeys('C-u');

    const metadata = await completedTask(harness, taskId);
    assert.equal(metadata.status, 'completed');
    const output = await readFile(join(harness.cwd, metadata.outputPath), 'utf8');
    assert.match(output, /FG_MANUAL_COMPLETED/);
    const screen = await harness.waitFor(
      new RegExp(`\\[bg completed\\].*${taskId}`),
      'ownership completion notification',
    );
    assert.doesNotMatch(screen, /\[bg killed\]|Command aborted/i);
    await assertOneCompletionNotification(harness, taskId);
  });
});

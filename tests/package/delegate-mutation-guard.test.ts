import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/**
 * Delegate anti-regression guard.
 *
 * These are source-shape assertions, not behavioural duplicates: they fail if
 * someone reintroduces a shape this package has decided is always a defect —
 * silent truncation, a silent fallback, a route substitution, an unbounded
 * inline answer, a dropped preflight, or a synthesized zero usage.
 *
 * Behavioural coverage lives in the unit and scripted-provider gates. This gate
 * exists because those can be satisfied by an implementation that quietly
 * regains a banned shape on a path the tests do not reach.
 */
const root = new URL('../../', import.meta.url);

async function source(relative: string): Promise<string> {
  return readFile(fileURLToPath(new URL(relative, root)), 'utf8');
}

/** Strip comments so prose that forbids a shape does not read as that shape. */
function codeOnly(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

void describe('delegate mutation resistance', () => {
  void it('never truncates or clips delegate answers or tool payloads', async () => {
    for (const file of [
      'src/core/delegate/result-package.ts',
      'src/core/delegate/runner.ts',
      'src/core/delegate/artifacts.ts',
      'src/delegate-child-extension.ts',
    ]) {
      const code = codeOnly(await source(file));
      assert.doesNotMatch(
        code,
        /\.slice\(0,\s*(?:max|cap|limit|allowed)/i,
        `${file} must not clip content to a cap`,
      );
      assert.doesNotMatch(code, /\.substring\(/, `${file} must not clip content`);
      assert.doesNotMatch(
        code,
        /truncat(?:e|ed|ing)\s*\(/i,
        `${file} must not call a truncation helper`,
      );
    }
  });

  void it('never swallows an error into a silent fallback', async () => {
    for (const file of [
      'src/core/delegate/result-package.ts',
      'src/core/delegate/seed.ts',
      'src/core/delegate/budget.ts',
      'src/core/delegate/launch.ts',
    ]) {
      const code = codeOnly(await source(file));
      assert.doesNotMatch(code, /catch\s*\{\s*\}/, `${file} must not swallow errors`);
      assert.doesNotMatch(
        code,
        /catch\s*\([^)]*\)\s*\{\s*return\s+(?:undefined|null|\[\]|\{\})\s*;?\s*\}/,
        `${file} must not convert a failure into an empty success`,
      );
    }
  });

  void it('pins the route and never substitutes or retries on another one', async () => {
    const launch = codeOnly(await source('src/core/delegate/launch.ts'));
    assert.match(launch, /route_unresolved/);
    assert.match(launch, /route_capacity_unknown/);
    // A fallback list or "first available" selection is exactly the banned shape.
    assert.doesNotMatch(launch, /fallbackRoute|routeFallback|\bfallbackModel\b/i);
    assert.doesNotMatch(
      launch,
      /availableModels\s*\[\s*0\s*\]/,
      'a route must never default to the first available model',
    );
    const resultPackage = codeOnly(await source('src/core/delegate/result-package.ts'));
    assert.match(resultPackage, /route_mismatch/);
    assert.match(resultPackage, /route_attestation_missing/);
  });

  void it('bounds inline delivery and degrades explicitly instead of shortening', async () => {
    const runner = codeOnly(await source('src/core/delegate/runner.ts'));
    assert.match(runner, /result_too_large_for_inline/);
    assert.match(runner, /DELEGATE_INLINE_ANSWER_BYTES/);
    const budget = codeOnly(await source('src/core/delegate/budget.ts'));
    assert.match(budget, /DELEGATE_INLINE_ANSWER_BYTES\s*=\s*\d/);
  });

  void it('runs admission preflight before anything is created and never skips it', async () => {
    const launch = codeOnly(await source('src/core/delegate/launch.ts'));
    assert.match(launch, /assertDelegateHookContract\(input\.hookEvidence\)/);
    assert.match(launch, /assertDelegateAdmission\(plan\)/);
    const runner = codeOnly(await source('src/core/delegate/runner.ts'));
    // The preflight call must precede artifact-store creation in source order,
    // which is what makes "zero children and zero artifacts on refusal" true.
    const preflightIndex = runner.indexOf('preflightDelegateLaunch(input)');
    const storeIndex = runner.indexOf('DelegateArtifactStore.create');
    assert.ok(preflightIndex > 0, 'the runner must call preflight');
    assert.ok(storeIndex > 0, 'the runner must create an artifact store');
    assert.ok(
      preflightIndex < storeIndex,
      'preflight must run before the artifact directory is created',
    );
  });

  void it('never synthesizes zero usage for a run that reported none', async () => {
    const child = codeOnly(await source('src/delegate-child-extension.ts'));
    assert.match(child, /status: 'unavailable'/);
    assert.doesNotMatch(
      child,
      /usage\s*=\s*\{\s*input:\s*0/,
      'a missing usage record must not become a zero usage record',
    );
    const resultPackage = codeOnly(await source('src/core/delegate/result-package.ts'));
    assert.match(resultPackage, /usage status must be observed or unavailable/);
  });

  void it('keeps the child guard using abort rather than a throw as its barrier', async () => {
    const child = codeOnly(await source('src/delegate-child-extension.ts'));
    assert.match(child, /ctx\.abort\(\)/, 'the guard must abort the run');
    // Defence in depth: the oversized content must also be removed, because a
    // throw is not a barrier and abort does not skip the call site on Pi 0.83.
    assert.match(
      child,
      /return \{ messages: suppressedMessages\(event\.messages\) \}/,
      'the guard must replace the outgoing message set, not only abort',
    );
    // Both the budget path and the fail-closed catch path must suppress.
    assert.equal(
      (child.match(/return \{ messages: suppressedMessages\(event\.messages\) \}/g) ?? []).length,
      2,
      'both the over-budget path and the guard-failure path must suppress the content',
    );
    assert.doesNotMatch(
      child,
      /pi\.on\('context'[\s\S]{0,600}?throw new/,
      'the context guard must not rely on throwing, which Pi swallows',
    );
  });

  void it('fails closed when a guard hook itself throws', async () => {
    const child = codeOnly(await source('src/delegate-child-extension.ts'));
    // Pi swallows exceptions thrown from these hooks and dispatches anyway, so
    // an unguarded throw would let the ORIGINAL content through. Both guards
    // must therefore catch, latch, and suppress rather than propagate.
    assert.match(
      child,
      /pi\.on\('context'[\s\S]{0,400}?try \{/,
      'the context guard must run inside a fail-closed try',
    );
    assert.match(
      child,
      /pi\.on\('tool_result'[\s\S]{0,400}?try \{/,
      'the tool-result guard must run inside a fail-closed try',
    );
    assert.match(child, /catch \(error\) \{\s*latch\(/, 'a guard failure must latch terminal state');
    assert.match(child, /function suppressedMessages/);
  });

  void it('never commits an incomplete or empty response as a complete answer', async () => {
    const child = codeOnly(await source('src/delegate-child-extension.ts'));
    assert.match(child, /ACCEPTED_STOP_REASONS/);
    assert.match(
      child,
      /new Set\(\['stop'\]\)/,
      'only a clean stop may be committed as a complete answer',
    );
    assert.match(child, /child_model_output_limit/);
    assert.match(
      child,
      /answerBlocks\.join\(''\)\.trim\(\)\.length === 0/,
      'a whitespace-only answer must be refused',
    );
  });

  void it('latches a terminal condition so a degraded run cannot commit success', async () => {
    const child = codeOnly(await source('src/delegate-child-extension.ts'));
    assert.match(child, /if \(state\.terminal !== undefined\) \{\s*writeTerminalRecord/);
    assert.match(child, /function latch\(/);
  });

  void it('commits the result package atomically with fsync and rename', async () => {
    const child = codeOnly(await source('src/delegate-child-extension.ts'));
    assert.match(child, /fsyncSync\(handle\)/);
    assert.match(child, /renameSync\(temporary, absPath\)/);
    assert.match(child, /openSync\(temporary, 'wx'/);
    // The directory entry must be durable too on POSIX.
    assert.match(child, /fsyncSync\(dirHandle\)/);
  });

  void it('enforces the tool boundary by argv and keeps ambient discovery explicit', async () => {
    const launch = codeOnly(await source('src/core/delegate/launch.ts'));
    assert.match(
      launch,
      /input\.extensionMode === 'isolated' \? \['--no-extensions'\] : \[\]/,
      'only explicit ambient mode may omit --no-extensions',
    );
    for (const flag of [
      "'--no-skills'",
      "'--no-prompt-templates'",
      "'--no-context-files'",
      "'--no-builtin-tools'",
      "'--tools'",
      "'--exclude-tools'",
      "'--session-id'",
      "'--session-dir'",
    ]) {
      assert.ok(launch.includes(flag), `child argv must set ${flag}`);
    }
    const delegateExtension = codeOnly(await source('src/delegate-extension.ts'));
    assert.match(delegateExtension, /extensionMode: Type\.Optional/);
    assert.match(delegateExtension, /requireExtensionMode/);
    assert.doesNotMatch(
      delegateExtension,
      /extensionPaths?|additionalExtensions?/,
      'the public delegate schema must not accept caller-supplied extension paths',
    );
    for (const forbidden of ['bash', 'edit', 'write', 'bg_delegate', 'fusion_brainstorm']) {
      assert.ok(
        launch.includes(`'${forbidden}'`),
        `${forbidden} must appear in the forbidden tool list`,
      );
    }
  });

  void it('delivers the seed over stdin and budgets the prompt actually sent', async () => {
    const launch = codeOnly(await source('src/core/delegate/launch.ts'));
    assert.match(launch, /export function buildDelegateChildPrompt/);
    assert.match(
      launch,
      /seedSerialized: childPrompt/,
      'admission must measure the prompt that is sent, not the seed alone',
    );
    const registry = codeOnly(await source('src/core/registry.ts'));
    assert.match(
      registry,
      /writeDelegateStdin\(child, request\.stdinBytes/,
      'the delegate prompt must be delivered over stdin',
    );
    assert.match(
      registry,
      /stdio: \['pipe', 'pipe', 'pipe'\]/,
      'the delegate child needs a stdin pipe to receive its prompt',
    );
    const runner = codeOnly(await source('src/core/delegate/runner.ts'));
    assert.match(runner, /store\.writeChildPrompt\(stdinBytes\)/);
  });

  void it('reads bounded artifact ranges exactly or fails', async () => {
    const artifacts = codeOnly(await source('src/core/delegate/artifacts.ts'));
    assert.match(artifacts, /refused rather than silently shortened/);
    assert.match(artifacts, /bytesRead !== length/);
    const child = codeOnly(await source('src/delegate-child-extension.ts'));
    assert.match(child, /refused rather than silently shortened/);
    assert.match(child, /slice\.length !== params\.length/);
  });

  void it('never lets a delegate seed borrow Fusion provenance', async () => {
    // Comments legitimately name the Fusion schema in order to forbid it, so
    // only executable code is scanned.
    const seed = codeOnly(await source('src/core/delegate/seed.ts'));
    assert.doesNotMatch(
      seed,
      /buildFusionCanonicalInput/,
      'delegate must not build a Fusion canonical input',
    );
    assert.doesNotMatch(
      seed,
      /fusion-input\.v4/,
      'delegate must not emit the Fusion input schema version',
    );
    assert.doesNotMatch(
      seed,
      /FUSION_[A-Z_]*(?:SCHEMA|POLICY|INPUT)/,
      'delegate must not seal its seed under a Fusion identity',
    );
    assert.match(seed, /DELEGATE_SEED_SCHEMA_VERSION/);
    assert.match(seed, /DELEGATE_CONTEXT_POLICY_ID/);
    // It must, however, still use the shared frozen transform rather than a
    // private copy that could drift from Fusion's disclosure policy.
    assert.match(seed, /projectVisibleConversationV2/);
  });
});

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import {
  ModelRuntime,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createAgentSession,
} from '@earendil-works/pi-coding-agent';
import { prepareDelegateLaunch } from '../src/core/delegate/runner.js';
import { resolveDelegateRoute } from '../src/core/delegate/launch.js';
import { loadDelegateHookContractEvidence } from '../src/core/delegate/launch.js';
import { evaluateDelegateTerminal } from '../src/core/delegate/runner.js';
import { resolvePiLaunch, piLaunchArgv } from '../src/core/pi-launch.js';

/**
 * Live subscription-only `bg_delegate` evidence run.
 *
 * Builds a genuinely large parent session (visible conversation plus heavy tool
 * traffic that the projection must omit), launches ONE real child `pi` on the
 * parent's current subscription route, and verifies that the child completed
 * with the projected context and produced a hash-verified answer.
 *
 * It never uses a metered API: the route comes from the parent's configured
 * subscription provider and no API key is ever passed on the command line.
 */

const PROJECT = process.env['PI_BG_DELEGATE_LIVE_PROJECT'] ?? '/tmp/delegate-live/project';

function log(label: string, value: string): void {
  process.stdout.write(`${label}: ${value}\n`);
}

async function main(): Promise<void> {
  const agentDir = process.env['PI_BG_DELEGATE_LIVE_AGENT_DIR'] ?? join(PROJECT, '..', 'agent');
  await mkdir(agentDir, { recursive: true });
  await rm(join(PROJECT, '.pi', 'delegate'), { recursive: true, force: true });

  const settingsManager = SettingsManager.inMemory({});
  const loader = new DefaultResourceLoader({
    cwd: PROJECT,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noContextFiles: true,
    noThemes: true,
  });
  await loader.reload();
  const modelRuntime = await ModelRuntime.create({});
  const modelRegistry = new ModelRegistry(modelRuntime);
  const sessionManager = SessionManager.inMemory(PROJECT);
  const { session } = await createAgentSession({
    cwd: PROJECT,
    agentDir,
    resourceLoader: loader,
    sessionManager,
    settingsManager,
    modelRuntime,
    noTools: 'builtin',
  });

  const provider = process.env['PI_PROVIDER'] ?? 'anthropic';
  const modelId = process.env['PI_MODEL'] ?? 'claude-opus-5';
  const model = modelRegistry.find(provider, modelId);
  if (!model) throw new Error(`live run requires ${provider}/${modelId} in the model registry`);
  log('route', `${provider}/${modelId} (subscription OAuth, no API key argument)`);

  // A genuinely large session: visible conversation the child MUST see, plus
  // heavy tool traffic the projection MUST omit as hash-accounted receipts.
  const secret = 'SECRET_TOOL_PAYLOAD_THAT_MUST_NOT_REACH_THE_CHILD';
  sessionManager.appendMessage({
    role: 'user',
    content:
      'We are auditing retry budgets across subsystems in this repository. Track what we establish.',
    timestamp: Date.now(),
  });
  for (let index = 0; index < 40; index += 1) {
    sessionManager.appendMessage({
      role: 'assistant',
      api: 'anthropic-messages',
      provider,
      model: modelId,
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'toolUse',
      content: [
        { type: 'text', text: `Audit note ${String(index)}: scanning subsystem sources.` },
        { type: 'thinking', thinking: `${secret} thinking ${String(index)}`, thinkingSignature: '' },
        {
          type: 'toolCall',
          id: `live-call-${String(index)}`,
          name: 'read',
          arguments: { path: `/audit/${String(index)}`, note: secret },
        },
      ],
      timestamp: Date.now(),
    });
    sessionManager.appendMessage({
      role: 'toolResult',
      toolCallId: `live-call-${String(index)}`,
      toolName: 'read',
      content: [{ type: 'text', text: `${secret} ${'x'.repeat(4000)}` }],
      isError: false,
      timestamp: Date.now(),
    });
  }
  // The decisive fact exists ONLY as visible conversation text.
  sessionManager.appendMessage({
    role: 'assistant',
    api: 'anthropic-messages',
    provider,
    model: modelId,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    content: [
      {
        type: 'text',
        text: 'Established so far: the canonical retry budget for this audit is the ALPHA budget, and BETA is the known deviation we are hunting.',
      },
    ],
    timestamp: Date.now(),
  });
  sessionManager.appendMessage({
    role: 'user',
    content: 'Good. Now delegate the file-level confirmation to a background agent.',
    timestamp: Date.now(),
  });

  const evidence = loadDelegateHookContractEvidence(
    await readFile(resolve('src/core/delegate/hook-contract-evidence.json'), 'utf8'),
  );
  const route = resolveDelegateRoute({
    currentModel: { provider: model.provider, id: model.id, contextWindow: model.contextWindow },
    availableModels: modelRegistry
      .getAll()
      .map((entry) => ({
        provider: entry.provider,
        id: entry.id,
        contextWindow: entry.contextWindow,
      })),
    thinkingLevel: 'medium',
  });

  const prepared = await prepareDelegateLaunch({
    ctx: {
      cwd: PROJECT,
      sessionManager,
      getSystemPrompt: () => session.agent.state.systemPrompt,
    },
    toolCallId: 'live-delegate-call',
    prompt:
      'Read alpha.ts, beta.ts, and gamma.ts in the working directory. Report the exact numeric retry budget each subsystem uses and which subsystems share one. Then state, in one sentence, which subsystem is the deviation the audit was hunting, using what the conversation already established. Answer in under 120 words.',
    capability: 'inspect',
    route,
    limitOverrides: { maxTurns: 12, maxToolCalls: 20, timeoutSeconds: 300 },
    hookEvidence: evidence,
    cwd: PROJECT,
    sessionId: sessionManager.getSessionId(),
    autoDeliver: 'never',
  });

  log('task id', prepared.preflight.taskId);
  log('artifact dir', prepared.facts.artifactDir);
  log('seed bytes', String(Buffer.byteLength(prepared.preflight.seed.serialized, 'utf8')));
  log('child prompt bytes', String(prepared.stdinBytes.length));
  log('seed sha256', prepared.preflight.seed.sha256);
  log(
    'projection',
    `${String(prepared.preflight.seed.seed.conversation_projection.accounting.included_text_entry_count)} visible text entries, ` +
      `${String(prepared.preflight.seed.seed.conversation_projection.accounting.omitted_event_count)} omitted events ` +
      `(${String(prepared.preflight.seed.seed.conversation_projection.accounting.omitted_tool_result_text_bytes)} tool-result bytes withheld)`,
  );

  const seedText = prepared.preflight.seed.serialized;
  if (seedText.includes(secret)) throw new Error('LIVE RUN FAILED: omitted payload leaked into seed');
  log('leak check', 'omitted tool payloads are absent from the seed');

  const launch = resolvePiLaunch();
  const argv = piLaunchArgv(launch, [...prepared.argv]);
  log('spawn', `${launch.executable} (no --api-key argument present: ${String(!argv.includes('--api-key'))})`);

  const started = Date.now();
  const exitCode = await new Promise<number>((resolvePromise, reject) => {
    const child = spawn(launch.executable, argv, {
      cwd: PROJECT,
      env: prepared.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    // The seed travels over stdin, exactly as the registry delivers it.
    child.stdin.end(prepared.stdinBytes);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      void writeFile(join(prepared.store.artifactDirAbs, 'child.stdout.txt'), Buffer.concat(out));
      void writeFile(join(prepared.store.artifactDirAbs, 'child.stderr.txt'), Buffer.concat(err));
      resolvePromise(code ?? -1);
    });
  });
  log('child exit', `${String(exitCode)} after ${String(Math.round((Date.now() - started) / 1000))}s`);

  const evaluation = await evaluateDelegateTerminal({
    artifactDirAbs: prepared.store.artifactDirAbs,
    taskId: prepared.preflight.taskId,
    launchNonce: prepared.preflight.launchNonce,
    seedSha256: prepared.preflight.seed.sha256,
    route: { provider: route.provider, model: route.model },
    taskStatus: exitCode === 0 ? 'completed' : 'failed',
    taskError: undefined,
  });

  if (evaluation.error !== undefined || evaluation.result === undefined) {
    process.stdout.write(`\nLIVE RUN FAILED\n${evaluation.error?.describe() ?? 'no result'}\n`);
    const stderrPath = join(prepared.store.artifactDirAbs, 'child.stderr.txt');
    if (existsSync(stderrPath)) {
      process.stdout.write(`\nchild stderr:\n${(await readFile(stderrPath, 'utf8')).slice(-3000)}\n`);
    }
    process.exitCode = 1;
    session.dispose();
    return;
  }

  const verified = evaluation.result;
  log('answer bytes', String(verified.package.answer.byte_length));
  log('answer sha256 (verified)', verified.package.answer.sha256);
  log('route attested', JSON.stringify(verified.package.route_attestations));
  log('turns', String(verified.package.turns));
  log('tool calls', String(verified.package.tool_calls));
  log('usage', verified.package.usage.status);
  log('artifacts', (await readdir(prepared.store.artifactDirAbs)).join(', '));

  process.stdout.write(`\n=== VERIFIED DELEGATE ANSWER ===\n${verified.answer}\n=== END ===\n`);

  const answer = verified.answer;
  const checks: Array<[string, boolean]> = [
    ['names the ALPHA budget value 7', /\b7\b/.test(answer)],
    ['names the BETA budget value 3', /\b3\b/.test(answer)],
    ['identifies BETA as the deviation', /beta/i.test(answer)],
    ['used projected conversation context', /deviation|audit|hunt/i.test(answer)],
    ['did not leak the omitted payload', !answer.includes(secret)],
  ];
  process.stdout.write('\n=== EVIDENCE CHECKS ===\n');
  let allPassed = true;
  for (const [label, passed] of checks) {
    process.stdout.write(`${passed ? 'PASS' : 'FAIL'} ${label}\n`);
    if (!passed) allPassed = false;
  }
  if (!allPassed) process.exitCode = 1;
  session.dispose();
}

main().catch((error: unknown) => {
  process.stdout.write(`LIVE RUN ERROR: ${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

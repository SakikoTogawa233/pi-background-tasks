import { spawnSync } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface FusionFakePiInstallOptions {
  delegatePi?: string | undefined;
  mergedText?: string | undefined;
  delayMs?: number | undefined;
  invalidFirstEvaluation?: boolean | undefined;
  failStage?: 'candidate' | 'evaluation' | 'evaluation-repair' | 'merge' | undefined;
}

export interface FusionFakePiInstallResult {
  binDir: string;
  executable: string;
  logPath: string;
  env: NodeJS.ProcessEnv;
}

export function resolveRealPiCli(): string | undefined {
  const result = spawnSync('bash', ['-lc', 'command -v pi'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() || undefined : undefined;
}

function script(options: FusionFakePiInstallOptions, logPath: string): string {
  const delegate = options.delegatePi ?? '';
  const merged = options.mergedText ?? 'Fused fake answer.';
  const delayMs = options.delayMs ?? 0;
  const invalidFirstEvaluation = options.invalidFirstEvaluation ?? false;
  const failStage = options.failStage ?? '';
  return `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
const logPath = ${JSON.stringify(logPath)};
const delegate = ${JSON.stringify(delegate)};
const mergedText = ${JSON.stringify(merged)};
const delayMs = ${JSON.stringify(delayMs)};
const invalidFirstEvaluation = ${JSON.stringify(invalidFirstEvaluation)};
const failStage = ${JSON.stringify(failStage)};
function argValue(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}
function isFusionChild() {
  return argValue('--mode') === 'json' && args.includes('--no-tools') && args.includes('--no-extensions') && args.includes('--no-context-files');
}
if (!isFusionChild()) {
  if (!delegate) {
    console.error('fusion fake pi received a non-fusion invocation without a delegate');
    process.exit(99);
  }
  const result = spawnSync(delegate, args, { stdio: 'inherit', env: process.env, cwd: process.cwd() });
  if (result.error) {
    console.error(result.error.message);
    process.exit(98);
  }
  process.exit(result.status === null ? 97 : result.status);
}
const provider = argValue('--provider') || 'fake-provider';
const model = argValue('--model') || 'fake-model';
const systemPrompt = argValue('--system-prompt') || '';
let stdin = '';
try { stdin = readFileSync(0, 'utf8'); } catch (error) { stdin = ''; }
let stage = 'candidate';
if (systemPrompt.includes('repair one invalid')) stage = 'evaluation-repair';
else if (systemPrompt.includes('strict blind evaluator')) stage = 'evaluation';
else if (systemPrompt.includes('final synthesis process')) stage = 'merge';
appendFileSync(logPath, JSON.stringify({ stage, provider, model, args, stdin, systemPrompt, cwd: process.cwd(), env: { PI_SESSION_ID: process.env.PI_SESSION_ID || null, PI_PROVIDER: process.env.PI_PROVIDER || null, PI_MODEL: process.env.PI_MODEL || null, PI_SKIP_VERSION_CHECK: process.env.PI_SKIP_VERSION_CHECK || null } }) + '\\n');
if (failStage && stage === failStage) {
  console.error('fusion fake pi failing requested stage ' + stage);
  process.exit(42);
}
function evaluationText() {
  return JSON.stringify({
    schema_version: 'pi-background-tasks.fusion-evaluation.v1',
    candidate_assessments: [
      { candidate_id: 'A', summary: 'A summary', strengths: ['A strength'], limitations: ['A limitation'], useful_contributions: ['A contribution'], risks: ['A risk'] },
      { candidate_id: 'B', summary: 'B summary', strengths: ['B strength'], limitations: ['B limitation'], useful_contributions: ['B contribution'], risks: ['B risk'] },
      { candidate_id: 'C', summary: 'C summary', strengths: ['C strength'], limitations: ['C limitation'], useful_contributions: ['C contribution'], risks: ['C risk'] }
    ],
    agreements: ['All address the request'],
    conflicts: [{ topic: 'detail', positions: [{ candidate_id: 'A', position: 'A position' }, { candidate_id: 'B', position: 'B position' }], resolution: 'Combine the useful detail' }],
    synthesis_plan: { must_include: [{ candidate_id: 'A', contribution: 'A contribution' }], must_resolve: ['detail'], must_avoid: ['unsupported claims'] }
  });
}
function responseText() {
  if (invalidFirstEvaluation && stage === 'evaluation') return JSON.stringify({ schema_version: 'pi-background-tasks.fusion-evaluation.v1', bad: true });
  if (stage === 'evaluation' || stage === 'evaluation-repair') return evaluationText();
  if (stage === 'merge') return mergedText;
  return 'Candidate fake answer from ' + provider + '/' + model + '.';
}
function emit() {
  const text = responseText();
  const usage = { input: 11, output: 7, cacheRead: 2, cacheWrite: 3, totalTokens: 23, cost: { total: 0.01 } };
  console.log(JSON.stringify({ type: 'session', version: 3, id: 'fusion-fake-' + process.pid, timestamp: new Date().toISOString(), cwd: process.cwd() }));
  console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', provider, model, usage, content: [{ type: 'text', text }], stopReason: 'stop', timestamp: Date.now() } }));
}
if (delayMs > 0) setTimeout(emit, delayMs);
else emit();
`;
}

export async function installFusionFakePi(
  root: string,
  options: FusionFakePiInstallOptions = {},
): Promise<FusionFakePiInstallResult> {
  const binDir = join(root, 'bin');
  await mkdir(binDir, { recursive: true });
  const executable = join(binDir, 'pi');
  const logPath = join(root, 'fusion-fake-pi.jsonl');
  await writeFile(executable, script(options, logPath), 'utf8');
  await chmod(executable, 0o755);
  return {
    binDir,
    executable,
    logPath,
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
    },
  };
}

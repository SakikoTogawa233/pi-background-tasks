import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ModelRuntime,
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';

const root = resolve('.');
const extensionPath = resolve('extensions/background-tasks.ts');
const forbiddenPackedSurface =
  /bg_delegate|bg_result|bg_run_pi_attested|fusion_(?:reason|investigate|research|validate|brainstorm)|\/fusion(?:-models)?\b|anthropic-attribution|delegate-child|fusion-child|\.pi\/fusion|\.pi\/delegate|attestation\.json|delegate child|fusion workflow|blind eval|merger/iu;

async function walk(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(path)));
    else files.push(path);
  }
  return files;
}

void describe('extracted background-task lifecycle surface', () => {
  void it('loads exactly five package tools and no Agent/Fusion/attribution command surface', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'pi-bg-extracted-surface-'));
    const agentDir = join(temp, 'agent');
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd: root,
      agentDir,
      settingsManager,
      additionalExtensionPaths: [extensionPath],
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noContextFiles: true,
      noThemes: true,
    });
    await loader.reload();
    const modelRuntime = await ModelRuntime.create({
      authPath: join(temp, 'auth.json'),
      modelsPath: null,
    });
    const { session } = await createAgentSession({
      cwd: root,
      agentDir,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(root),
      settingsManager,
      modelRuntime,
      noTools: 'builtin',
    });
    try {
      assert.deepEqual(session.getActiveToolNames().sort(), [
        'bash',
        'bg_kill',
        'bg_logs',
        'bg_run',
        'bg_status',
      ]);
      const commands = session.extensionRunner
        .getRegisteredCommands()
        .map((command) => command.invocationName)
        .sort();
      assert.deepEqual(commands, [
        'bg',
        'bg-clear',
        'bg-tasks',
        'bg-update',
        'jobs',
        'kill',
        'logs',
        'tasks',
      ]);
    } finally {
      session.dispose();
      await rm(temp, { recursive: true, force: true });
    }
  });

  void it('manifest and pack-owned bytes describe only background task lifecycle', async () => {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      description: string;
      keywords: string[];
      dependencies?: Record<string, string>;
      pi: { extensions: string[] };
    };
    assert.deepEqual(pkg.pi.extensions, ['./extensions/background-tasks.ts']);
    assert.doesNotMatch(pkg.description, forbiddenPackedSurface);
    assert.deepEqual(pkg.keywords, [
      'pi-package',
      'pi-extension',
      'pi',
      'background-tasks',
      'shell',
      'process-lifecycle',
      'task-manager',
      'eventbus',
      'pi-dev',
    ]);
    assert.deepEqual(pkg.dependencies ?? {}, {});

    const packedRoots = [
      join(root, 'extensions'),
      join(root, 'src'),
      join(root, 'docs'),
    ];
    const files = [
      ...(await Promise.all(packedRoots.map((dir) => walk(dir)))).flat(),
      join(root, 'README.md'),
      join(root, 'TESTING.md'),
      join(root, 'TEST_PLAN.md'),
      join(root, 'PUBLISHING.md'),
      join(root, 'BACKGROUND-TASKS-INSTRUCTIONS.md'),
      join(root, 'package.json'),
    ];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      assert.doesNotMatch(source, forbiddenPackedSurface, file);
    }
  });
});

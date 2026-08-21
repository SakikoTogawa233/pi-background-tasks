import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Type, type Static } from 'typebox';
import { Value } from 'typebox/value';
import { Compile } from 'typebox/compile';
import { parseJsonText } from '../../src/core/common.js';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const REMOVED_TYPEBOX_APIS = [
  'Type.Base',
  'Type.Awaited',
  'Type.Promise',
  'Type.AsyncIterator',
  'Type.Iterator',
  'Type.Options',
  'Value.Mutate',
] as const;

async function sourceFiles(): Promise<string[]> {
  const files: string[] = [];
  for (const root of ['src', 'extensions', 'scripts', 'tests']) {
    const stack = [join(packageRoot, root)];
    while (stack.length > 0) {
      const dir = stack.pop();
      assert.ok(dir);
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) stack.push(path);
        else if (/\.tsx?$/u.test(entry.name)) files.push(path);
      }
    }
  }
  return files.sort();
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

void describe('TypeBox compatibility', () => {
  void it('uses Pi-provided TypeBox and keeps the supported host lines', async (t: TestContext) => {
    const typeboxPackageJson = join(packageRoot, 'node_modules/typebox/package.json');
    if (!existsSync(typeboxPackageJson)) {
      t.skip('local node_modules/typebox is unavailable in this isolated worktree');
      return;
    }
    const installed = parseJsonText(await readFile(typeboxPackageJson, 'utf8'));
    assert.ok(isRecord(installed));
    assert.match(String(installed['version']), /^1\.3\./u);

    const manifest = parseJsonText(await readFile(join(packageRoot, 'package.json'), 'utf8'));
    assert.ok(isRecord(manifest));
    const peers = manifest['peerDependencies'];
    assert.ok(isRecord(peers));
    assert.equal(peers['typebox'], '*');
    for (const key of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-tui']) {
      const range = String(peers[key]);
      for (const supported of ['0.81.1', '0.82.1', '0.83.0', '0.84.0']) {
        assert.match(range, new RegExp(supported.replaceAll('.', '\\.')));
      }
    }
    const dependencies = manifest['dependencies'];
    assert.equal(isRecord(dependencies) ? dependencies['typebox'] : undefined, undefined);
  });

  void it('uses no TypeBox API removed by the installed 1.3 line', async () => {
    const violations: string[] = [];
    for (const file of await sourceFiles()) {
      const text = await readFile(file, 'utf8');
      for (const api of REMOVED_TYPEBOX_APIS) {
        if (new RegExp(`\\b${api.replace('.', '\\.')}\\s*\\(`).test(text)) {
          violations.push(`${file} uses removed TypeBox API ${api}`);
        }
      }
    }
    assert.deepEqual(violations, []);
  });

  void it('compiles the closed optional-field shapes used by lifecycle tools', () => {
    const LifecycleQuery = Type.Object(
      {
        taskId: Type.Optional(Type.String()),
        maxBytes: Type.Optional(Type.Number()),
        tail: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    );
    const compiled = Compile(LifecycleQuery);
    assert.equal(compiled.Check({}), true);
    assert.equal(compiled.Check({ taskId: 'a', tail: true }), true);
    assert.equal(compiled.Check({ taskId: 5 }), false);
    assert.equal(compiled.Check({ taskId: 'a', extra: true }), false);
    assert.equal(Value.Check(LifecycleQuery, { maxBytes: 100 }), true);
    type LifecycleQueryValue = Static<typeof LifecycleQuery>;
    const typed: LifecycleQueryValue = { taskId: 'b1', tail: false };
    assert.equal(typed.taskId, 'b1');
  });
});

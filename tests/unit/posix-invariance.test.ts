/**
 * POSIX invariance guard.
 *
 * Windows compatibility work must never change macOS or Linux behaviour. These
 * cases pin the exact POSIX contract that existed before the Windows fixes, so
 * a Windows-motivated change that leaks onto POSIX fails loudly here.
 *
 * Every assertion below is a baseline captured from the pre-change
 * implementation, not an aspiration.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { shellInvocation } from '../../src/core/common.js';
import { replaceFileDurable, writeFileDurable } from '../../src/core/durable-fs.js';

const POSIX_PLATFORMS: readonly NodeJS.Platform[] = ['darwin', 'linux', 'freebsd'];

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-bg-posix-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

void describe('posix invariance', () => {
  void it('keeps the default POSIX shell invocation exactly as before', () => {
    for (const platform of POSIX_PLATFORMS) {
      const invocation = shellInvocation('echo ok', platform, {});
      assert.equal(invocation.shell, '/bin/sh', platform);
      assert.deepEqual(invocation.args, ['-c', 'echo ok'], platform);
    }
  });

  void it('still honours SHELL on POSIX', () => {
    // Windows deliberately ignores SHELL. POSIX must keep respecting it.
    const invocation = shellInvocation('echo ok', 'darwin', { SHELL: '/bin/zsh' });
    assert.equal(invocation.shell, '/bin/zsh');
    assert.deepEqual(invocation.args, ['-c', 'echo ok']);
  });

  void it('never applies cmd.exe quoting or verbatim arguments on POSIX', () => {
    for (const platform of POSIX_PLATFORMS) {
      const invocation = shellInvocation('echo "a b" & true', platform, {});
      // The command must be passed through untouched: no outer quoting.
      assert.equal(invocation.args.at(-1), 'echo "a b" & true', platform);
      const verbatim: unknown = Reflect.get(invocation, 'windowsVerbatimArguments');
      assert.notEqual(verbatim, true, `${platform} must not request verbatim arguments`);
    }
  });

  void it('ignores the Windows-only shell override on POSIX', () => {
    // PI_BG_SHELL is a documented Windows opt-in. It must not alter POSIX,
    // where SHELL already provides the supported mechanism.
    const invocation = shellInvocation('echo ok', 'darwin', {
      PI_BG_SHELL: 'cmd',
      SHELL: '/bin/zsh',
    });
    assert.equal(invocation.shell, '/bin/zsh');
    assert.deepEqual(invocation.args, ['-c', 'echo ok']);
  });

  void it('never uses a login shell, so profile banners cannot pollute output', () => {
    for (const platform of POSIX_PLATFORMS) {
      const invocation = shellInvocation('echo ok', platform, { SHELL: '/bin/bash' });
      assert.deepEqual(invocation.args, ['-c', 'echo ok'], platform);
      assert.ok(!invocation.args.includes('-lc'), platform);
      assert.ok(!invocation.args.includes('-l'), platform);
    }
  });

  // Real POSIX permission bits only exist off Windows. The content assertions
  // below still run everywhere; only the mode checks are host-gated.
  void it('keeps POSIX durable-write file modes unchanged', async () => {
    const checksModes = process.platform !== 'win32';
    await withTempDir(async (dir) => {
      const direct = join(dir, 'direct.txt');
      await writeFileDurable(direct, 'payload');
      assert.equal(await readFile(direct, 'utf8'), 'payload');
      // Direct writes inherit the process umask, historically 0644.
      if (checksModes) assert.equal((await stat(direct)).mode & 0o777, 0o644);

      const replaced = join(dir, 'replaced.json');
      await replaceFileDurable(replaced, '{"a":1}');
      assert.equal(await readFile(replaced, 'utf8'), '{"a":1}');
      // Atomic replacement stays private.
      if (checksModes) assert.equal((await stat(replaced)).mode & 0o777, 0o600);
    });
  });

  void it('still syncs the parent directory after rename on POSIX', async () => {
    // The Windows path skips directory fsync because Node exposes no portable
    // equivalent. POSIX must keep performing it.
    const { createDurableFileWriter } = await import('../../src/core/durable-fs.js');
    const opened: string[] = [];
    const writer = createDurableFileWriter({
      platform: 'darwin',
      openWritable: () => {
        return Promise.resolve({
          writeFile: () => Promise.resolve(),
          sync: () => Promise.resolve(),
          close: () => Promise.resolve(),
        });
      },
      openDirectory: (path: string) => {
        opened.push(path);
        return Promise.resolve({
          sync: () => Promise.resolve(),
          close: () => Promise.resolve(),
        });
      },
      rename: () => Promise.resolve(),
      remove: () => Promise.resolve(),
      temporaryPath: (target: string) => `${target}.tmp`,
    });
    await writer.replace('/virtual/dir/target.json', '{}');
    assert.deepEqual(opened, ['/virtual/dir'], 'POSIX must fsync the parent directory');
  });
});

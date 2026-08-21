import assert from 'node:assert/strict';
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolvePiCliLaunch } from '../helpers/pi-cli.js';

function installedPiCliTarget(): { packageRoot: string; target: string } {
  // The installed package's exports map does not expose ./package.json, so the
  // manifest is located from the package entry URL instead of createRequire.
  let dir = dirname(fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent')));
  for (;;) {
    const candidate = join(dir, 'package.json');
    if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as { bin: { pi: string } };
      return { packageRoot: dir, target: realpathSync(join(dir, manifest.bin.pi)) };
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('installed @earendil-works/pi-coding-agent manifest not found');
    dir = parent;
  }
}

void describe('resolvePiCliLaunch', () => {
  void it('returns the PATH lookup on non-Windows platforms', () => {
    assert.deepEqual(resolvePiCliLaunch('linux'), { executable: 'pi', argvPrefix: [] });
  });

  void it('resolves a working Node-CLI launch spec for win32 against the installed package', () => {
    const launch = resolvePiCliLaunch('win32');
    const { packageRoot, target } = installedPiCliTarget();

    assert.equal(launch.executable, process.execPath);
    assert.equal(launch.argvPrefix.length, 1);
    const cliFile = launch.argvPrefix[0];
    assert.equal(cliFile, target);
    assert.ok(statSync(cliFile).isFile(), `CLI file must exist: ${cliFile}`);
    assert.ok(
      realpathSync(cliFile).startsWith(realpathSync(packageRoot) + sep),
      'CLI file must be contained inside the installed package root',
    );
  });
});

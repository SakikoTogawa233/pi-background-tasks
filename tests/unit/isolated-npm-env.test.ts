import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { isolatedNpmEnvironment } from '../helpers/isolated-npm-env.js';
import { normalizeVolatile } from '../helpers/normalize.js';

void describe('isolated npm environment', () => {
  void it('preserves Windows process launch variables case-insensitively while isolating npm state', () => {
    const root = 'C:\\isolated';
    const env = isolatedNpmEnvironment(
      root,
      {
        Path: 'C:\\Windows\\System32;C:\\node',
        COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
        SYSTEMROOT: 'C:\\Windows',
        windir: 'C:\\Windows',
        Pathext: '.COM;.EXE;.BAT;.CMD',
        temp: 'D:\\host-temp',
        Tmp: 'D:\\host-tmp',
        HOME: 'C:\\real-home',
        USERPROFILE: 'C:\\Users\\real-user',
        APPDATA: 'C:\\Users\\real-user\\AppData\\Roaming',
        npm_lifecycle_event: 'test',
        npm_config_registry: 'https://registry.example.test/',
      },
      'win32',
    );

    assert.equal(env['PATH'], 'C:\\Windows\\System32;C:\\node');
    assert.equal(env['ComSpec'], 'C:\\Windows\\System32\\cmd.exe');
    assert.equal(env['SystemRoot'], 'C:\\Windows');
    assert.equal(env['WINDIR'], 'C:\\Windows');
    assert.equal(env['PATHEXT'], '.COM;.EXE;.BAT;.CMD');
    assert.equal(env['TEMP'], 'D:\\host-temp');
    assert.equal(env['TMP'], 'D:\\host-tmp');
    assert.equal(env['HOME'], join(root, 'home'));
    assert.equal(env['USERPROFILE'], join(root, 'home'));
    assert.equal(env['NPM_CONFIG_CACHE'], join(root, 'cache'));
    assert.equal(env['NPM_CONFIG_USERCONFIG'], join(root, 'npmrc'));
    assert.equal(env['NPM_CONFIG_REGISTRY'], 'http://127.0.0.1.invalid/');
    assert.equal(env['APPDATA'], undefined);
    assert.equal(env['npm_lifecycle_event'], undefined);
  });

  void it('preserves only portable POSIX launch and temporary-directory variables', () => {
    const env = isolatedNpmEnvironment(
      '/isolated',
      {
        PATH: '/usr/bin',
        TMPDIR: '/host/tmpdir',
        TEMP: '/host/temp',
        TMP: '/host/tmp',
        SHELL: '/bin/zsh',
      },
      'linux',
    );

    assert.equal(env['PATH'], '/usr/bin');
    assert.equal(env['TMPDIR'], '/host/tmpdir');
    assert.equal(env['TEMP'], '/host/temp');
    assert.equal(env['TMP'], '/host/tmp');
    assert.equal(env['SHELL'], undefined);
  });
});

void describe('volatile path normalization', () => {
  void it('normalizes native Windows and POSIX task output paths identically', () => {
    assert.equal(
      normalizeVolatile('output=.pi\\tasks\\run-123\\b12345678.output'),
      'output=.pi/tasks/<RUN>/<FILE>',
    );
    assert.equal(
      normalizeVolatile('output=.pi/tasks/run-123/b12345678.output'),
      'output=.pi/tasks/<RUN>/<FILE>',
    );
  });
});

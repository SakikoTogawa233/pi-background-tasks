#!/usr/bin/env node
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const temp = mkdtempSync(join(tmpdir(), 'pi-bg-pnpm-pack-'));
let tarball;

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PI_OFFLINE: '1',
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
    },
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed (${String(result.status)}):\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

try {
  const packed = JSON.parse(run(npm, ['pack', '--json', '--ignore-scripts'], root));
  const filename = packed?.[0]?.filename;
  if (typeof filename !== 'string' || filename.length === 0) {
    throw new Error('npm pack did not report one tarball filename');
  }
  tarball = join(root, filename);

  writeFileSync(
    join(temp, 'package.json'),
    `${JSON.stringify(
      {
        name: 'pi-background-tasks-pnpm-pack-regression',
        version: '0.0.0',
        private: true,
        dependencies: { '@sakiko233/pi-background-tasks': `file:${tarball}` },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(temp, 'pnpm-workspace.yaml'),
    'blockExoticSubdeps: true\nautoInstallPeers: false\n',
  );

  run(pnpm, ['install', '--ignore-scripts'], temp);

  const installedManifestPath = join(
    temp,
    'node_modules',
    '@sakiko233',
    'pi-background-tasks',
    'package.json',
  );
  if (!existsSync(installedManifestPath)) {
    throw new Error(
      'pnpm install did not produce node_modules/@sakiko233/pi-background-tasks/package.json',
    );
  }
  const installed = JSON.parse(readFileSync(installedManifestPath, 'utf8'));
  const dependencies = installed.dependencies ?? {};
  for (const [name, specifier] of Object.entries(dependencies)) {
    if (/^(?:https?:|git(?:\+|:)|github:|file:)/u.test(String(specifier))) {
      throw new Error(`packed production dependency ${name} uses exotic specifier ${specifier}`);
    }
  }
  if (Object.hasOwn(dependencies, '@ravshansbox/pi-anthropic-sps')) {
    throw new Error('packed manifest still declares @ravshansbox/pi-anthropic-sps');
  }
  console.log(`pnpm-pack-regression: installed ${basename(tarball)} with blockExoticSubdeps=true`);
} finally {
  if (tarball && existsSync(tarball)) rmSync(tarball, { force: true });
  rmSync(temp, { recursive: true, force: true });
}

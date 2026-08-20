import { readFileSync, realpathSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join } from 'node:path';

export interface PiCliLaunch {
  executable: string;
  argvPrefix: string[];
}

export function resolvePiCliLaunch(platform: NodeJS.Platform = process.platform): PiCliLaunch {
  if (platform !== 'win32') return { executable: 'pi', argvPrefix: [] };
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve('@earendil-works/pi-coding-agent/package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { bin: { pi: string } };
  const target = realpathSync(join(dirname(manifestPath), manifest.bin.pi));
  if (!statSync(target).isFile()) throw new Error(`Pi CLI target is not a file: ${target}`);
  const extension = extname(target).toLowerCase();
  if (extension === '.js' || extension === '.cjs' || extension === '.mjs') {
    return { executable: process.execPath, argvPrefix: [target] };
  }
  if (extension === '.exe' || extension === '.com') return { executable: target, argvPrefix: [] };
  throw new Error(`Unsupported Pi CLI extension: ${extension}`);
}

export function piCliArgv(launch: PiCliLaunch, args: readonly string[]): string[] {
  return [...launch.argvPrefix, ...args];
}

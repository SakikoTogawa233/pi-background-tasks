import { readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface PiCliLaunch {
  executable: string;
  argvPrefix: string[];
}

const PI_PACKAGE_NAME = '@earendil-works/pi-coding-agent';

function resolvePackageManifestPath(): string {
  // The package's exports map does not expose ./package.json, so the manifest
  // is located from the resolved package entry by walking up directories.
  const packageEntry = fileURLToPath(import.meta.resolve(PI_PACKAGE_NAME));
  let dir = dirname(packageEntry);
  for (;;) {
    const candidate = join(dir, 'package.json');
    const stat = statSync(candidate, { throwIfNoEntry: false });
    if (stat !== undefined) {
      if (!stat.isFile()) throw new Error(`Pi package manifest is not a regular file: ${candidate}`);
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`Pi package manifest not found above ${packageEntry}`);
    dir = parent;
  }
}

function readPiBin(manifestPath: string): string {
  const manifest: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error(`Pi package manifest is not an object: ${manifestPath}`);
  }
  const bin = (manifest as { bin?: unknown }).bin;
  if (typeof bin === 'string' && bin.trim().length > 0) return bin;
  if (typeof bin === 'object' && bin !== null && !Array.isArray(bin)) {
    const pi = (bin as { pi?: unknown }).pi;
    if (typeof pi === 'string' && pi.trim().length > 0) return pi;
  }
  throw new Error(`Pi package manifest bin.pi is missing or malformed: ${manifestPath}`);
}

function pathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export function resolvePiCliLaunch(platform: NodeJS.Platform = process.platform): PiCliLaunch {
  if (platform !== 'win32') return { executable: 'pi', argvPrefix: [] };
  const manifestPath = resolvePackageManifestPath();
  const packageRoot = dirname(manifestPath);
  const packageRootReal = realpathSync(packageRoot);
  const target = realpathSync(join(packageRoot, readPiBin(manifestPath)));
  if (!pathInside(packageRootReal, target)) {
    throw new Error(`Pi CLI target resolves outside the package root: ${target}`);
  }
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

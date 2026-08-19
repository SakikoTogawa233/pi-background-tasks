import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const packages = lock.packages;
const rootDependencies = Object.keys(packages[''].dependencies);

if (rootDependencies.length !== 1) {
  throw new Error(
    `packed-install cache gate requires exactly one production dependency; found ${rootDependencies.length}`,
  );
}

function resolveLockedPackage(fromPath, name) {
  let cursor = fromPath;
  while (true) {
    const candidate = cursor === '' ? `node_modules/${name}` : `${cursor}/node_modules/${name}`;
    if (packages[candidate] !== undefined) return candidate;
    const parent = cursor.lastIndexOf('/node_modules/');
    if (parent === -1) {
      if (cursor === '') break;
      cursor = '';
    } else {
      cursor = cursor.slice(0, parent);
    }
  }
  throw new Error(`package-lock.json does not resolve ${name} from ${fromPath || '<root>'}`);
}

const pending = rootDependencies.map((name) => resolveLockedPackage('', name));
const seen = new Set();
const lockedSpecs = [];

while (pending.length > 0) {
  const packagePath = pending.shift();
  if (seen.has(packagePath)) continue;
  seen.add(packagePath);

  const entry = packages[packagePath];
  const marker = '/node_modules/';
  const markerIndex = packagePath.lastIndexOf(marker);
  const name = packagePath.slice(markerIndex === -1 ? 'node_modules/'.length : markerIndex + marker.length);
  lockedSpecs.push(`${name}@${entry.version}`);

  if (entry.dependencies !== undefined) {
    for (const dependency of Object.keys(entry.dependencies)) {
      pending.push(resolveLockedPackage(packagePath, dependency));
    }
  }
}

const npmCli = process.env.npm_execpath;
if (npmCli === undefined) throw new Error('npm_execpath is required; run this gate through npm');

for (const spec of lockedSpecs) {
  console.log(`Priming npm cache with locked production package ${spec}`);
  const result = spawnSync(process.execPath, [npmCli, 'cache', 'add', spec], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`npm cache add failed for ${spec} with status ${String(result.status)}`);
  }
}

console.log(`Primed ${lockedSpecs.length} locked production package(s) for offline packed install`);

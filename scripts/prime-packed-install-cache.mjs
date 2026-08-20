import { readFileSync } from 'node:fs';

const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
const dependencies = Object.keys(lock.packages[''].dependencies ?? {});
if (dependencies.length !== 0) {
  throw new Error(
    `packed-install cache gate requires zero production dependencies; found ${dependencies.length}`,
  );
}
console.log('No production dependencies require npm cache priming');

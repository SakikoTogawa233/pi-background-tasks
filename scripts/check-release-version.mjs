#!/usr/bin/env node
import { checkReleaseVersion } from './docs/lib.mjs';

const FLAGS = new Set(['--ref-type', '--ref-name']);
const RELEASE_TAG = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function parseArgs(args) {
  if (args.length === 0) return undefined;

  const values = new Map();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    if (!FLAGS.has(flag)) throw new Error(`release-check-version: unknown argument ${flag}`);
    if (values.has(flag)) throw new Error(`release-check-version: duplicate argument ${flag}`);
    if (index + 1 >= args.length || FLAGS.has(args[index + 1])) {
      throw new Error(`release-check-version: missing value for ${flag}`);
    }
    values.set(flag, args[index + 1]);
  }

  for (const flag of FLAGS) {
    if (!values.has(flag)) throw new Error(`release-check-version: missing required argument ${flag}`);
  }

  const refType = values.get('--ref-type');
  const refName = values.get('--ref-name');
  if (refType !== 'tag') {
    throw new Error(`release-check-version: --ref-type must be tag; received ${refType}`);
  }
  if (!RELEASE_TAG.test(refName)) {
    throw new Error(`release-check-version: --ref-name must be a vX.Y.Z semantic-version tag; received ${refName}`);
  }
  return { refName, refType };
}

try {
  const ref = parseArgs(process.argv.slice(2));
  const tag = ref === undefined
    ? checkReleaseVersion()
    : checkReleaseVersion(undefined, ref.refName, ref.refType);
  console.log(`release-check-version: ${tag} matches package.json.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

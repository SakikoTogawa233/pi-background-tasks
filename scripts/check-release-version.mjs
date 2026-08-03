#!/usr/bin/env node
import { checkReleaseVersion } from './docs/lib.mjs';

try {
  const tag = checkReleaseVersion();
  console.log(`release-check-version: ${tag} matches package.json.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

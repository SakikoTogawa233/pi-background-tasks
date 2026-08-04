#!/usr/bin/env node
import { verify } from './lib.mjs';

const args = process.argv.slice(2);
const requireAttestations = args.includes('--require-attestations');
const unknownArgs = args.filter((arg) => arg !== '--require-attestations');
if (unknownArgs.length > 0) {
  console.error(`docs-verify: unknown argument ${unknownArgs[0]}`);
  process.exit(2);
}

try {
  const result = await verify({ requireAttestations });
  const attestationMode = requireAttestations ? 'required' : 'advisory';
  console.log(
    `docs-verify: ${String(result.codeFacts.public_surface_ids.length)} surfaces, ${String(result.codeFacts.governed_sources.length)} sources, deterministic generation OK; attestations ${attestationMode}.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

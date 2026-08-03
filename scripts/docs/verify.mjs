#!/usr/bin/env node
import { verify } from './lib.mjs';

try {
  const result = await verify();
  console.log(`docs-verify: ${String(result.codeFacts.public_surface_ids.length)} surfaces, ${String(result.codeFacts.governed_sources.length)} sources, deterministic generation OK.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

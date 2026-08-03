#!/usr/bin/env node
import { generate } from './lib.mjs';

try {
  const result = await generate();
  console.log(`docs-generate: wrote docs for ${String(result.codeFacts.public_surface_ids.length)} public surfaces and ${String(result.codeFacts.governed_sources.length)} production sources.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

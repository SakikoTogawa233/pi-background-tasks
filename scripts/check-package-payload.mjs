#!/usr/bin/env node
import { runPayloadCheck } from './docs/lib.mjs';

try {
  const files = runPayloadCheck();
  console.log(`payload-check: ${String(files.length)} packed files satisfy runtime/docs closure.`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

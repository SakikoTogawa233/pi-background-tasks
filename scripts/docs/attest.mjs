#!/usr/bin/env node
import { recordAttestation, DocsGateError } from './lib.mjs';

const args = process.argv.slice(2);
const docId = args.find((arg) => !arg.startsWith('--'));

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

const reviewer = option('--reviewer');
const verdict = option('--verdict');
const notes = option('--notes');

if (!docId) {
  console.error('usage: npm run docs:attest/record -- <doc_id> --reviewer <identity-after-semantic-review> --verdict PASS --notes <review-notes>');
  process.exit(2);
}

try {
  const receipt = await recordAttestation(docId, { reviewer, verdict, notes });
  console.log(`docs-attest: recorded ${receipt.verdict} receipt for ${receipt.doc_id}`);
} catch (error) {
  if (error instanceof DocsGateError) console.error(error.message);
  else console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

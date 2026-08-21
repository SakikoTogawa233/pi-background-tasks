#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DocsGateError,
  assertCoverage,
  assertRegistrationFixture,
  buildCodeFacts,
  checkPayloadFiles,
  checkReleaseVersion,
  extractGeneratedRegions,
  generateDocTexts,
  loadDocsModel,
  parseFrontmatter,
  parseNpmPackFiles,
  resolveNpmCli,
  splitFrontmatter,
  verifyLinksAndReachability,
} from './lib.mjs';

function mustThrow(name, fn, pattern) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof Error, name);
    assert.match(error.message, pattern, name);
    return;
  }
  assert.fail(`${name} did not throw`);
}

const codeFacts = buildCodeFacts();
const docsModel = loadDocsModel();
assert.equal(docsModel.docs.length, 27, 'all docs/**/*.md are governed');
assert.equal(codeFacts.public_surface_ids.length, 19, 'all lifecycle surfaces are extracted');
for (const expected of [
  'tool:bash',
  'tool:bg_run',
  'tool:bg_status',
  'tool:bg_logs',
  'tool:bg_kill',
  'eventbus:background-task-v1',
  'eventbus:external-task-v2',
]) assert.ok(codeFacts.public_surface_ids.includes(expected), expected);
assert.equal(codeFacts.governed_sources.length, 10);
const envNames = new Set(codeFacts.environment_variables.map((entry) => entry.name));
for (const expected of ['PI_BG_SHELL', 'PI_BG_SHELL_PATH', 'PI_BG_MAX_OUTPUT_BYTES', 'ComSpec', 'SystemRoot', 'WINDIR']) {
  assert.ok(envNames.has(expected), expected);
}
assert.deepEqual(
  codeFacts.runtime_paths_and_artifacts.map((entry) => entry.value).sort(),
  [
    '.pi/tasks/<session-id>-<pid>/',
    '.pi/tasks/<session-id>-<pid>/<task-id>.json',
    '.pi/tasks/<session-id>-<pid>/<task-id>.output',
  ],
);

mustThrow('malformed frontmatter', () => parseFrontmatter('doc_id INDEX.md', 'fixture.md'), /malformed frontmatter/);
mustThrow('unknown frontmatter key', () => {
  const text = '---\ndoc_id: x\naudience: agent\nmode: generated\nreview_policy: contract\nstability: stable\ncovers_surfaces: []\ncovers_sources: []\nextra: nope\n---\n';
  const { frontmatterText } = splitFrontmatter(text, 'docs/x.md');
  const fm = parseFrontmatter(frontmatterText, 'docs/x.md');
  if ('extra' in fm) throw new DocsGateError('unknown frontmatter key extra');
}, /unknown frontmatter/);
mustThrow('nested generated regions', () => extractGeneratedRegions({ docs: [{ rel: 'docs/x.md', doc_id: 'x', text: '<!-- pi-docs:begin name="a" generator="scripts/docs/generate.mjs" -->\n<!-- pi-docs:begin name="b" generator="scripts/docs/generate.mjs" -->\n<!-- pi-docs:end name="b" -->\n<!-- pi-docs:end name="a" -->' }] }), /nested/);
mustThrow('unknown public surface', () => assertCoverage(codeFacts, { docs: [{ rel: 'docs/x.md', doc_id: 'x', frontmatter: { covers_surfaces: ['tool:not_real'], covers_sources: [] } }] }), /unknown public surface/);
mustThrow('uncovered source', () => assertCoverage({ ...codeFacts, governed_sources: [...codeFacts.governed_sources, 'src/new-source.ts'] }, docsModel), /has no primary doc/);
const sourceOwner = docsModel.docs.find((doc) => doc.frontmatter.covers_sources.length > 0);
assert.ok(sourceOwner);
mustThrow('non-behavioral source owner', () => assertCoverage(codeFacts, {
  docs: docsModel.docs.map((doc) => doc.doc_id === sourceOwner.doc_id
    ? { ...doc, frontmatter: { ...doc.frontmatter, review_policy: 'contract' } }
    : doc),
}), /source owners must use review_policy behavioral/);
mustThrow('broken link', () => verifyLinksAndReachability(process.cwd(), { docs: [{ rel: 'docs/INDEX.md', doc_id: 'INDEX', body: '# Index\n[bad](./missing.md)', text: '', frontmatter: { covers_surfaces: [], covers_sources: [] } }] }), /broken link/);

mustThrow('unsupported extraction', () => assertRegistrationFixture("export default function x(pi){ pi.registerCommand(makeName(), {}); }"), /unsupported expression/);
mustThrow('duplicate registration', () => assertRegistrationFixture("export default function x(pi){ pi.registerCommand('same', {}); pi.registerCommand('same', {}); }"), /duplicate public registration/);
mustThrow('conditional registration', () => assertRegistrationFixture("export default function x(pi){ if (enabled) pi.registerCommand('hidden', {}); }"), /immediate top-level statement/);
assert.deepEqual(assertRegistrationFixture("export default function x(pi){ pi.registerCommand('public', {}); }"), ['command:public']);

mustThrow('mandatory gateway missing', () => checkPayloadFiles([
  'package.json', 'README.md', 'TESTING.md', 'TEST_PLAN.md', 'PUBLISHING.md', 'LICENSE',
  'THIRD_PARTY_NOTICES.md', 'logo.png', 'extensions/background-tasks.ts',
]), /packed payload missing BACKGROUND-TASKS-INSTRUCTIONS\.md/);
mustThrow('missing packed docs', () => checkPayloadFiles([
  'package.json', 'README.md', 'TESTING.md', 'TEST_PLAN.md', 'PUBLISHING.md', 'LICENSE',
  'THIRD_PARTY_NOTICES.md', 'BACKGROUND-TASKS-INSTRUCTIONS.md', 'logo.png',
  'extensions/background-tasks.ts',
]), /packed payload missing/);
mustThrow('release check requires tag', () => checkReleaseVersion(process.cwd(), undefined, undefined), /requires an explicit tag ref/);

const fakeNode = join(tmpdir(), 'pi-bg-node-home', process.platform === 'win32' ? 'node.exe' : 'node');
const adjacentNpmCli = resolve(dirname(fakeNode), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const envNpmCli = join(tmpdir(), 'pi-bg-env-npm-cli.js');
assert.equal(resolveNpmCli(fakeNode, {}, (candidate) => candidate === adjacentNpmCli), adjacentNpmCli);
assert.equal(resolveNpmCli(fakeNode, { npm_execpath: envNpmCli }, (candidate) => candidate === envNpmCli), envNpmCli);
assert.deepEqual(parseNpmPackFiles('[{"files":[{"path":"z"},{"path":"a"}]}]'), ['a', 'z']);
mustThrow('malformed pack JSON', () => parseNpmPackFiles('{'), /did not return valid JSON/);

const tmpRoot = mkdtempSync(join(tmpdir(), 'pi-bg-doc-fixture-'));
try {
  mkdirSync(join(tmpRoot, 'docs'), { recursive: true });
  writeFileSync(join(tmpRoot, 'docs', 'bad.md'), '# Missing frontmatter\n');
  mustThrow('malformed discovered doc', () => loadDocsModel({ packageRoot: tmpRoot }), /missing frontmatter/);
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

assert.deepEqual(generateDocTexts(codeFacts, docsModel), generateDocTexts(codeFacts, docsModel));
console.log('docs-selftest: lifecycle mutation fixtures passed');

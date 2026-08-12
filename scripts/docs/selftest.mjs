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
  sha256,
  splitFrontmatter,
  verifyAttestations,
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

assert.equal(docsModel.docs.length, 42, 'all docs/**/*.md are governed');
assert.equal(codeFacts.public_surface_ids.length, 31, 'all command/tool/shortcut/renderer/EventBus/workflow surfaces are extracted');
assert.ok(codeFacts.public_surface_ids.includes('eventbus:background-task-v1'));
assert.ok(codeFacts.public_surface_ids.includes('workflow:research'));
assert.equal(docsModel.docs.find((doc) => doc.doc_id === 'INDEX').frontmatter.covers_surfaces.length, 0, 'INDEX must not own public surfaces');
assert.equal(docsModel.docs.find((doc) => doc.doc_id === 'read-before-edit').frontmatter.covers_sources.length, 0, 'read-before-edit must not own sources');
const envNames = new Set(codeFacts.environment_variables.map((entry) => entry.name));
for (const expectedEnv of ['PI_BG_SHELL', 'PI_BG_SHELL_PATH', 'PI_BG_DISABLE_PI_TELEMETRY', 'ComSpec', 'SystemRoot', 'WINDIR']) assert.ok(envNames.has(expectedEnv), `missing env extraction for ${expectedEnv}`);
assert.ok(!envNames.has('FUSION_CHILD_IDLE_TIMEOUT_MS'), 'fixed timeout constant must not be classified as env');
const runtimeArtifacts = new Set(codeFacts.runtime_paths_and_artifacts.map((entry) => entry.value));
for (const expectedArtifact of [
  '<attempt-prefix> = candidate-<slot>.attempt-<n> | evaluation.attempt-<n> | merge.attempt-<n>',
  'candidate-<slot>.attempt-<n>.response.md | candidate-<slot>.attempt-<n>.response.partial.md',
  'evaluation.attempt-<n>.response.txt | evaluation.attempt-<n>.response.partial.txt',
  'merge.attempt-<n>.response.md | merge.attempt-<n>.response.partial.md',
  'candidate-<slot>.attempt-<n>.tool-calls.jsonl.seal.json',
]) assert.ok(runtimeArtifacts.has(expectedArtifact), `missing runtime artifact ${expectedArtifact}`);
assert.ok(
  ![...runtimeArtifacts].some((artifact) => artifact.includes('<stage>[.<slot>]')),
  'stale generic Fusion attempt artifact pattern must not return',
);

mustThrow('malformed frontmatter', () => parseFrontmatter('doc_id INDEX.md', 'fixture.md'), /malformed frontmatter/);
mustThrow('unknown frontmatter key', () => {
  const text = '---\ndoc_id: x\naudience: agent\nmode: generated\nreview_policy: contract\nstability: stable\ncovers_surfaces: []\ncovers_sources: []\nextra: nope\n---\n';
  const { frontmatterText } = splitFrontmatter(text, 'docs/x.md');
  const fm = parseFrontmatter(frontmatterText, 'docs/x.md');
  if ('extra' in fm) throw new DocsGateError('unknown frontmatter key extra');
}, /unknown frontmatter/);

mustThrow('broken duplicate markers', () => extractGeneratedRegions({ docs: [{ rel: 'docs/x.md', doc_id: 'x', text: '<!-- pi-docs:begin name="a" generator="scripts/docs/generate.mjs" -->\n<!-- pi-docs:begin name="b" generator="scripts/docs/generate.mjs" -->\n<!-- pi-docs:end name="b" -->\n<!-- pi-docs:end name="a" -->' }] }), /nested/);

mustThrow('stale/unknown surface', () => assertCoverage(codeFacts, { docs: [{ rel: 'docs/x.md', doc_id: 'x', frontmatter: { covers_surfaces: ['tool:not_real'], covers_sources: [] } }] }), /unknown public surface/);

mustThrow('new uncovered source', () => assertCoverage({ ...codeFacts, governed_sources: [...codeFacts.governed_sources, 'src/new-source.ts'] }, docsModel), /src\/new-source\.ts has no primary doc/);

mustThrow('duplicate owner', () => assertCoverage(codeFacts, { docs: [docsModel.docs[0], { ...docsModel.docs[0], rel: 'docs/dup.md', doc_id: 'dup' }] }), /duplicate primary docs/);
const behavioralOwner = docsModel.docs.find((doc) => doc.frontmatter.covers_sources.length > 0);
assert.ok(behavioralOwner, 'fixture requires one source-owning doc');
mustThrow('non-behavioral source owner', () => assertCoverage(codeFacts, {
  docs: docsModel.docs.map((doc) => doc.doc_id === behavioralOwner.doc_id
    ? { ...doc, frontmatter: { ...doc.frontmatter, review_policy: 'contract' } }
    : doc),
}), /source owners must use review_policy behavioral/);

mustThrow('broken link/anchor', () => verifyLinksAndReachability(process.cwd(), { docs: [{ rel: 'docs/INDEX.md', doc_id: 'INDEX', body: '# Hi\n[bad](./missing.md)', text: '---\n---\n# Hi\n[bad](./missing.md)', frontmatter: { covers_surfaces: [], covers_sources: [] } }] }), /broken link/);
mustThrow('broken reference-style link', () => verifyLinksAndReachability(process.cwd(), { docs: [{ rel: 'docs/INDEX.md', doc_id: 'INDEX', body: '# Hi\n[bad][missing-doc]\n\n[missing-doc]: ./missing.md', text: '---\n---\n# Hi\n[bad][missing-doc]\n\n[missing-doc]: ./missing.md', frontmatter: { covers_surfaces: [], covers_sources: [] } }] }), /broken link/);
mustThrow('undefined reference-style link', () => verifyLinksAndReachability(process.cwd(), { docs: [{ rel: 'docs/INDEX.md', doc_id: 'INDEX', body: '# Hi\n[bad][not-defined]', text: '---\n---\n# Hi\n[bad][not-defined]', frontmatter: { covers_surfaces: [], covers_sources: [] } }] }), /undefined Markdown reference/);

const linkRoot = mkdtempSync(join(tmpdir(), 'pi-bg-doc-links-'));
try {
  mkdirSync(join(linkRoot, 'docs'), { recursive: true });
  writeFileSync(join(linkRoot, 'docs', 'INDEX.md'), '# Index\n[Guide][guide-ref]\n\n[guide-ref]: ./guide.md\n\n<https://example.com/>\n```md\n[ignored][undefined-in-code]\n```\n');
  writeFileSync(join(linkRoot, 'docs', 'guide.md'), '# Guide\n');
  verifyLinksAndReachability(linkRoot, {
    docs: [
      { rel: 'docs/INDEX.md', doc_id: 'INDEX', body: '# Index\n[Guide][guide-ref]\n\n[guide-ref]: ./guide.md\n\n<https://example.com/>\n```md\n[ignored][undefined-in-code]\n```\n', text: '', frontmatter: { covers_surfaces: [], covers_sources: [] } },
      { rel: 'docs/guide.md', doc_id: 'guide', body: '# Guide\n', text: '', frontmatter: { covers_surfaces: [], covers_sources: [] } },
    ],
  });
} finally {
  rmSync(linkRoot, { recursive: true, force: true });
}

const attestationFixtureDoc = { rel: 'docs/behavior.md', doc_id: 'behavior', body: 'body', frontmatter: { review_policy: 'behavioral', covers_sources: ['package.json'] } };
const attestationFixtureReceipt = { schema_version: 'pi-background-tasks.docs-attestation.v1', doc_id: 'behavior', verdict: 'PASS', reviewer: 'fixture-reviewer', notes: 'fixture stale receipt notes', authored_body_sha256: sha256('other'), covers_sources: ['package.json'], source_sha256: {} };
mustThrow('stale receipt', () => verifyAttestations(process.cwd(), { docs: [attestationFixtureDoc] }, { schema_version: 'pi-background-tasks.docs-attestations.v1', receipts: [attestationFixtureReceipt] }), /stale attestation authored prose hash/);
mustThrow('duplicate receipt', () => verifyAttestations(process.cwd(), { docs: [attestationFixtureDoc] }, { schema_version: 'pi-background-tasks.docs-attestations.v1', receipts: [attestationFixtureReceipt, { ...attestationFixtureReceipt }] }), /duplicate receipt/);
mustThrow('orphan receipt', () => verifyAttestations(process.cwd(), { docs: [attestationFixtureDoc] }, { schema_version: 'pi-background-tasks.docs-attestations.v1', receipts: [{ ...attestationFixtureReceipt, doc_id: 'removed-owner' }] }), /orphan receipt/);

mustThrow('unsupported extraction', () => assertRegistrationFixture('export default function x(pi){ pi.registerCommand(makeName(), {}); }'), /unsupported expression for docs extraction/);
mustThrow('duplicate public registration', () => assertRegistrationFixture("export default function x(pi){ pi.registerCommand('same', {}); pi.registerCommand('same', {}); }"), /duplicate public registration/);
mustThrow('invalid tool string metadata', () => assertRegistrationFixture("export default function x(pi){ pi.registerTool({ name: 'fixture', description: 42 }); }"), /description must resolve to a string/);
mustThrow('invalid tool guidelines metadata', () => assertRegistrationFixture("export default function x(pi){ pi.registerTool({ name: 'fixture', promptGuidelines: ['valid', 42] }); }"), /promptGuidelines must resolve to an array of strings/);
mustThrow('shorthand tool metadata', () => assertRegistrationFixture("export default function x(pi){ const description = 'hidden'; pi.registerTool({ name: 'fixture', description }); }"), /public field description must be an explicit property assignment/);
mustThrow('spread tool metadata', () => assertRegistrationFixture("export default function x(pi){ const metadata = { description: 'hidden' }; pi.registerTool({ name: 'fixture', ...metadata }); }"), /must not use object spread/);
mustThrow('aliased registration method', () => assertRegistrationFixture("export default function x(pi){ const register = pi.registerCommand; register('hidden', {}); }"), /aliasing the Pi registration host|must be called directly/);
mustThrow('bound registration method', () => assertRegistrationFixture("export default function x(pi){ const register = pi.registerTool.bind(pi); register({ name: 'hidden' }); }"), /aliasing the Pi registration host|unsupported (?:non-identifier )?helper invocation|must be called directly/);
mustThrow('literal element-access registration', () => assertRegistrationFixture("export default function x(pi){ pi['registerCommand']('hidden', {}); }"), /element access on the Pi registration host|unsupported derived Pi registration invocation/);
mustThrow('computed element-access registration', () => assertRegistrationFixture("export default function x(pi){ const key = 'register' + 'Command'; pi[key]('hidden', {}); }"), /element access on the Pi registration host|unsupported derived Pi registration invocation/);
mustThrow('derived registration callee', () => assertRegistrationFixture("export default function x(pi){ ({ call: pi.registerCommand }).call('hidden', {}); }"), /unsupported derived Pi registration invocation/);
mustThrow('nested returned host alias', () => assertRegistrationFixture("export default function x(pi){ function hidden(){ return pi; } hidden().registerCommand('hidden', {}); }"), /unsupported nested registration helper or invocation/);
mustThrow('nested default host alias', () => assertRegistrationFixture("export default function x(pi){ function hidden(host = pi){ host.registerCommand('hidden', {}); } hidden(); }"), /unsupported nested registration helper or invocation/);
mustThrow('aliased registration host', () => assertRegistrationFixture("export default function x(pi){ const host = (pi as any); host.registerCommand('hidden', {}); }"), /aliasing the Pi registration host or registration wrapper/);
mustThrow('assigned registration host alias', () => assertRegistrationFixture("export default function x(pi){ let host; host = (pi satisfies unknown); host.registerCommand('hidden', {}); }"), /assigning a Pi registration host/);
mustThrow('compound registration host alias', () => assertRegistrationFixture("export default function x(pi){ let host; host ??= pi; host.registerCommand('hidden', {}); }"), /assigning a Pi registration host/);
mustThrow('iterated registration host alias', () => assertRegistrationFixture("export default function x(pi){ for (const host of [pi]) { host.registerCommand('hidden', {}); } }"), /Pi registration host escapes the supported direct-use grammar/);
mustThrow('destructured Pi parameter', () => assertRegistrationFixture("export default function x({ registerCommand }){ registerCommand('hidden', {}); }"), /default export must have an identifier Pi parameter/);
mustThrow('constructor receives Pi', () => assertRegistrationFixture("class Hidden { constructor(host: any) { host.registerCommand('hidden', {}); } } export default function x(pi){ new Hidden(pi); }"), /constructors must not receive or derive Pi registration hosts/);
mustThrow('derived registration host alias', () => assertRegistrationFixture("export default function x(pi){ const host = { ...pi }; host.registerCommand('hidden', {}); }"), /aliasing the Pi registration host or registration wrapper/);
mustThrow('unknown registration helper', () => assertRegistrationFixture("function hidden(host){} export default function x(pi){ hidden((pi as any)); }"), /unsupported helper invocation receives the Pi registration host/);
assert.deepEqual(assertRegistrationFixture("export default function x(pi){ pi.registerProvider('internal', {}); pi.registerCommand('public', {}); }"), ['command:public'], 'non-public provider registration must be accepted without becoming a public surface');
assert.deepEqual(
  assertRegistrationFixture("export default function x(pi){ (pi as any).registerCommand('normalized', {}); }"),
  ['command:normalized'],
  'normalized Pi host expressions must still be extracted',
);

const validToolFields = "name: 'fixture', label: 'Fixture', description: 'fixture', promptSnippet: 'fixture', promptGuidelines: ['fixture'], parameters: Type.Object({})";
const wrapperDefinition = "function registerTool(options: any): void { pi.registerTool({ name: options.name, label: options.label, description: options.description, promptSnippet: options.promptSnippet, promptGuidelines: options.promptGuidelines, parameters: options.parameters }); }";
assert.deepEqual(
  assertRegistrationFixture(`export default function x(pi){ ${wrapperDefinition} (registerTool as typeof registerTool)({ ${validToolFields} }); }`),
  ['tool:fixture'],
  'cast wrapper calls must be normalized and extracted',
);
mustThrow(
  'returned wrapper escape',
  () => assertRegistrationFixture(`export default function x(pi){ ${wrapperDefinition} function hidden(){ return registerTool; } hidden()({ ${validToolFields} }); }`),
  /unsupported nested registration helper or invocation/,
);
mustThrow(
  'higher-order wrapper argument',
  () => assertRegistrationFixture(`export default function x(pi){ ${wrapperDefinition} invoke(registerTool, { ${validToolFields} }); }`),
  /registration wrappers must not be passed as arguments/,
);
mustThrow(
  'constructor receives wrapper',
  () => assertRegistrationFixture(`export default function x(pi){ ${wrapperDefinition} new Hidden(registerTool); }`),
  /constructors must not receive or derive Pi registration hosts or wrappers/,
);
mustThrow(
  'wrapper computed public path',
  () => assertRegistrationFixture(`export default function x(pi){ function registerTool(options: any): void { pi.registerTool({ name: options['name'], label: options.label, description: options.description, promptSnippet: options.promptSnippet, promptGuidelines: options.promptGuidelines, parameters: options.parameters }); } registerTool({ ${validToolFields} }); }`),
  /public field name must map directly from options\.name/,
);
mustThrow(
  'wrapper spread hides public fields',
  () => assertRegistrationFixture(`export default function x(pi){ function registerTool(options: any): void { pi.registerTool({ ...options }); } registerTool({ ${validToolFields} }); }`),
  /must not use object spread/,
);
mustThrow(
  'conditional registerTool inside wrapper',
  () => assertRegistrationFixture(`export default function x(pi){ function registerTool(options: any): void { if (enabled) { pi.registerTool({ name: options.name, label: options.label, description: options.description, promptSnippet: options.promptSnippet, promptGuidelines: options.promptGuidelines, parameters: options.parameters }); } } registerTool({ ${validToolFields} }); }`),
  /tool wrapper registerTool call must be an immediate top-level statement/,
);
mustThrow(
  'conditional wrapper definition',
  () => assertRegistrationFixture(`export default function x(pi){ if (enabled) { function registerTool(options: any): void { pi.registerTool({ name: options.name, label: options.label, description: options.description, promptSnippet: options.promptSnippet, promptGuidelines: options.promptGuidelines, parameters: options.parameters }); } registerTool({ ${validToolFields} }); } }`),
  /tool wrapper definition must be top-level/,
);
mustThrow(
  'conditional wrapper invocation',
  () => assertRegistrationFixture(`export default function x(pi){ ${wrapperDefinition} if (enabled) { registerTool({ ${validToolFields} }); } }`),
  /local registration-wrapper call must be an immediate top-level statement/,
);
mustThrow(
  'conditional direct registration',
  () => assertRegistrationFixture("export default function x(pi){ if (enabled) { pi.registerCommand('hidden', {}); } }"),
  /public registration call must be an immediate top-level statement/,
);
mustThrow(
  'wrapper secondary registration',
  () => assertRegistrationFixture(`export default function x(pi){ function registerTool(options: any): void { pi.registerTool({ name: options.name, label: options.label, description: options.description, promptSnippet: options.promptSnippet, promptGuidelines: options.promptGuidelines, parameters: options.parameters }); pi.registerCommand('hidden', {}); } registerTool({ ${validToolFields} }); }`),
  /exactly one direct registerTool call and no secondary registrations/,
);
mustThrow(
  'nested wrapper invocation',
  () => assertRegistrationFixture(`export default function x(pi){ ${wrapperDefinition} pi.on('event', () => { (registerTool as typeof registerTool)({ ${validToolFields} }); }); }`),
  /unsupported nested registration helper or invocation|registration wrappers must not be passed as arguments/,
);
mustThrow(
  'wrapper invokes second wrapper',
  () => assertRegistrationFixture(`export default function x(pi){ function registerFirst(options: any): void { pi.registerTool({ name: options.name, label: options.label, description: options.description, promptSnippet: options.promptSnippet, promptGuidelines: options.promptGuidelines, parameters: options.parameters }); registerSecond(options); } function registerSecond(options: any): void { pi.registerTool({ name: options.name, label: options.label, description: options.description, promptSnippet: options.promptSnippet, promptGuidelines: options.promptGuidelines, parameters: options.parameters }); } registerFirst({ ${validToolFields} }); }`),
  /wrapper must not invoke another registration helper/,
);
mustThrow(
  'aliased local wrapper',
  () => assertRegistrationFixture(`export default function x(pi){ ${wrapperDefinition} const hidden = registerTool; hidden({ ${validToolFields} }); }`),
  /aliasing the Pi registration host or registration wrapper/,
);
assert.deepEqual(
  assertRegistrationFixture({
    entry: 'entry.ts',
    files: {
      'entry.ts': "import { registerFeature } from './feature.js'; export default function x(pi){ (registerFeature as typeof registerFeature)((pi)); }",
      'feature.ts': "export function registerFeature(pi){ pi.registerCommand('imported', {}); }",
    },
  }),
  ['command:imported'],
  'normalized imported registrar calls must be extracted',
);
mustThrow(
  'repeated imported registrar',
  () => assertRegistrationFixture({
    entry: 'entry.ts',
    files: {
      'entry.ts': "import { registerFeature } from './feature.js'; export default function x(pi){ registerFeature(pi); registerFeature(pi); }",
      'feature.ts': "export function registerFeature(pi){ pi.registerCommand('imported', {}); }",
    },
  }),
  /imported registration function .* is invoked more than once/,
);

mustThrow('mandatory gateway missing', () => checkPayloadFiles(['package.json', 'README.md', 'TESTING.md', 'TEST_PLAN.md', 'PUBLISHING.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'logo.png', 'extensions/anthropic-attribution.ts', 'extensions/background-tasks.ts', 'extensions/delegate-child.ts', 'extensions/fusion-child.ts']), /packed payload missing BACKGROUND-TASKS-INSTRUCTIONS\.md/);
mustThrow('missing packed doc', () => checkPayloadFiles(['package.json', 'README.md', 'TESTING.md', 'TEST_PLAN.md', 'PUBLISHING.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'BACKGROUND-TASKS-INSTRUCTIONS.md', 'logo.png', 'extensions/anthropic-attribution.ts', 'extensions/background-tasks.ts', 'extensions/delegate-child.ts', 'extensions/fusion-child.ts']), /packed payload missing/);

mustThrow('release check requires explicit tag ref', () => checkReleaseVersion(process.cwd(), undefined, undefined), /requires an explicit tag ref/);

const fakeNode = join(tmpdir(), 'pi-bg-node-home', process.platform === 'win32' ? 'node.exe' : 'node');
const adjacentNpmCli = resolve(dirname(fakeNode), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const globalNpmCli = resolve(dirname(fakeNode), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
const envNpmCli = join(tmpdir(), 'pi-bg-env-npm-cli.js');
assert.equal(resolveNpmCli(fakeNode, {}, (candidate) => candidate === adjacentNpmCli), adjacentNpmCli, 'adjacent Windows-style npm layout');
assert.equal(resolveNpmCli(fakeNode, {}, (candidate) => candidate === globalNpmCli), globalNpmCli, 'Unix global npm layout');
assert.equal(resolveNpmCli(fakeNode, { npm_execpath: envNpmCli }, (candidate) => candidate === envNpmCli), envNpmCli, 'npm_execpath takes precedence');
mustThrow('missing npm CLI', () => resolveNpmCli(fakeNode, {}, () => false), /cannot resolve npm-cli\.js/);
assert.deepEqual(parseNpmPackFiles('[{"files":[{"path":"z"},{"path":"a"}]}]'), ['a', 'z']);
mustThrow('malformed npm pack JSON', () => parseNpmPackFiles('{'), /did not return valid JSON/);
mustThrow('multiple npm pack entries', () => parseNpmPackFiles('[{"files":[]},{"files":[]}]'), /exactly one package entry/);
mustThrow('malformed npm pack file row', () => parseNpmPackFiles('[{"files":[{}]}]'), /files\[0\]\.path must be a string/);

const tmpRoot = mkdtempSync(join(tmpdir(), 'pi-bg-doc-fixture-'));
try {
  mkdirSync(join(tmpRoot, 'docs'), { recursive: true });
  writeFileSync(join(tmpRoot, 'docs', 'bad.md'), '# Missing frontmatter\n');
  mustThrow('new malformed doc discovered', () => loadDocsModel({ packageRoot: tmpRoot }), /missing frontmatter/);
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

const first = generateDocTexts(codeFacts, docsModel);
const second = generateDocTexts(codeFacts, docsModel);
assert.equal(JSON.stringify(first), JSON.stringify(second), 'nondeterminism fixture');

console.log('docs-selftest: mutation fixtures passed');

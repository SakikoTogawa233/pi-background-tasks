import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const root = new URL('../../', import.meta.url);

function text(path: string): string {
  return readFileSync(new URL(path, root), 'utf8');
}

void describe('docs package integration contract', () => {
  void it('declares docs scripts, prepack gates, and packaged docs payload', () => {
    const pkg = JSON.parse(text('package.json')) as {
      name: string;
      version: string;
      repository: { url: string };
      homepage: string;
      bugs: { url: string };
      files: string[];
      scripts: Record<string, string>;
      pi?: { image?: string };
    };
    assert.equal(pkg.name, '@sakiko233/pi-background-tasks');
    assert.equal(pkg.version, '2.5.1');
    assert.equal(
      pkg.repository.url,
      'git+https://github.com/SakikoTogawa233/pi-background-tasks.git',
    );
    assert.equal(pkg.homepage, 'https://github.com/SakikoTogawa233/pi-background-tasks#readme');
    assert.equal(pkg.bugs.url, 'https://github.com/SakikoTogawa233/pi-background-tasks/issues');
    assert.ok(pkg.files.includes('docs/'));
    assert.ok(pkg.files.includes('BACKGROUND-TASKS-INSTRUCTIONS.md'));
    assert.ok(pkg.files.includes('logo.png'));
    assert.equal(
      pkg.pi?.image,
      'https://raw.githubusercontent.com/SakikoTogawa233/pi-background-tasks/main/logo.png',
    );
    assert.equal(pkg.scripts['docs:generate'], 'node scripts/docs/generate.mjs');
    assert.equal(pkg.scripts['docs:verify'], 'node scripts/docs/verify.mjs');
    assert.equal(
      pkg.scripts['docs:verify:attestations'],
      'node scripts/docs/verify.mjs --require-attestations',
    );
    assert.equal(pkg.scripts['docs:attest/record'], 'node scripts/docs/attest.mjs');
    assert.equal(
      pkg.scripts['test:docs'],
      'tsx --test tests/unit/docs-gate.test.ts tests/package/docs-contract.test.ts',
    );
    assert.equal(pkg.scripts['payload:check'], 'node scripts/check-package-payload.mjs');
    assert.equal(pkg.scripts['release:check-version'], 'node scripts/check-release-version.mjs');
    assert.match(pkg.scripts['prepack'] ?? '', /docs:verify/);
    assert.match(pkg.scripts['prepack'] ?? '', /payload:check/);
    for (const path of [
      'docs/INDEX.md',
      'docs/read-before-edit.md',
      'docs/manifest.json',
      'docs/attestations.json',
      'docs/subsystems/docs-freshness-gate.md',
    ]) {
      assert.ok(existsSync(new URL(path, root)), `${path} must exist`);
    }
  });

  void it('pins repository-secret npm authentication and separate provenance identity', () => {
    const workflow = text('.github/workflows/release.yml');
    assert.match(workflow, /registry-url: 'https:\/\/registry\.npmjs\.org'/);
    assert.match(workflow, /npm publish --provenance --access public/);
    assert.match(workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
    assert.match(workflow, /id-token: write/);
    assert.doesNotMatch(workflow, /Publish to npm \(trusted publisher \/ OIDC\)/);

    const publishing = text('PUBLISHING.md');
    assert.match(publishing, /GitHub Actions repository secret `NPM_TOKEN`/);
    assert.match(publishing, /maps the `NPM_TOKEN` GitHub Actions repository secret to `NODE_AUTH_TOKEN`/);
    assert.match(publishing, /provenance using GitHub Actions' OIDC identity/);

    const releasing = text('docs/operations/releasing.md');
    assert.match(releasing, /mapping the authorized `NPM_TOKEN` GitHub Actions repository secret to `NODE_AUTH_TOKEN`/);
    assert.match(releasing, /Registry authentication uses the npm token/);
    assert.match(releasing, /provenance attestation separately uses GitHub Actions' OIDC identity/);
  });

  void it('pins reviewed runtime and generated artifact semantics', () => {
    const contracts = text('docs/reference/runtime-contracts.md');
    assert.match(contracts, /candidate-<slot>\.attempt-<n>/);
    assert.match(contracts, /evaluation\.attempt-<n>\.response\.txt/);
    assert.match(contracts, /merge\.attempt-<n>\.response\.md/);
    assert.match(contracts, /tool-calls\.jsonl\.seal\.json/);
    assert.doesNotMatch(contracts, /<stage>\[\.<slot>\]/);

    assert.match(text('docs/commands/task-manager.md'), /exact task id opens detail view/);
    assert.match(text('docs/api/eventbus-v1.md'), /at least once under emission failure/);
    assert.match(text('docs/api/eventbus-v1.md'), /later requests are not handled/);
    assert.match(text('docs/subsystems/background-task-runtime.md'), /rather than issuing `fsync`/);
    assert.match(
      text('docs/subsystems/background-task-runtime.md'),
      /may occur after the completion notification/,
    );
    assert.match(
      text('docs/subsystems/attested-pi-runs.md'),
      /last assistant `stopReason` value reported/,
    );
    assert.match(text('docs/subsystems/delegation.md'), /Inside `preflightDelegateLaunch\(\)`/);
    assert.match(text('docs/subsystems/delegation.md'), /Windows skips directory fsync/);
    assert.match(
      text('docs/subsystems/delegation.md'),
      /best-effort durable write of `outcome\.json`/,
    );
    assert.match(text('docs/subsystems/host-ui-and-telemetry.md'), /detail view is opened/);
    assert.match(text('docs/subsystems/host-ui-and-telemetry.md'), /dock is closed/);
    assert.doesNotMatch(
      text('docs/reference/shortcuts-and-dock.md'),
      /Opening or closing the dock does not clear them/,
    );
    assert.match(
      text('docs/commands/fusion-models.md'),
      /typed text—including `q`—filters the list/,
    );
    assert.match(text('docs/commands/fusion-models.md'), /Esc returns to the slots/);
    assert.match(
      text('docs/tools/fusion_research.md'),
      /DNS\/redirect transport classification does not explicitly include/,
    );
    assert.match(
      text('docs/subsystems/fusion.md'),
      /deny rules are not an exhaustive network sandbox/,
    );
  });
});

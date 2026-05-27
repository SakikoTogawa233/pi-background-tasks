import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = new URL("../../", import.meta.url);
async function pkg() { return JSON.parse(await readFile(new URL("package.json", root), "utf8")); }
async function text(file: string) { return readFile(new URL(file, root), "utf8"); }

describe("package", () => {
	it("manifest/docs cover public extension surfaces", async () => {
		const p = await pkg();
		assert.equal(p.name, "pi-background-tasks");
		assert.equal(p.type, "module");
		assert.ok(p.keywords.includes("pi-package"));
		assert.ok(p.keywords.includes("pi-extension"));
		assert.deepEqual(p.pi.extensions, ["./extensions/background-tasks.ts"]);
		assert.ok(p.files.includes("extensions/"));
		assert.ok(p.files.includes("src/"));
		assert.ok(p.peerDependencies["@earendil-works/pi-coding-agent"]);
		assert.ok(p.peerDependencies["@earendil-works/pi-tui"]);
		assert.ok(p.peerDependencies.typebox);
		for (const f of ["README.md", "TESTING.md", "TEST_PLAN.md", "PUBLISHING.md", "LICENSE", "src/extension.ts", "src/ui/background-tasks-manager.ts", "src/core/common.ts", "extensions/background-tasks.ts"]) assert.ok(existsSync(new URL(f, root)), f);

		const readme = await text("README.md");
		const plan = await text("TEST_PLAN.md");
		for (const surface of ["/bg", "/jobs", "/logs", "/kill", "/tasks", "/bg-tasks", "bg_run", "bg_status", "bg_logs", "bg_kill", "Shift+Down", "Shift+C"]) {
			assert.match(readme, new RegExp(surface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `README missing ${surface}`);
			assert.match(plan, new RegExp(surface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `TEST_PLAN missing ${surface}`);
		}
	});

	it("packs exactly the runtime/docs payload and excludes tests/artifacts", () => {
		const r = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8", env: { ...process.env, NPM_CONFIG_CACHE: "/tmp/pi-npm-cache" } });
		assert.equal(r.status, 0, r.stderr);
		const files = JSON.parse(r.stdout)[0].files.map((f: any) => f.path).sort();
		for (const f of ["extensions/background-tasks.ts", "src/extension.ts", "src/core/common.ts", "src/ui/background-tasks-manager.ts", "src/testing/normalize.ts", "README.md", "TESTING.md", "TEST_PLAN.md", "PUBLISHING.md", "LICENSE", "package.json"]) assert.ok(files.includes(f), f);
		assert.ok(!files.some((f: string) => f.startsWith("tests/")), "tests must not ship");
		assert.ok(!files.some((f: string) => f.includes("node_modules")), "node_modules must not ship");
		assert.ok(!files.some((f: string) => f.endsWith(".tgz")), "nested tarballs must not ship");
	});

	it("local tarball installs with the expected package files", async () => {
		const temp = await mkdtemp(join(tmpdir(), "pi-bg-pack-"));
		try {
			const pack = spawnSync("npm", ["pack", "--json"], { cwd: root, encoding: "utf8", env: { ...process.env, NPM_CONFIG_CACHE: "/tmp/pi-npm-cache" } });
			assert.equal(pack.status, 0, pack.stderr);
			const tarball = JSON.parse(pack.stdout)[0].filename;
			const tarballPath = new URL(tarball, root).pathname;
			const init = spawnSync("npm", ["init", "-y"], { cwd: temp, encoding: "utf8", env: { ...process.env, NPM_CONFIG_CACHE: "/tmp/pi-npm-cache" } });
			assert.equal(init.status, 0, init.stderr);
			const install = spawnSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], { cwd: temp, encoding: "utf8", env: { ...process.env, NPM_CONFIG_CACHE: "/tmp/pi-npm-cache" } });
			assert.equal(install.status, 0, install.stderr);
			for (const f of ["package.json", "extensions/background-tasks.ts", "src/extension.ts", "src/ui/background-tasks-manager.ts"]) {
				assert.ok(existsSync(join(temp, "node_modules", "pi-background-tasks", f)), f);
			}
		} finally {
			await rm(temp, { recursive: true, force: true });
			await rm(new URL("pi-background-tasks-0.2.0.tgz", root), { force: true });
		}
	});
});

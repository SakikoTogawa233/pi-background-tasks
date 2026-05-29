import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

type PackageJson = {
	name: string;
	type: string;
	keywords: string[];
	pi: { extensions: string[] };
	scripts: Record<string, string>;
	files: string[];
	peerDependencies: Record<string, string>;
};

type NpmPackEntry = {
	filename: string;
	files: Array<{ path: string }>;
};

const root = new URL("../../", import.meta.url);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
	return value;
}

function requireStringArray(value: unknown, label: string): string[] {
	assert.ok(Array.isArray(value), `${label} must be an array`);
	assert.ok(value.every((item) => typeof item === "string"), `${label} must contain strings`);
	return value;
}

function parsePackageJson(value: unknown): PackageJson {
	assert.ok(isRecord(value), "package.json must be an object");
	const name = requireString(value["name"], "name");
	const type = requireString(value["type"], "type");
	const pi = value["pi"];
	const scripts = value["scripts"];
	const peerDependencies = value["peerDependencies"];
	assert.ok(isRecord(pi));
	assert.ok(isRecord(scripts));
	assert.ok(isRecord(peerDependencies));
	return {
		name,
		type,
		keywords: requireStringArray(value["keywords"], "keywords"),
		pi: { extensions: requireStringArray(pi["extensions"], "pi.extensions") },
		scripts: Object.fromEntries(Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
		files: requireStringArray(value["files"], "files"),
		peerDependencies: Object.fromEntries(Object.entries(peerDependencies).filter((entry): entry is [string, string] => typeof entry[1] === "string")),
	};
}

async function pkg(): Promise<PackageJson> {
	return parsePackageJson(JSON.parse(await readFile(new URL("package.json", root), "utf8")) as unknown);
}

async function text(file: string): Promise<string> {
	return readFile(new URL(file, root), "utf8");
}

function parsePackEntries(stdout: string): NpmPackEntry[] {
	const parsed = JSON.parse(stdout) as unknown;
	assert.ok(Array.isArray(parsed), "npm pack output must be an array");
	return parsed.map((entry): NpmPackEntry => {
		assert.ok(isRecord(entry), "pack entry must be an object");
		const filename = requireString(entry["filename"], "pack filename");
		const files = entry["files"];
		assert.ok(Array.isArray(files), "pack entry files must be an array");
		return {
			filename,
			files: files.map((file): { path: string } => {
				assert.ok(isRecord(file), "pack file must be an object");
				const path = requireString(file["path"], "pack file path");
				return { path };
			}),
		};
	});
}

describe("package", () => {
	it("manifest/docs cover public extension surfaces", async () => {
		const p = await pkg();
		assert.equal(p.name, "pi-background-tasks");
		assert.equal(p.type, "module");
		assert.ok(p.keywords.includes("pi-package"));
		assert.ok(p.keywords.includes("pi-extension"));
		assert.deepEqual(p.pi.extensions, ["./extensions/background-tasks.ts"]);
		assert.match(p.scripts["test:agent-loop"] ?? "", /scripted-provider/);
		assert.match(p.scripts["test:full"] ?? "", /test:agent-loop/);
		assert.ok(p.files.includes("extensions/"));
		assert.ok(p.files.includes("src/"));
		assert.ok(p.peerDependencies["@earendil-works/pi-coding-agent"]);
		assert.ok(p.peerDependencies["@earendil-works/pi-tui"]);
		assert.ok(p.peerDependencies["typebox"]);
		for (const f of ["README.md", "TESTING.md", "TEST_PLAN.md", "PUBLISHING.md", "LICENSE", "src/extension.ts", "src/ui/background-tasks-manager.ts", "src/core/common.ts", "src/core/registry.ts", "extensions/background-tasks.ts"]) assert.ok(existsSync(new URL(f, root)), f);

		const readme = await text("README.md");
		const plan = await text("TEST_PLAN.md");
		for (const surface of ["/bg", "/jobs", "/logs", "/kill", "/tasks", "/bg-tasks", "/bg-clear", "/bg-update", "bg_run", "bg_status", "bg_logs", "bg_kill", "Shift+Down", "Ctrl+Alt+C"]) {
			assert.match(readme, new RegExp(surface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `README missing ${surface}`);
			assert.match(plan, new RegExp(surface.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `TEST_PLAN missing ${surface}`);
		}
	});

	it("packs exactly the runtime/docs payload and excludes tests/artifacts", () => {
		const r = spawnSync("npm", ["pack", "--dry-run", "--json"], { cwd: root, encoding: "utf8", env: { ...process.env, NPM_CONFIG_CACHE: "/tmp/pi-npm-cache" } });
		assert.equal(r.status, 0, r.stderr);
		const firstEntry = parsePackEntries(r.stdout)[0];
		assert.ok(firstEntry, "npm pack must return one entry");
		const files = firstEntry.files.map((file) => file.path).sort();
		for (const f of ["extensions/background-tasks.ts", "src/extension.ts", "src/core/common.ts", "src/core/registry.ts", "src/ui/background-tasks-manager.ts", "src/testing/normalize.ts", "README.md", "TESTING.md", "TEST_PLAN.md", "PUBLISHING.md", "LICENSE", "package.json"]) assert.ok(files.includes(f), f);
		assert.ok(!files.some((f) => f.startsWith("tests/")), "tests must not ship");
		assert.ok(!files.some((f) => f.includes("node_modules")), "node_modules must not ship");
		assert.ok(!files.some((f) => f.endsWith(".tgz")), "nested tarballs must not ship");
	});

	it("local tarball installs with the expected package files", async () => {
		const temp = await mkdtemp(join(tmpdir(), "pi-bg-pack-"));
		try {
			const pack = spawnSync("npm", ["pack", "--json"], { cwd: root, encoding: "utf8", env: { ...process.env, NPM_CONFIG_CACHE: "/tmp/pi-npm-cache" } });
			assert.equal(pack.status, 0, pack.stderr);
			const firstEntry = parsePackEntries(pack.stdout)[0];
			assert.ok(firstEntry, "npm pack must return one entry");
			const tarballPath = new URL(firstEntry.filename, root).pathname;
			const init = spawnSync("npm", ["init", "-y"], { cwd: temp, encoding: "utf8", env: { ...process.env, NPM_CONFIG_CACHE: "/tmp/pi-npm-cache" } });
			assert.equal(init.status, 0, init.stderr);
			const install = spawnSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarballPath], { cwd: temp, encoding: "utf8", env: { ...process.env, NPM_CONFIG_CACHE: "/tmp/pi-npm-cache" } });
			assert.equal(install.status, 0, install.stderr);
			for (const f of ["package.json", "extensions/background-tasks.ts", "src/extension.ts", "src/core/registry.ts", "src/ui/background-tasks-manager.ts"]) {
				assert.ok(existsSync(join(temp, "node_modules", "pi-background-tasks", f)), f);
			}
		} finally {
			await rm(temp, { recursive: true, force: true });
			await rm(new URL("pi-background-tasks-0.4.0.tgz", root), { force: true });
		}
	});
});

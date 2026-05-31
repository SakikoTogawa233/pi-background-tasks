import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BackgroundTaskRegistry, commandMayLaunchPiAgent, type BackgroundTaskContext, type BackgroundTaskSpawn, type CompletionNotificationMessage, type CompletionNotificationOptions } from "../../src/core/registry.js";
import type { BgTask } from "../../src/core/common.js";

class FakeChild extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	pid: number;
	killCalls: Array<NodeJS.Signals | string | undefined> = [];
	killImpl: (signal?: NodeJS.Signals | string) => boolean;

	constructor(pid: number, killImpl?: (signal?: NodeJS.Signals | string) => boolean) {
		super();
		this.pid = pid;
		this.killImpl = killImpl ?? (() => true);
	}

	kill(signal?: NodeJS.Signals | string): boolean {
		this.killCalls.push(signal);
		return this.killImpl(signal);
	}

	writeStdout(value: string): void {
		this.stdout.emit("data", Buffer.from(value, "utf8"));
	}

	writeStderr(value: string): void {
		this.stderr.emit("data", Buffer.from(value, "utf8"));
	}

	close(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
		this.emit("close", code, signal);
	}

	fail(error: Error): void {
		this.emit("error", error);
	}
}

type SpawnRecord = {
	child: FakeChild;
	shell: string;
	args: string[];
	options: Parameters<BackgroundTaskSpawn>[2];
};

type HarnessOptions = {
	platform?: NodeJS.Platform;
	maxRecentTasks?: number;
	maxOutputBytes?: number;
	killGraceMs?: number;
	stopWaitMs?: number;
	killProcess?: (pid: number, signal?: NodeJS.Signals | number) => boolean;
	sendCompletionNotification?: (message: CompletionNotificationMessage, options: CompletionNotificationOptions) => void;
	logger?: Pick<Console, "error">;
	makeTaskId?: () => string;
	now?: () => number;
	env?: NodeJS.ProcessEnv;
	childFactory?: (pid: number) => FakeChild;
};

async function createHarness(options: HarnessOptions = {}) {
	const root = await mkdtemp(join(tmpdir(), "pi-bg-registry-"));
	const cwd = join(root, "project");
	await mkdir(cwd, { recursive: true });
	let pid = 4200;
	let idSeq = 0;
	const children: SpawnRecord[] = [];
	const notifications: Array<{ message: CompletionNotificationMessage; options: CompletionNotificationOptions }> = [];
	const errors: unknown[][] = [];
	let changes = 0;
	const registryOptions: ConstructorParameters<typeof BackgroundTaskRegistry>[0] = {
		logger: options.logger ?? { error: (...args: unknown[]) => { errors.push(args); } },
		makeTaskId: options.makeTaskId ?? (() => `bunit${String(++idSeq).padStart(3, "0")}`),
		sendCompletionNotification: options.sendCompletionNotification ?? ((message, opts) => {
			notifications.push({ message, options: opts });
		}),
		onChange: () => { changes++; },
		spawn: (shell, args, spawnOptions) => {
			const child = options.childFactory?.(++pid) ?? new FakeChild(++pid);
			children.push({ child, shell, args: [...args], options: spawnOptions });
			return child;
		},
	};
	if (options.platform !== undefined) registryOptions.platform = options.platform;
	if (options.env !== undefined) registryOptions.env = options.env;
	if (options.maxRecentTasks !== undefined) registryOptions.maxRecentTasks = options.maxRecentTasks;
	if (options.maxOutputBytes !== undefined) registryOptions.maxOutputBytes = options.maxOutputBytes;
	if (options.killGraceMs !== undefined) registryOptions.killGraceMs = options.killGraceMs;
	if (options.stopWaitMs !== undefined) registryOptions.stopWaitMs = options.stopWaitMs;
	if (options.now !== undefined) registryOptions.now = options.now;
	if (options.killProcess !== undefined) registryOptions.killProcess = options.killProcess;
	const registry = new BackgroundTaskRegistry(registryOptions);
	const ctx: BackgroundTaskContext = {
		cwd,
		sessionId: "registry-test",
		modelRegistry: { getAll: () => [] },
		model: undefined,
	};
	return { root, cwd, ctx, registry, children, notifications, errors, get changes() { return changes; } };
}

async function cleanup(root: string) {
	await rm(root, { recursive: true, force: true });
}

async function waitFor(predicate: () => boolean, message = "condition", timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error(`Timed out waiting for ${message}`);
}

async function readJsonEventually(path: string, timeoutMs = 1000): Promise<unknown> {
	const start = Date.now();
	let last = "";
	while (Date.now() - start < timeoutMs) {
		last = await readFile(path, "utf8").catch(() => "");
		try {
			if (last.trim()) return JSON.parse(last);
		} catch {
			// Retry while async metadata writes settle.
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	return JSON.parse(last);
}

async function startFakeTask(h: Awaited<ReturnType<typeof createHarness>>, name = "Registry Task"): Promise<{ task: BgTask; child: FakeChild }> {
	const task = await h.registry.startTask(h.ctx, "node fake.js", { name, isAgent: false, notifyOnCompletion: true, triggerOnCompletion: true });
	const child = h.children.at(-1)?.child;
	assert.ok(child);
	return { task, child };
}

describe("BackgroundTaskRegistry", () => {
	it("uses explicit isAgent to decide Pi telemetry wrapping", async () => {
		assert.equal(commandMayLaunchPiAgent("pi -p hello"), true);
		assert.equal(commandMayLaunchPiAgent("/usr/local/bin/pi -p hello"), false, "shell-function wrapper cannot intercept path-qualified pi commands");

		const h = await createHarness({ platform: "linux" });
		try {
			const scriptLikePi = await h.registry.startTask(h.ctx, "pi -p hello", { name: "Plain Pi Script", isAgent: false, notifyOnCompletion: false });
			assert.equal(scriptLikePi.isAgent, false);
			assert.doesNotMatch(h.children.at(-1)!.args.join("\n"), /pi-telemetry-wrapper/);

			const agentPi = await h.registry.startTask(h.ctx, "pi -p hello", { name: "Agent Pi", isAgent: true, notifyOnCompletion: false });
			assert.equal(agentPi.isAgent, true);
			assert.match(h.children.at(-1)!.args.join("\n"), /pi\(\) \{ node .*pi-telemetry-wrapper\.cjs/);

			const pathQualifiedPi = await h.registry.startTask(h.ctx, "/usr/local/bin/pi -p hello", { name: "Path Pi", isAgent: true, notifyOnCompletion: false });
			assert.equal(pathQualifiedPi.isAgent, true);
			assert.doesNotMatch(h.children.at(-1)!.args.join("\n"), /pi-telemetry-wrapper/);
		} finally {
			await cleanup(h.root);
		}

		const disabled = await createHarness({ env: { ...process.env, PI_BG_DISABLE_PI_TELEMETRY: "1" } });
		try {
			await disabled.registry.startTask(disabled.ctx, "pi -p hello", { name: "Disabled Agent", isAgent: true, notifyOnCompletion: false });
			assert.doesNotMatch(disabled.children.at(-1)!.args.join("\n"), /pi-telemetry-wrapper/);
		} finally {
			await cleanup(disabled.root);
		}
	});

	it("uses POSIX process-group kill before child fallback", async () => {
		let childRef: FakeChild | undefined;
		const killCalls: Array<{ pid: number; signal?: NodeJS.Signals | number }> = [];
		const h = await createHarness({
			platform: "darwin",
			killProcess: (pid, signal) => {
				const call: { pid: number; signal?: NodeJS.Signals | number } = { pid };
				if (signal !== undefined) call.signal = signal;
				killCalls.push(call);
				queueMicrotask(() => childRef?.close(null, typeof signal === "string" ? signal : null));
				return true;
			},
			childFactory: (pid) => {
				childRef = new FakeChild(pid);
				return childRef;
			},
		});
		try {
			const { task, child } = await startFakeTask(h);
			await h.registry.stopTask(task, "user");
			assert.deepEqual(killCalls, [{ pid: -child.pid, signal: "SIGTERM" }]);
			assert.deepEqual(child.killCalls, []);
			assert.equal(task.status, "killed");
		} finally {
			await cleanup(h.root);
		}
	});

	it("falls back to child.kill when process-group kill fails and reports when both fail", async () => {
		const h = await createHarness({
			platform: "linux",
			killProcess: () => { throw new Error("group unavailable"); },
			childFactory: (pid) => new FakeChild(pid, function (this: FakeChild, signal) {
				queueMicrotask(() => this.close(null, signal as NodeJS.Signals));
				return true;
			}),
		});
		try {
			const { task, child } = await startFakeTask(h, "Fallback Kill");
			await h.registry.stopTask(task, "user");
			assert.deepEqual(child.killCalls, ["SIGTERM"]);
			assert.equal(task.status, "killed");
		} finally {
			await cleanup(h.root);
		}

		const failing = await createHarness({
			platform: "linux",
			killProcess: () => { throw new Error("group unavailable"); },
			childFactory: (pid) => new FakeChild(pid, () => { throw new Error("child unavailable"); }),
		});
		try {
			const { task } = await startFakeTask(failing, "Failed Kill");
			await assert.rejects(() => failing.registry.stopTask(task, "user"), /Could not kill task[\s\S]*group unavailable[\s\S]*child unavailable/);
			assert.equal(task.status, "running");
		} finally {
			await cleanup(failing.root);
		}
	});

	it("skips process-group kill on Windows and invokes child.kill directly", async () => {
		let processKillCalled = false;
		const h = await createHarness({
			platform: "win32",
			killProcess: () => { processKillCalled = true; return true; },
			childFactory: (pid) => new FakeChild(pid, function (this: FakeChild, signal) {
				queueMicrotask(() => this.close(null, signal as NodeJS.Signals));
				return true;
			}),
		});
		try {
			const { task, child } = await startFakeTask(h, "Windows Kill");
			await h.registry.stopTask(task, "user");
			assert.equal(processKillCalled, false);
			assert.deepEqual(child.killCalls, ["SIGTERM"]);
			assert.equal(h.children[0]!.shell.toLowerCase(), "cmd.exe");
			assert.deepEqual(h.children[0]!.args.slice(0, 3), ["/d", "/s", "/c"]);
		} finally {
			await cleanup(h.root);
		}
	});

	it("keeps duplicate stop requests idempotent and escalates to SIGKILL after grace", async () => {
		let childRef: FakeChild | undefined;
		const killCalls: Array<NodeJS.Signals | number | undefined> = [];
		const h = await createHarness({
			platform: "linux",
			killGraceMs: 20,
			stopWaitMs: 500,
			killProcess: (_pid, signal) => {
				killCalls.push(signal);
				if (signal === "SIGKILL") queueMicrotask(() => childRef?.close(null, "SIGKILL"));
				return true;
			},
			childFactory: (pid) => {
				childRef = new FakeChild(pid);
				return childRef;
			},
		});
		try {
			const { task } = await startFakeTask(h, "Escalate Kill");
			const first = h.registry.stopTask(task, "user");
			const second = h.registry.stopTask(task, "user");
			await Promise.all([first, second]);
			assert.deepEqual(killCalls, ["SIGTERM", "SIGKILL"]);
			assert.equal(task.status, "killed");
		} finally {
			await cleanup(h.root);
		}
	});

	it("finalizes and notifies once under error/close and output-cap races", async () => {
		const h = await createHarness({
			maxOutputBytes: 8,
			killProcess: () => true,
		});
		try {
			const { task, child } = await startFakeTask(h, "Race Failure");
			child.fail(new Error("spawn exploded"));
			child.close(0, null);
			await waitFor(() => task.status !== "running", "spawn race finalization");
			await waitFor(() => h.notifications.length === 1, "single spawn-race notification");
			assert.equal(task.status, "failed");
			assert.match(task.error ?? "", /spawn exploded/);
			assert.equal(h.notifications.length, 1);

			const capped = await h.registry.startTask(h.ctx, "node noisy.js", { name: "Output Race", notifyOnCompletion: true, triggerOnCompletion: true });
			const cappedChild = h.children.at(-1)!.child;
			cappedChild.writeStdout("0123456789abcdef");
			cappedChild.close(1, null);
			cappedChild.close(0, null);
			await waitFor(() => capped.status !== "running", "output-cap finalization");
			await waitFor(() => h.notifications.length === 2, "single output-cap notification");
			assert.equal(capped.status, "failed");
			assert.match(capped.error ?? "", /Output exceeded cap/);
			assert.equal(h.notifications.length, 2);
		} finally {
			await cleanup(h.root);
		}
	});

	it("resets notified when completion notification delivery fails and records loud metadata errors", async () => {
		const failingNotify = await createHarness({
			sendCompletionNotification: () => { throw new Error("send failed"); },
		});
		try {
			const { task, child } = await startFakeTask(failingNotify, "Notify Failure");
			child.close(0, null);
			await waitFor(() => task.status === "completed", "notification failure task completion");
			await waitFor(() => failingNotify.errors.length > 0, "notification failure log");
			assert.equal(task.notified, false);
			const metadata = JSON.parse(await readFile(task.metadataAbsPath, "utf8"));
			assert.equal(metadata.notified, false);
			assert.match(String(failingNotify.errors.flat().join(" ")), /notification failed|send failed/);
		} finally {
			await cleanup(failingNotify.root);
		}

		const metadataFailure = await createHarness();
		try {
			const { task, child } = await startFakeTask(metadataFailure, "Metadata Failure");
			await rm(join(metadataFailure.cwd, ".pi"), { recursive: true, force: true });
			child.close(0, null);
			await waitFor(() => task.status === "completed", "metadata failure task completion");
			await waitFor(() => metadataFailure.notifications.length === 1, "notification despite metadata failure");
			await waitFor(() => metadataFailure.errors.length > 0, "metadata failure log");
			assert.equal(task.notified, true);
			assert.match(String(metadataFailure.errors.flat().join(" ")), /failed to (update )?metadata|ENOENT/);
		} finally {
			await cleanup(metadataFailure.root);
		}
	});

	it("ingests split, malformed, and large telemetry records without losing task state", async () => {
		const h = await createHarness();
		try {
			const { task, child } = await startFakeTask(h, "Telemetry Chunks");
			child.writeStdout("not-json-but-user-output\n");
			child.writeStdout("{\"type\":\"background-task-telemetry\",");
			assert.equal(task.contextUsage, undefined);

			const byName = Object.fromEntries(Array.from({ length: 2500 }, (_, index) => [`tool-${index}`, 1]));
			const telemetry = JSON.stringify({
				type: "background-task-telemetry",
				contextUsage: { tokens: 12_345, contextWindow: 200_000, percent: 6.1725 },
				tokenUsage: { input: 10_000, output: 2000, cacheRead: 300, cacheWrite: 45, totalTokens: 12_345 },
				toolUsage: { total: 2500, failed: 3, byName },
				model: "openai-codex/gpt-5.5",
			});
			assert.ok(telemetry.length > 16 * 1024, "fixture must exceed the old 16KiB telemetry buffer");
			const continuation = telemetry.replace(/^\{\"type\":\"background-task-telemetry\",/, "");
			for (const chunk of [`${continuation.slice(0, 257)}`, ...continuation.slice(257).match(/.{1,113}/gs) ?? [], "\n"]) {
				child.writeStdout(chunk);
			}

			assert.deepEqual(task.contextUsage, { tokens: 12_345, contextWindow: 200_000, percent: 6.1725 });
			assert.deepEqual(task.tokenUsage, { input: 10_000, output: 2000, cacheRead: 300, cacheWrite: 45, totalTokens: 12_345 });
			assert.equal(task.toolUsage?.total, 2500);
			assert.equal(task.toolUsage?.failed, 3);
			assert.equal(task.toolUsage?.byName["tool-2499"], 1);
			assert.equal(task.model, "openai-codex/gpt-5.5");

			child.writeStdout('{"type":"background-task-telemetry",bad}\n');
			assert.equal(task.toolUsage?.total, 2500);
			assert.equal(task.model, "openai-codex/gpt-5.5");
			child.close(0, null);
			await waitFor(() => task.status === "completed", "telemetry task completion");
			const metadata = await readJsonEventually(task.metadataAbsPath);
			assert.deepEqual(metadata.tokenUsage, task.tokenUsage);
			assert.equal(metadata.toolUsage.byName["tool-2499"], 1);
			assert.equal(metadata.model, "openai-codex/gpt-5.5");
		} finally {
			await cleanup(h.root);
		}
	});

	it("renders wrapped Pi-agent activity transcripts and keeps telemetry out of the output file", async () => {
		const h = await createHarness({ platform: "linux" });
		try {
			const task = await h.registry.startTask(h.ctx, "pi -p hello", { name: "Wrapped Agent", isAgent: true, notifyOnCompletion: false });
			assert.equal(task.telemetryWrapped, true);
			const child = h.children.at(-1)?.child;
			assert.ok(child);

			child.writeStdout('{"type":"background-task-activity","kind":"tool_start","tool":"read","argsSummary":"README.md"}\n');
			// Telemetry split across two stdout chunks must reassemble before parsing.
			child.writeStdout('{"type":"background-task-telemetry","tokenUsage":{"input":10,"output":5,"cacheRead":0,"cacheWrite":0,"totalTokens":15},');
			child.writeStdout('"toolUsage":{"total":1,"failed":1,"byName":{"read":1}},"model":"prov/model","contextUsage":{"tokens":15,"contextWindow":1000,"percent":1.5}}\n');
			child.writeStdout('{"type":"background-task-activity","kind":"tool_end","tool":"read","isError":true,"error":"boom"}\n');
			child.writeStdout('{"type":"background-task-activity","kind":"assistant_text","text":"final answer"}\n');
			child.writeStderr("child stderr diagnostic\n");
			// Trailing partial line (no newline) must be flushed verbatim on finalize.
			child.writeStdout("trailing fragment without newline");

			assert.deepEqual(task.tokenUsage, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 });
			assert.deepEqual(task.toolUsage, { total: 1, failed: 1, byName: { read: 1 } });
			assert.equal(task.model, "prov/model");
			assert.deepEqual(task.contextUsage, { tokens: 15, contextWindow: 1000, percent: 1.5 });

			child.close(0, null);
			await waitFor(() => task.status === "completed", "wrapped-agent completion");

			let output = "";
			await waitFor(() => {
				try {
					output = readFileSync(task.outputAbsPath, "utf8");
				} catch {
					output = "";
				}
				return /trailing fragment without newline/.test(output);
			}, "wrapped-agent transcript flushed");

			assert.match(output, /\u2192 read README\.md/);
			assert.match(output, /\u2717 read failed: boom/);
			assert.match(output, /^final answer$/m);
			assert.match(output, /child stderr diagnostic/);
			assert.doesNotMatch(output, /background-task-telemetry/);
			assert.doesNotMatch(output, /background-task-activity/);
			assert.doesNotMatch(output, /"kind"/);
		} finally {
			await cleanup(h.root);
		}
	});

	it("preserves split multiline XML context telemetry across newline boundaries", async () => {
		const h = await createHarness();
		try {
			const { task, child } = await startFakeTask(h, "XML Telemetry");
			child.writeStdout("prefix\n<background-task-context-usage>\n  <tokens>321</tokens>\n");
			assert.equal(task.contextUsage, undefined);
			child.writeStdout("  <context-window>1000</context-window>\n  <percent>32.1</percent>\n</background-task-context-usage>\n");
			assert.deepEqual(task.contextUsage, { tokens: 321, contextWindow: 1000, percent: 32.1 });
			child.close(0, null);
			await waitFor(() => task.status === "completed", "xml telemetry task completion");
		} finally {
			await cleanup(h.root);
		}
	});

	it("prunes oldest finished tasks while preserving running tasks", async () => {
		let clock = 1_000;
		const h = await createHarness({
			maxRecentTasks: 3,
			now: () => clock++,
		});
		try {
			const running = await h.registry.startTask(h.ctx, "sleep forever", { name: "Still Running", notifyOnCompletion: false });
			assert.equal(running.status, "running");

			for (let i = 1; i <= 4; i++) {
				const task = await h.registry.startTask(h.ctx, `printf ${i}`, { name: `Finished ${i}`, notifyOnCompletion: false });
				h.children.at(-1)!.child.close(0, null);
				await waitFor(() => task.status === "completed", `finished ${i}`);
			}

			await waitFor(() => h.registry.allTasks().length <= 3, "old finished tasks pruned");
			const names = h.registry.allTasks().map((task) => task.name).sort();
			assert.deepEqual(names, ["Finished 3", "Finished 4", "Still Running"].sort());
		} finally {
			await cleanup(h.root);
		}
	});
});

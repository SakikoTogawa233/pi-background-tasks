import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";

const extensionPath = resolve("extensions/background-tasks.ts");
const roots: string[] = [];

async function harness() {
	const root = await mkdtemp(join(tmpdir(), "pi-bg-sdk-"));
	roots.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	const settingsManager = SettingsManager.inMemory();
	const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, additionalExtensionPaths: [extensionPath], noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true, noThemes: true });
	await loader.reload();
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd), settingsManager, authStorage, modelRegistry, noTools: "builtin" });
	return { session, cwd };
}

async function exec(session: AgentSession, name: string, params: any) {
	const tool = session.getToolDefinition(name);
	assert.ok(tool, `missing tool ${name}`);
	return (tool as any).execute(`call-${name}`, params, undefined, undefined, session.extensionRunner.createContext());
}

async function wait(session: AgentSession, id: string, iterations = 100) {
	for (let i = 0; i < iterations; i++) {
		const s = await exec(session, "bg_status", { taskId: id });
		const t = s.details.tasks[0];
		if (t.status !== "running") return t;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error("timeout");
}

function customNotifications(session: AgentSession) {
	return session.sessionManager.getEntries().filter((e: any) => e.type === "custom_message" && e.customType === "background-task-notification") as any[];
}

async function readJsonEventually(path: string) {
	let last = "";
	for (let i = 0; i < 20; i++) {
		last = await readFile(path, "utf8").catch(() => "");
		if (last.trim()) return JSON.parse(last);
		await new Promise((r) => setTimeout(r, 25));
	}
	return JSON.parse(last);
}

afterEach(async () => {
	for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true });
});

describe("sdk", () => {
	it("registers commands, tools, shortcuts, renderers, and runs with output and metadata files", async () => {
		const { session, cwd } = await harness();
		try {
			for (const tool of ["bg_run", "bg_status", "bg_logs", "bg_kill"]) assert.ok(session.getActiveToolNames().includes(tool), tool);
			const cmds = session.extensionRunner.getRegisteredCommands().map((c) => c.invocationName);
			for (const cmd of ["bg", "jobs", "logs", "kill", "tasks", "bg-tasks"]) assert.ok(cmds.includes(cmd), cmd);
			assert.ok(session.extensionRunner.getMessageRenderer("background-task-notification"));
			const shortcuts = session.extensionRunner.getShortcuts(new Map() as any);
			assert.ok(shortcuts.has("shift+down" as any));
			assert.ok(shortcuts.has("shift+c" as any));

			const r = await exec(session, "bg_run", { name: "SDK Echo", command: "printf sdk-ok", notifyOnCompletion: false, triggerOnCompletion: false });
			const t = await wait(session, r.details.task.id);
			assert.equal(t.status, "completed");
			assert.equal(t.name, "SDK Echo");
			assert.ok(existsSync(join(cwd, t.outputPath)));
			const metadataPath = join(cwd, t.outputPath.replace(/\.output$/, ".json"));
			assert.ok(existsSync(metadataPath));
			const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
			assert.equal(metadata.status, "completed");
			assert.equal(metadata.name, "SDK Echo");
			const logs = await exec(session, "bg_logs", { taskId: t.id, maxBytes: 100 });
			assert.match(logs.content[0].text, /sdk-ok/);
			await assert.rejects(() => exec(session, "bg_kill", { taskId: t.id }), /not running/);
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	});

	it("supports status/log prefix resolution, all-task listing, head/tail truncation, and ambiguous/unknown ID errors", async () => {
		const { session } = await harness();
		try {
			const first = await exec(session, "bg_run", { name: "SDK First", command: "printf abcdef", notifyOnCompletion: false, triggerOnCompletion: false });
			const second = await exec(session, "bg_run", { name: "SDK Second", command: "printf 123456", notifyOnCompletion: false, triggerOnCompletion: false });
			const firstDone = await wait(session, first.details.task.id);
			await wait(session, second.details.task.id);
			const all = await exec(session, "bg_status", {});
			assert.ok(all.details.tasks.length >= 2);
			const byPrefix = await exec(session, "bg_status", { taskId: firstDone.id.slice(0, 5) });
			assert.equal(byPrefix.details.tasks[0].id, firstDone.id);
			await assert.rejects(() => exec(session, "bg_status", { taskId: "b" }), /Ambiguous task ID prefix/);
			await assert.rejects(() => exec(session, "bg_status", { taskId: "bdeadbeef" }), /Unknown background task ID/);
			const head = await exec(session, "bg_logs", { taskId: firstDone.id, maxBytes: 3, tail: false });
			assert.match(head.content[0].text, /^abc/);
			assert.match(head.content[0].text, /Showing head/);
			const tail = await exec(session, "bg_logs", { taskId: firstDone.id, maxBytes: 3, tail: true });
			assert.match(tail.content[0].text, /def/);
			assert.match(tail.content[0].text, /Showing tail/);
			await assert.rejects(() => exec(session, "bg_logs", { taskId: "bdeadbeef" }), /Unknown background task ID/);
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	});

	it("kills running tasks and rejects unknown or completed kills loudly", async () => {
		const { session } = await harness();
		try {
			const r = await exec(session, "bg_run", { name: "SDK Sleep", command: "sleep 10", notifyOnCompletion: false, triggerOnCompletion: false });
			const k = await exec(session, "bg_kill", { taskId: r.details.task.id.slice(0, 6) });
			assert.match(k.content[0].text, /Killed/);
			const t = await wait(session, r.details.task.id);
			assert.equal(t.status, "killed");
			await assert.rejects(() => exec(session, "bg_kill", { taskId: t.id }), /not running/);
			await assert.rejects(() => exec(session, "bg_kill", { taskId: "bdeadbeef" }), /Unknown background task ID/);
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	});

	it("fails timed-out tasks loudly", async () => {
		const { session } = await harness();
		try {
			const r = await exec(session, "bg_run", { name: "SDK Timeout", command: "sleep 5", timeoutSeconds: 1, notifyOnCompletion: false, triggerOnCompletion: false });
			const t = await wait(session, r.details.task.id, 80);
			assert.equal(t.status, "failed");
			assert.match(t.error, /Timed out after 1s/);
			const logs = await exec(session, "bg_logs", { taskId: t.id, maxBytes: 1000 });
			assert.match(logs.content[0].text, /background task timeout/);
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	});

	it("records completion notifications exactly once when enabled and suppresses them when disabled", async () => {
		const { session } = await harness();
		try {
			const notified = await exec(session, "bg_run", { name: "Notify SDK", command: "printf '<ok>&done'", notifyOnCompletion: true, triggerOnCompletion: false });
			const hidden = await exec(session, "bg_run", { name: "No Notify SDK", command: "printf quiet", notifyOnCompletion: false, triggerOnCompletion: false });
			await wait(session, notified.details.task.id);
			await wait(session, hidden.details.task.id);
			await new Promise((r) => setTimeout(r, 20));
			const notes = customNotifications(session);
			assert.equal(notes.length, 1);
			assert.match(notes[0].content, /<task-name>Notify SDK<\/task-name>/);
			assert.match(notes[0].content, /<status>completed<\/status>/);
			assert.match(notes[0].content, /&quot;|Notify SDK/);
			assert.equal(notes[0].details.notified, true);
			const status = await exec(session, "bg_status", { taskId: hidden.details.task.id });
			assert.equal(status.details.tasks[0].notified, false);
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	});

	it("captures only task-owned context telemetry in snapshots and metadata", async () => {
		const { session, cwd } = await harness();
		try {
			const tool = session.getToolDefinition("bg_run") as any;
			const ctx = session.extensionRunner.createContext() as any;
			ctx.getContextUsage = () => ({ tokens: 999_000, contextWindow: 1_000_000, percent: 99.9 });
			const command = `node -e 'console.log(JSON.stringify({type:"background-task-context-usage",tokens:50000,contextWindow:200000,percent:25})); console.log("context")'`;
			const r = await tool.execute("call-context", { name: "Context SDK", command, notifyOnCompletion: false, triggerOnCompletion: false }, undefined, undefined, ctx);
			const t = await wait(session, r.details.task.id);
			assert.deepEqual(t.contextUsage, { tokens: 50_000, contextWindow: 200_000, percent: 25 });
			const metadataPath = join(cwd, t.outputPath.replace(/\.output$/, ".json"));
			const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
			assert.deepEqual(metadata.contextUsage, { tokens: 50_000, contextWindow: 200_000, percent: 25 });

			const noTelemetry = await exec(session, "bg_run", { name: "No Context SDK", command: "printf no-context", notifyOnCompletion: false, triggerOnCompletion: false });
			const noTelemetryTask = await wait(session, noTelemetry.details.task.id);
			assert.equal(noTelemetryTask.contextUsage, undefined);
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	});

	it("keeps finished footer notices until explicit Shift+C clear", async () => {
		const { session } = await harness();
		const statuses: Array<string | undefined> = [];
		const notifications: Array<{ message: string; type?: string }> = [];
		const ui = {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			notify: (message: string, type?: "info" | "warning" | "error") => { notifications.push({ message, type }); },
			onTerminalInput: () => () => {},
			setStatus: (_key: string, text: string | undefined) => { statuses.push(text); },
			setWorkingMessage: () => {},
			setWorkingVisible: () => {},
			setWorkingIndicator: () => {},
			setHiddenThinkingLabel: () => {},
			setWidget: () => {},
			setFooter: () => {},
			setHeader: () => {},
			setTitle: () => {},
			custom: async () => undefined,
			pasteToEditor: () => {},
			setEditorText: () => {},
			getEditorText: () => "",
			editor: async () => undefined,
			addAutocompleteProvider: () => {},
			setEditor: () => {},
		};
		session.extensionRunner.setUIContext(ui as any);
		try {
			const done = await exec(session, "bg_run", { name: "Footer Done", command: "printf done", notifyOnCompletion: false, triggerOnCompletion: false });
			await wait(session, done.details.task.id);
			await new Promise((r) => setTimeout(r, 20));
			assert.match(statuses.at(-1) ?? "", /bg 1 done · Shift↓ · C clear/);

			const shortcuts = session.extensionRunner.getShortcuts(new Map() as any);
			await shortcuts.get("shift+c" as any)!.handler(session.extensionRunner.createContext());
			assert.equal(statuses.at(-1), undefined);
			assert.match(notifications.at(-1)?.message ?? "", /Cleared 1 finished/);

			const running = await exec(session, "bg_run", { name: "Footer Running", command: "sleep 10", notifyOnCompletion: false, triggerOnCompletion: false });
			const secondDone = await exec(session, "bg_run", { name: "Footer Done Two", command: "printf two", notifyOnCompletion: false, triggerOnCompletion: false });
			await wait(session, secondDone.details.task.id);
			await new Promise((r) => setTimeout(r, 20));
			assert.match(statuses.at(-1) ?? "", /1 running · 1 done · Shift↓ · C clear/);
			await shortcuts.get("shift+c" as any)!.handler(session.extensionRunner.createContext());
			assert.match(statuses.at(-1) ?? "", /bg 1 running · Shift↓/);
			assert.doesNotMatch(statuses.at(-1) ?? "", /done|C clear/);
			await exec(session, "bg_kill", { taskId: running.details.task.id });
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	});

	it("uses bg_run prepareArguments for legacy calls without names", async () => {
		const { session } = await harness();
		try {
			const tool = session.getToolDefinition("bg_run") as any;
			const prepared = tool.prepareArguments({ command: "npm run qa", description: "Legacy QA" });
			assert.equal(prepared.name, "Legacy QA");
			const fallback = tool.prepareArguments({ command: "pnpm test" });
			assert.equal(fallback.name, "pnpm test");
			const invalid = tool.prepareArguments(null);
			assert.deepEqual(invalid, { name: "Background task", command: "" });
			await assert.rejects(() => exec(session, "bg_run", invalid), /Background command is empty/);
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	});

	it("fails spawn errors loudly and writes failure metadata", async () => {
		const previousShell = process.env.SHELL;
		process.env.SHELL = "/definitely/missing/pi-bg-shell";
		const { session, cwd } = await harness();
		try {
			const r = await exec(session, "bg_run", { name: "Bad Shell", command: "printf nope", notifyOnCompletion: false, triggerOnCompletion: false });
			const t = await wait(session, r.details.task.id);
			assert.equal(t.status, "failed");
			assert.match(t.error, /ENOENT|no such file/i);
			const metadataPath = join(cwd, t.outputPath.replace(/\.output$/, ".json"));
			const metadata = await readJsonEventually(metadataPath);
			assert.equal(metadata.status, "failed");
		} finally {
			if (previousShell === undefined) delete process.env.SHELL;
			else process.env.SHELL = previousShell;
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	});

	it("cleans up multiple running tasks on shutdown", async () => {
		const { session } = await harness();
		const one = await exec(session, "bg_run", { name: "SDK Shutdown One", command: "sleep 10", notifyOnCompletion: false, triggerOnCompletion: false });
		const two = await exec(session, "bg_run", { name: "SDK Shutdown Two", command: "sleep 10", notifyOnCompletion: false, triggerOnCompletion: false });
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		const s1 = await exec(session, "bg_status", { taskId: one.details.task.id });
		const s2 = await exec(session, "bg_status", { taskId: two.details.task.id });
		assert.equal(s1.details.tasks[0].status, "killed");
		assert.equal(s2.details.tasks[0].status, "killed");
		assert.match(s1.details.tasks[0].error, /shutdown/);
		session.dispose();
	});
});

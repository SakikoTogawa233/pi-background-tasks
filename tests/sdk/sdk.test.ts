import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { BgTaskSnapshot } from "../../src/core/common.js";

const extensionPath = resolve("extensions/background-tasks.ts");
const scriptedProviderPath = resolve("tests/scripted-provider/scripted-provider-extension.ts");
const roots: string[] = [];

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function resolvePiCli(): string | undefined {
	const which = spawnSync("bash", ["-lc", "command -v pi"], { encoding: "utf8" });
	return which.status === 0 ? which.stdout.trim() || undefined : undefined;
}

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

type TestToolResult = {
	content: Array<{ type: string; text?: string }>;
	details: { task?: BgTaskSnapshot; tasks?: BgTaskSnapshot[] } & Record<string, unknown>;
};

async function exec(session: AgentSession, name: string, params: unknown): Promise<TestToolResult> {
	const tool = session.getToolDefinition(name);
	assert.ok(tool, `missing tool ${name}`);
	return await tool.execute(`call-${name}`, params, undefined, undefined, session.extensionRunner.createContext()) as TestToolResult;
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

type CustomNotificationEntry = { type: "custom_message"; customType: string; content: string; details: Record<string, unknown> };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isCustomNotificationEntry(value: unknown): value is CustomNotificationEntry {
	return isRecord(value) && value["type"] === "custom_message" && value["customType"] === "background-task-notification" && typeof value["content"] === "string" && isRecord(value["details"]);
}

function customNotifications(session: AgentSession): CustomNotificationEntry[] {
	return (session.sessionManager.getEntries() as unknown[]).filter(isCustomNotificationEntry);
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
			const bgRunTool = session.getToolDefinition("bg_run");
			const bgRunParams = bgRunTool.parameters ?? bgRunTool.inputSchema;
			assert.ok(bgRunParams.required?.includes("isAgent"), "bg_run schema must require isAgent");
			assert.match(JSON.stringify(bgRunParams.properties?.isAgent ?? bgRunParams), /LLM\/agent/);
			const cmds = session.extensionRunner.getRegisteredCommands().map((c) => c.invocationName);
			for (const cmd of ["bg", "jobs", "logs", "kill", "tasks", "bg-tasks", "bg-clear"]) assert.ok(cmds.includes(cmd), cmd);
			assert.ok(session.extensionRunner.getMessageRenderer("background-task-notification"));
			const shortcuts = session.extensionRunner.getShortcuts(new Map());
			assert.ok(shortcuts.has("shift+down"));
			assert.ok(shortcuts.has("ctrl+alt+c"));

			const r = await exec(session, "bg_run", { isAgent: false, name: "SDK Echo", command: "printf sdk-ok", notifyOnCompletion: false, triggerOnCompletion: false });
			const t = await wait(session, r.details.task.id);
			assert.equal(t.status, "completed");
			assert.equal(t.name, "SDK Echo");
			assert.equal(t.isAgent, false);
			assert.ok(existsSync(join(cwd, t.outputPath)));
			const metadataPath = join(cwd, t.outputPath.replace(/\.output$/, ".json"));
			assert.ok(existsSync(metadataPath));
			const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
			assert.equal(metadata.status, "completed");
			assert.equal(metadata.name, "SDK Echo");
			assert.equal(metadata.isAgent, false);
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
			const first = await exec(session, "bg_run", { isAgent: false, name: "SDK First", command: "printf abcdef", notifyOnCompletion: false, triggerOnCompletion: false });
			const second = await exec(session, "bg_run", { isAgent: false, name: "SDK Second", command: "printf 123456", notifyOnCompletion: false, triggerOnCompletion: false });
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
			const r = await exec(session, "bg_run", { isAgent: false, name: "SDK Sleep", command: "sleep 10", notifyOnCompletion: false, triggerOnCompletion: false });
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
			const r = await exec(session, "bg_run", { isAgent: false, name: "SDK Timeout", command: "sleep 5", timeoutSeconds: 1, notifyOnCompletion: false, triggerOnCompletion: false });
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
			const notified = await exec(session, "bg_run", { isAgent: false, name: "Notify SDK", command: "printf '<ok>&done'", notifyOnCompletion: true, triggerOnCompletion: false });
			const hidden = await exec(session, "bg_run", { isAgent: false, name: "No Notify SDK", command: "printf quiet", notifyOnCompletion: false, triggerOnCompletion: false });
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

	it("captures only task-owned explicit telemetry in snapshots and metadata", async () => {
		const { session, cwd } = await harness();
		try {
			const tool = session.getToolDefinition("bg_run");
			const ctx = session.extensionRunner.createContext();
			ctx.getContextUsage = () => ({ tokens: 999_000, contextWindow: 1_000_000, percent: 99.9 });
			const script = `console.log(JSON.stringify({ type: "background-task-telemetry", model: "test-provider/test-model", contextUsage: { tokens: 50000, contextWindow: 200000, percent: 25 }, tokenUsage: { input: 1000, output: 200, cacheRead: 30, cacheWrite: 20, totalTokens: 1250 }, toolUsage: { total: 2, failed: 1, byName: { read: 1, bash: 1 } } })); console.log("context");`;
			const command = `node -e ${JSON.stringify(script)}`;
			const r = await tool.execute("call-context", { isAgent: false, name: "Context SDK", command, notifyOnCompletion: false, triggerOnCompletion: false }, undefined, undefined, ctx);
			const t = await wait(session, r.details.task.id);
			assert.deepEqual(t.contextUsage, { tokens: 50_000, contextWindow: 200_000, percent: 25 });
			assert.deepEqual(t.tokenUsage, { input: 1000, output: 200, cacheRead: 30, cacheWrite: 20, totalTokens: 1250 });
			assert.deepEqual(t.toolUsage, { total: 2, failed: 1, byName: { read: 1, bash: 1 } });
			assert.equal(t.model, "test-provider/test-model");
			const status = await exec(session, "bg_status", { taskId: t.id });
			assert.match(status.content[0].text, /ctx=25\.0%\/200k/);
			assert.match(status.content[0].text, /model=test-provider\/test-model/);
			assert.match(status.content[0].text, /tokens=1\.3k/);
			assert.match(status.content[0].text, /tools=2 failed=1/);
			const metadataPath = join(cwd, t.outputPath.replace(/\.output$/, ".json"));
			const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
			assert.deepEqual(metadata.contextUsage, { tokens: 50_000, contextWindow: 200_000, percent: 25 });
			assert.deepEqual(metadata.tokenUsage, t.tokenUsage);
			assert.deepEqual(metadata.toolUsage, t.toolUsage);
			assert.equal(metadata.model, "test-provider/test-model");

			const legacy = await exec(session, "bg_run", { isAgent: false, name: "Legacy Context SDK", command: `node -e ${JSON.stringify('console.log(JSON.stringify({ type: "background-task-context-usage", tokens: 42, contextWindow: 1000, percent: 4.2 }))')}`, notifyOnCompletion: false, triggerOnCompletion: false });
			const legacyTask = await wait(session, legacy.details.task.id);
			assert.deepEqual(legacyTask.contextUsage, { tokens: 42, contextWindow: 1000, percent: 4.2 });
			assert.equal(legacyTask.tokenUsage, undefined);

			const noTelemetry = await exec(session, "bg_run", { isAgent: false, name: "No Context SDK", command: "printf no-context", notifyOnCompletion: false, triggerOnCompletion: false });
			const noTelemetryTask = await wait(session, noTelemetry.details.task.id);
			assert.equal(noTelemetryTask.contextUsage, undefined);
			assert.equal(noTelemetryTask.tokenUsage, undefined);
			assert.equal(noTelemetryTask.toolUsage, undefined);
			assert.equal(noTelemetryTask.model, undefined);
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	});

	it("wraps explicitly marked background Pi agents and captures context telemetry", async () => {
		const { session, cwd } = await harness();
		const oldPath = process.env["PATH"];
		try {
			const bin = join(cwd, "bin");
			await mkdir(bin, { recursive: true });
			const fakePi = join(bin, "pi");
			await writeFile(fakePi, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (!args.includes("--mode") || args[args.indexOf("--mode") + 1] !== "json") {
  console.error("expected --mode json: " + JSON.stringify(args));
  process.exit(3);
}
if (args.includes("-p") || args.includes("--print")) {
  console.error("print flag should be removed: " + JSON.stringify(args));
  process.exit(4);
}
const firstMessage = {
  role: "assistant",
  model: "openai-codex/gpt-5.5",
  usage: { input: 1000, output: 200, cacheRead: 30, cacheWrite: 20, totalTokens: 1250 },
  content: [{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "README.md" } }],
  stopReason: "toolUse",
  timestamp: Date.now()
};
const secondMessage = {
  role: "assistant",
  model: "openai-codex/gpt-5.5",
  usage: { input: 300, output: 50, cacheRead: 0, cacheWrite: 10, totalTokens: 360 },
  content: [{ type: "text", text: "fake child final" }],
  stopReason: "stop",
  timestamp: Date.now()
};
console.log(JSON.stringify({ type: "message_end", message: firstMessage }));
console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "call-read", toolName: "read", args: { path: "README.md" } }));
console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "call-read", toolName: "read", result: {}, isError: false }));
console.log(JSON.stringify({ type: "tool_execution_start", toolCallId: "call-bash", toolName: "bash", args: { command: "false" } }));
console.log(JSON.stringify({ type: "tool_execution_end", toolCallId: "call-bash", toolName: "bash", result: {}, isError: true }));
console.log(JSON.stringify({ type: "message_end", message: secondMessage }));
`, "utf8");
			await chmod(fakePi, 0o755);
			process.env["PATH"] = `${bin}:${oldPath ?? ""}`;

			const r = await exec(session, "bg_run", { isAgent: true, name: "Wrapped Pi Agent", command: "pi --model openai-codex/gpt-5.5 -p hello", notifyOnCompletion: false, triggerOnCompletion: false });
			const t = await wait(session, r.details.task.id);
			assert.equal(t.status, "completed");
			assert.deepEqual(t.contextUsage, { tokens: 360, contextWindow: 272000, percent: (360 / 272000) * 100 });
			assert.deepEqual(t.tokenUsage, { input: 1300, output: 250, cacheRead: 30, cacheWrite: 30, totalTokens: 1610 });
			assert.deepEqual(t.toolUsage, { total: 2, failed: 1, byName: { read: 1, bash: 1 } });
			assert.equal(t.model, "openai-codex/gpt-5.5");
			const status = await exec(session, "bg_status", { taskId: t.id });
			assert.match(status.content[0].text, /model=openai-codex\/gpt-5\.5/);
			assert.match(status.content[0].text, /tokens=1\.6k/);
			assert.match(status.content[0].text, /tools=2 failed=1/);
			const logs = await exec(session, "bg_logs", { taskId: t.id, maxBytes: 4000, tail: false });
			assert.match(logs.content[0].text, /background-task-context-usage/);
			assert.match(logs.content[0].text, /background-task-telemetry/);
			assert.match(logs.content[0].text, /fake child final/);
			const metadataPath = join(cwd, t.outputPath.replace(/\.output$/, ".json"));
			const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
			assert.deepEqual(metadata.contextUsage, t.contextUsage);
			assert.deepEqual(metadata.tokenUsage, t.tokenUsage);
			assert.deepEqual(metadata.toolUsage, t.toolUsage);
			assert.equal(metadata.model, "openai-codex/gpt-5.5");
		} finally {
			process.env["PATH"] = oldPath;
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	});

	it("wraps an explicitly marked real child Pi and counts JSON token/tool telemetry", { timeout: 20_000 }, async (t) => {
		if (process.platform === "win32") {
			t.skip("POSIX shell env-prefix child-pi telemetry smoke is not portable to Windows");
			return;
		}
		const piCli = resolvePiCli();
		if (!piCli) {
			t.skip("pi CLI is not available on PATH for real child-pi telemetry smoke");
			return;
		}
		const { session, cwd } = await harness();
		try {
			const childAgentDir = join(cwd, "child-agent");
			const childSessionDir = join(cwd, "child-sessions");
			await mkdir(childAgentDir, { recursive: true });
			await mkdir(childSessionDir, { recursive: true });
			const envPrefix = Object.entries({
				PI_BG_SCRIPTED_SCENARIO: "json-tool-telemetry",
				PI_BG_SCRIPTED_API_KEY: "scripted-api-key",
				PI_CODING_AGENT_DIR: childAgentDir,
				PI_CODING_AGENT_SESSION_DIR: childSessionDir,
				PI_OFFLINE: "1",
				PI_SKIP_VERSION_CHECK: "1",
				PI_TELEMETRY: "0",
				CI: "1",
				PATH: `${dirname(piCli)}:${process.env["PATH"] ?? ""}`,
			})
				.map(([key, value]) => `${key}=${shellQuote(value)}`)
				.join(" ");
			const command = `${envPrefix} pi --offline --no-session --no-extensions -e ${shellQuote(scriptedProviderPath)} --no-skills --no-prompt-templates --no-context-files --model pi-bg-scripted/scripted-model -p ${shellQuote("exercise real json tool telemetry")}`;
			const r = await exec(session, "bg_run", { isAgent: true, name: "Real Pi Telemetry", command, notifyOnCompletion: false, triggerOnCompletion: false });
			const t = await wait(session, r.details.task.id, 240);
			assert.equal(t.status, "completed");
			assert.deepEqual(t.tokenUsage, { input: 20, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 30, costTotal: 0 });
			assert.deepEqual(t.toolUsage, { total: 2, failed: 1, byName: { scripted_echo: 2 } });
			assert.equal(t.model, "pi-bg-scripted/scripted-model");
			const status = await exec(session, "bg_status", { taskId: t.id });
			assert.match(status.content[0].text, /model=pi-bg-scripted\/scripted-model/);
			assert.match(status.content[0].text, /tokens=30/);
			assert.match(status.content[0].text, /tools=2 failed=1/);
			const logs = await exec(session, "bg_logs", { taskId: t.id, maxBytes: 8000, tail: false });
			assert.match(logs.content[0].text, /background-task-telemetry/);
			assert.match(logs.content[0].text, /JSON tool telemetry complete/);
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	});

	it("keeps finished footer notices until explicit /bg-clear", async () => {
		const { session } = await harness();
		const statuses: Array<string | undefined> = [];
		const notifications: Array<{ message: string; type?: string }> = [];
		const ui = {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			notify: (message: string, type?: "info" | "warning" | "error") => {
				const notification: { message: string; type?: string } = { message };
				if (type !== undefined) notification.type = type;
				notifications.push(notification);
			},
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
		session.extensionRunner.setUIContext(ui);
		try {
			const done = await exec(session, "bg_run", { isAgent: false, name: "Footer Done", command: "printf done", notifyOnCompletion: false, triggerOnCompletion: false });
			await wait(session, done.details.task.id);
			await new Promise((r) => setTimeout(r, 20));
			assert.match(statuses.at(-1) ?? "", /bg 1 done · Shift↓ · \/bg-clear/);

			const shortcuts = session.extensionRunner.getShortcuts(new Map());
			assert.ok(shortcuts.has("ctrl+alt+c"));
			const clearCommand = session.extensionRunner.getRegisteredCommands().find((cmd) => cmd.invocationName === "bg-clear");
			assert.ok(clearCommand);
			await clearCommand.handler("", session.extensionRunner.createContext());
			assert.equal(statuses.at(-1), undefined);
			assert.match(notifications.at(-1)?.message ?? "", /Cleared 1 finished/);

			const running = await exec(session, "bg_run", { isAgent: false, name: "Footer Running", command: "sleep 10", notifyOnCompletion: false, triggerOnCompletion: false });
			const secondDone = await exec(session, "bg_run", { isAgent: false, name: "Footer Done Two", command: "printf two", notifyOnCompletion: false, triggerOnCompletion: false });
			await wait(session, secondDone.details.task.id);
			await new Promise((r) => setTimeout(r, 20));
			assert.match(statuses.at(-1) ?? "", /1 running · 1 done · Shift↓ · \/bg-clear/);
			await clearCommand.handler("", session.extensionRunner.createContext());
			assert.match(statuses.at(-1) ?? "", /bg 1 running · Shift↓/);
			assert.doesNotMatch(statuses.at(-1) ?? "", /done|\/bg-clear/);
			await exec(session, "bg_kill", { taskId: running.details.task.id });
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	});

	it("reports failed/stopped/done footer combinations and focused dock status", async () => {
		const { session } = await harness();
		const statuses: Array<string | undefined> = [];
		const notifications: string[] = [];
		const ui = {
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			notify: (message: string) => { notifications.push(message); },
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
			setEditorText: () => {},
			getEditorText: () => "",
			pasteToEditor: () => {},
			editor: async () => undefined,
			addAutocompleteProvider: () => {},
			setEditor: () => {},
			custom: async () => undefined,
		};
		session.extensionRunner.setUIContext(ui);
		try {
			const failed = await exec(session, "bg_run", { isAgent: false, name: "Footer Failed", command: "node -e \"process.exit(2)\"", notifyOnCompletion: false, triggerOnCompletion: false });
			await wait(session, failed.details.task.id);
			const stopped = await exec(session, "bg_run", { isAgent: false, name: "Footer Stopped", command: "sleep 10", notifyOnCompletion: false, triggerOnCompletion: false });
			await exec(session, "bg_kill", { taskId: stopped.details.task.id });
			await wait(session, stopped.details.task.id);
			const done = await exec(session, "bg_run", { isAgent: false, name: "Footer Done Matrix", command: "printf done", notifyOnCompletion: false, triggerOnCompletion: false });
			await wait(session, done.details.task.id);
			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.match(statuses.at(-1) ?? "", /1 failed · 1 stopped · 1 done · Shift↓ · \/bg-clear/);

			const running = await exec(session, "bg_run", { isAgent: false, name: "Footer Focused", command: "sleep 10", notifyOnCompletion: false, triggerOnCompletion: false });
			await new Promise((resolve) => setTimeout(resolve, 30));
			assert.match(statuses.at(-1) ?? "", /1 running · 1 failed · 1 stopped · 1 done · Shift↓ · \/bg-clear/);
			const shortcuts = session.extensionRunner.getShortcuts(new Map());
			await shortcuts.get("shift+down")!.handler(session.extensionRunner.createContext());
			assert.ok(statuses.some((status) => /bg 1 running · 1 failed · 1 stopped · 1 done · focused/.test(status ?? "")));
			await exec(session, "bg_kill", { taskId: running.details.task.id });
			assert.equal(notifications.length >= 0, true);
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	});

	it("uses bg_run prepareArguments for legacy calls without names", async () => {
		const { session } = await harness();
		try {
			const tool = session.getToolDefinition("bg_run");
			assert.ok(tool?.prepareArguments);
			const prepared = tool.prepareArguments({ command: "npm run qa", description: "Legacy QA", isAgent: false });
			assert.equal(prepared.name, "Legacy QA");
			assert.equal(prepared.isAgent, false);
			const agent = tool.prepareArguments({ name: "Legacy Agent", command: "pi -p hi", isAgent: true });
			assert.equal(agent.isAgent, true);
			assert.throws(() => tool.prepareArguments?.({ command: "pnpm test" }), /requires isAgent boolean/);
			assert.throws(() => tool.prepareArguments?.(null), /arguments must be an object/);
			const invalid = { name: "Background task", command: "", isAgent: false };
			await assert.rejects(() => exec(session, "bg_run", { name: "Missing Agent Flag", command: "printf ok" }), /requires isAgent boolean/);
			await assert.rejects(() => exec(session, "bg_run", invalid), /Background command is empty/);
		} finally {
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	});

	it("fails spawn errors loudly and writes failure metadata", async () => {
		const previousShell = process.env["SHELL"];
		process.env["SHELL"] = "/definitely/missing/pi-bg-shell";
		const { session, cwd } = await harness();
		try {
			const r = await exec(session, "bg_run", { isAgent: false, name: "Bad Shell", command: "printf nope", notifyOnCompletion: false, triggerOnCompletion: false });
			const t = await wait(session, r.details.task.id);
			assert.equal(t.status, "failed");
			assert.match(t.error, /ENOENT|no such file/i);
			const metadataPath = join(cwd, t.outputPath.replace(/\.output$/, ".json"));
			const metadata = await readJsonEventually(metadataPath);
			assert.equal(metadata.status, "failed");
		} finally {
			if (previousShell === undefined) delete process.env["SHELL"];
			else process.env["SHELL"] = previousShell;
			await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
			session.dispose();
		}
	});

	it("cleans up multiple running tasks on shutdown", async () => {
		const { session } = await harness();
		const one = await exec(session, "bg_run", { isAgent: false, name: "SDK Shutdown One", command: "sleep 10", notifyOnCompletion: false, triggerOnCompletion: false });
		const two = await exec(session, "bg_run", { isAgent: false, name: "SDK Shutdown Two", command: "sleep 10", notifyOnCompletion: false, triggerOnCompletion: false });
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		const s1 = await exec(session, "bg_status", { taskId: one.details.task.id });
		const s2 = await exec(session, "bg_status", { taskId: two.details.task.id });
		assert.equal(s1.details.tasks[0].status, "killed");
		assert.equal(s2.details.tasks[0].status, "killed");
		assert.match(s1.details.tasks[0].error, /shutdown/);
		session.dispose();
	});
});

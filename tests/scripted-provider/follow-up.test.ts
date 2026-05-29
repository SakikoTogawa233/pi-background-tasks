import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { AuthStorage, createAgentSession, DefaultResourceLoader, ModelRegistry, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { isolatedTestEnv } from "../../src/testing/normalize.js";

const backgroundExtensionPath = resolve("extensions/background-tasks.ts");
const scriptedProviderPath = resolve("tests/scripted-provider/scripted-provider-extension.ts");
const roots: string[] = [];

type Scenario = "bg-run-follow-up" | "notify-false" | "failed-follow-up" | "display-only-bg";

async function harness(scenario: Scenario) {
	const root = await mkdtemp(join(tmpdir(), "pi-bg-agent-loop-"));
	roots.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const eventsPath = join(root, "provider-events.jsonl");
	await mkdir(cwd, { recursive: true });
	await mkdir(agentDir, { recursive: true });
	const previousScenario = process.env["PI_BG_SCRIPTED_SCENARIO"];
	const previousEvents = process.env["PI_BG_SCRIPTED_EVENTS"];
	const previousApiKey = process.env["PI_BG_SCRIPTED_API_KEY"];
	Object.assign(process.env, isolatedTestEnv, {
		PI_BG_SCRIPTED_SCENARIO: scenario,
		PI_BG_SCRIPTED_EVENTS: eventsPath,
		PI_BG_SCRIPTED_API_KEY: "scripted-api-key",
		NPM_CONFIG_CACHE: "/tmp/pi-npm-cache",
	});
	const settingsManager = SettingsManager.inMemory({ defaultProvider: "pi-bg-scripted", defaultModel: "scripted-model" });
	const loader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		additionalExtensionPaths: [scriptedProviderPath, backgroundExtensionPath],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noContextFiles: true,
		noThemes: true,
	});
	await loader.reload();
	const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	const { session } = await createAgentSession({
		cwd,
		agentDir,
		resourceLoader: loader,
		sessionManager: SessionManager.inMemory(cwd),
		settingsManager,
		authStorage,
		modelRegistry,
		noTools: "builtin",
	});
	const scriptedModel = modelRegistry.find("pi-bg-scripted", "scripted-model");
	assert.ok(scriptedModel, "scripted provider model should be registered");
	await session.setModel(scriptedModel);
	const restoreEnv = () => {
		if (previousScenario === undefined) delete process.env["PI_BG_SCRIPTED_SCENARIO"];
		else process.env["PI_BG_SCRIPTED_SCENARIO"] = previousScenario;
		if (previousEvents === undefined) delete process.env["PI_BG_SCRIPTED_EVENTS"];
		else process.env["PI_BG_SCRIPTED_EVENTS"] = previousEvents;
		if (previousApiKey === undefined) delete process.env["PI_BG_SCRIPTED_API_KEY"];
		else process.env["PI_BG_SCRIPTED_API_KEY"] = previousApiKey;
	};
	return { session, cwd, root, eventsPath, restoreEnv };
}

afterEach(async () => {
	for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

type CustomNotificationEntry = { type: "custom_message"; customType: string; content: string; details: Record<string, unknown> };
type ProviderEvent = { callCount?: number; summaries?: string[] } & Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isCustomNotificationEntry(value: unknown): value is CustomNotificationEntry {
	return isRecord(value) && value["type"] === "custom_message" && value["customType"] === "background-task-notification" && typeof value["content"] === "string" && isRecord(value["details"]);
}

function customNotifications(session: AgentSession): CustomNotificationEntry[] {
	return (session.sessionManager.getEntries() as unknown[]).filter(isCustomNotificationEntry);
}

function assistantTexts(session: AgentSession): string[] {
	return session.sessionManager.getEntries()
		.flatMap((entry) => {
			if (!isRecord(entry) || entry["type"] !== "message" || !isRecord(entry["message"]) || entry["message"]["role"] !== "assistant") return [];
			const content = entry["message"]["content"];
			return Array.isArray(content) ? content : [];
		})
		.flatMap((part) => isRecord(part) && part["type"] === "text" && typeof part["text"] === "string" ? [part["text"]] : []);
}

async function providerEvents(path: string): Promise<ProviderEvent[]> {
	if (!existsSync(path)) return [];
	const raw = await readFile(path, "utf8");
	return raw.trim()
		? raw.trim().split("\n").map((line) => JSON.parse(line) as ProviderEvent)
		: [];
}

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	throw new Error(`Timed out waiting for ${message}`);
}

async function disposeHarness(h: Awaited<ReturnType<typeof harness>>) {
	try {
		await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
	} finally {
		h.session.dispose();
		h.restoreEnv();
	}
}

describe("scripted-provider completion follow-up behavior", { concurrency: false }, () => {
	it("bg_run completion notifications trigger a real follow-up agent turn by default", { timeout: 15_000 }, async () => {
		const h = await harness("bg-run-follow-up");
		try {
			await h.session.prompt("Start the scripted background task.");
			await waitFor(() => customNotifications(h.session).length === 1, "background notification");
			await waitFor(async () => (await providerEvents(h.eventsPath)).length >= 3, "third provider call from follow-up");
			await h.session.agent.waitForIdle();

			const events = await providerEvents(h.eventsPath);
			assert.equal(events.length, 3);
			assert.equal(events[2]!.callCount, 3);
			assert.match((events[2]!.summaries ?? []).join("\n"), /background-task-notification|Scripted Wakeup/);
			assert.ok(assistantTexts(h.session).some((text) => /Follow-up turn observed background-task-notification/.test(text)));

			const note = customNotifications(h.session)[0]!;
			assert.match(note.content, /<task-name>Scripted Wakeup<\/task-name>/);
			assert.match(note.content, /<status>completed<\/status>/);
			assert.equal(note.details.triggerOnCompletion, true);
			assert.equal(note.details.notified, true);
		} finally {
			await disposeHarness(h);
		}
	});

	it("notifyOnCompletion:false suppresses notification and prevents completion wakeup", { timeout: 15_000 }, async () => {
		const h = await harness("notify-false");
		try {
			await h.session.prompt("Start the no-notify scripted background task.");
			await new Promise((resolve) => setTimeout(resolve, 500));
			await h.session.agent.waitForIdle();
			assert.equal(customNotifications(h.session).length, 0);
			const events = await providerEvents(h.eventsPath);
			assert.equal(events.length, 2);
			assert.ok(assistantTexts(h.session).some((text) => /No-notify initial turn finished/.test(text)));
		} finally {
			await disposeHarness(h);
		}
	});

	it("failed background tasks include error fields and still wake a follow-up turn", { timeout: 15_000 }, async () => {
		const h = await harness("failed-follow-up");
		try {
			await h.session.prompt("Start the failing scripted background task.");
			await waitFor(() => customNotifications(h.session).length === 1, "failed background notification");
			await waitFor(async () => (await providerEvents(h.eventsPath)).length >= 3, "failed-task follow-up provider call");
			await h.session.agent.waitForIdle();

			const note = customNotifications(h.session)[0]!;
			assert.match(note.content, /<task-name>Failing Scripted<\/task-name>/);
			assert.match(note.content, /<status>failed<\/status>/);
			assert.match(note.content, /<exit-code>7<\/exit-code>/);
			assert.match(note.content, /<error>Exited with code 7<\/error>/);
			assert.equal(note.details.status, "failed");
			assert.equal(note.details.exitCode, 7);
			assert.match(note.details.error, /Exited with code 7/);

			const events = await providerEvents(h.eventsPath);
			assert.equal(events.length, 3);
			assert.match((events[2]!.summaries ?? []).join("\n"), /background-task-notification|Failing Scripted/);
			assert.ok(assistantTexts(h.session).some((text) => /Follow-up turn observed failed background task notification/.test(text)));
		} finally {
			await disposeHarness(h);
		}
	});

	it("/bg remains display-only: it notifies but does not trigger a provider follow-up", { timeout: 15_000 }, async () => {
		const h = await harness("display-only-bg");
		try {
			await h.session.prompt('/bg --name "Display Only Scripted" node -e "setTimeout(() => { console.log(\'display done\'); }, 80);"');
			await waitFor(() => customNotifications(h.session).length === 1, "display-only notification");
			await new Promise((resolve) => setTimeout(resolve, 350));
			await h.session.agent.waitForIdle();
			const note = customNotifications(h.session)[0]!;
			assert.match(note.content, /<task-name>Display Only Scripted<\/task-name>/);
			assert.match(note.content, /<status>completed<\/status>/);
			assert.equal(note.details.triggerOnCompletion, false);
			assert.equal((await providerEvents(h.eventsPath)).length, 0);
		} finally {
			await disposeHarness(h);
		}
	});
});

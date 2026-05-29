import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isolatedTestEnv } from "../../src/testing/normalize.js";

const extensionPath = resolve("extensions/background-tasks.ts");

type RpcEvent = Record<string, unknown>;
type Pending = { resolve: (event: RpcEvent) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function requireString(value: unknown, label: string): string {
	if (typeof value !== "string") throw new TypeError(`${label} must be a string`);
	return value;
}

function eventMessage(event: RpcEvent): string {
	const message = event["message"];
	return typeof message === "string" ? message : "";
}

class RPC {
	events: RpcEvent[] = [];
	buf = "";
	seq = 0;
	pending = new Map<string, Pending>();
	stderr = "";
	proc: ChildProcessWithoutNullStreams;

	constructor(public cwd: string, env: Record<string, string> = {}) {
		this.proc = spawn("pi", ["--mode", "rpc", "--no-session", "--offline", "--no-extensions", "-e", extensionPath, "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-tools"], {
			cwd,
			env: { ...process.env, ...isolatedTestEnv, NPM_CONFIG_CACHE: "/tmp/pi-npm-cache", ...env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.proc.stdout.on("data", (chunk) => this.on(chunk.toString()));
		this.proc.stderr.on("data", (chunk) => { this.stderr += chunk.toString(); });
	}

	on(chunk: string): void {
		this.buf += chunk;
		let i: number;
		while ((i = this.buf.indexOf("\n")) >= 0) {
			const line = this.buf.slice(0, i);
			this.buf = this.buf.slice(i + 1);
			if (!line) continue;
			const parsed = JSON.parse(line) as unknown;
			assert.ok(isRecord(parsed), "RPC event must be an object");
			this.events.push(parsed);
			const eventId = parsed["id"];
			if (parsed["type"] === "response" && typeof eventId === "string" && this.pending.has(eventId)) {
				const pending = this.pending.get(eventId);
				assert.ok(pending);
				this.pending.delete(eventId);
				clearTimeout(pending.timer);
				pending.resolve(parsed);
			}
		}
	}

	send(cmd: Record<string, unknown>): Promise<RpcEvent> {
		const id = `r${++this.seq}`;
		return new Promise<RpcEvent>((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error(this.stderr || `RPC timeout for ${JSON.stringify(cmd)}`)), 10_000);
			this.pending.set(id, { resolve, reject, timer });
			this.proc.stdin.write(`${JSON.stringify({ ...cmd, id })}\n`);
		});
	}

	async wait(pred: (event: RpcEvent) => boolean, timeoutMs = 10_000): Promise<RpcEvent> {
		const start = Date.now();
		while (Date.now() - start < timeoutMs) {
			const found = this.events.find(pred);
			if (found) return found;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		throw new Error(`timeout ${this.stderr}\nEvents: ${JSON.stringify(this.events.slice(-10), null, 2)}`);
	}

	async prompt(message: string): Promise<RpcEvent> {
		return this.send({ type: "prompt", message });
	}

	async stop(): Promise<void> {
		this.proc.kill("SIGTERM");
	}
}

async function withRpc(fn: (rpc: RPC, cwd: string) => Promise<void>, env: Record<string, string> = {}): Promise<void> {
	const root = await mkdtemp(join(tmpdir(), "pi-bg-rpc-"));
	const cwd = join(root, "project");
	await mkdir(cwd, { recursive: true });
	const rpc = new RPC(cwd, env);
	try {
		await fn(rpc, cwd);
	} finally {
		await rpc.stop();
		await rm(root, { recursive: true, force: true });
	}
}

function notifyWith(re: RegExp): (event: RpcEvent) => boolean {
	return (event) => event["type"] === "extension_ui_request" && re.test(eventMessage(event));
}

function extractTaskId(event: RpcEvent): string {
	const match = eventMessage(event).match(/\((b[0-9a-f]+)\)/);
	assert.ok(match?.[1], `Could not extract task id from ${eventMessage(event)}`);
	return match[1];
}

function commandNames(event: RpcEvent): string[] {
	const data = event["data"];
	assert.ok(isRecord(data));
	const commands = data["commands"];
	assert.ok(Array.isArray(commands));
	return commands.map((command) => {
		assert.ok(isRecord(command));
		const name = command["name"];
		return requireString(name, "command name");
	});
}

describe("rpc", () => {
	it("discovers commands and covers /bg + /logs slash flow", async () => {
		await withRpc(async (rpc) => {
			const c = await rpc.send({ type: "get_commands" });
			assert.equal(c["success"], true);
			const names = commandNames(c);
			for (const name of ["bg", "jobs", "logs", "kill", "tasks", "bg-tasks", "bg-clear", "bg-update"]) assert.ok(names.includes(name), name);
			await rpc.prompt('/bg --name "RPC Echo" printf rpc-ok');
			const started = await rpc.wait(notifyWith(/Started RPC Echo/));
			const id = extractTaskId(started);
			await new Promise((resolve) => setTimeout(resolve, 250));
			await rpc.prompt(`/logs ${id} 200`);
			const logs = await rpc.wait(notifyWith(/rpc-ok[\s\S]*Full output/));
			assert.ok(logs);
			await rpc.prompt("/bg-clear");
			await rpc.wait(notifyWith(/Cleared 1 finished background task notice/));
		});
	});

	it("covers /jobs and /kill slash flow", async () => {
		await withRpc(async (rpc) => {
			await rpc.prompt('/bg --name "RPC Sleep" sleep 10');
			const started = await rpc.wait(notifyWith(/Started RPC Sleep/));
			const id = extractTaskId(started);
			await rpc.prompt("/jobs");
			await rpc.wait(notifyWith(/running[\s\S]*RPC Sleep/));
			await rpc.prompt(`/kill ${id}`);
			await rpc.wait(notifyWith(/Killed RPC Sleep/));
			await rpc.prompt("/jobs");
			await rpc.wait(notifyWith(/killed[\s\S]*RPC Sleep/));
		});
	});

	it("reports slash command input errors loudly", async () => {
		await withRpc(async (rpc) => {
			await rpc.prompt("/bg");
			await rpc.wait(notifyWith(/Background task failed to start:[\s\S]*empty/));
			await rpc.prompt('/bg --name "unterminated');
			await rpc.wait(notifyWith(/Background task failed to start:[\s\S]*requires a task name/));
			await rpc.prompt("/logs bdeadbeef 100");
			await rpc.wait(notifyWith(/Background logs error:[\s\S]*Unknown background task ID/));
			await rpc.prompt("/kill bdeadbeef");
			await rpc.wait(notifyWith(/Background kill error:[\s\S]*Unknown background task ID/));
		});
	});

	it("handles completed kill errors, logs byte normalization, and ambiguous prefixes", async () => {
		await withRpc(async (rpc) => {
			await rpc.prompt('/bg --name "RPC One" printf abcdef');
			const one = await rpc.wait(notifyWith(/Started RPC One/));
			const idOne = extractTaskId(one);
			await rpc.prompt('/bg --name "RPC Two" printf 123456');
			await rpc.wait(notifyWith(/Started RPC Two/));
			await new Promise((resolve) => setTimeout(resolve, 350));
			await rpc.prompt(`/kill ${idOne}`);
			await rpc.wait(notifyWith(/Background kill error:[\s\S]*not running/));
			await rpc.prompt(`/logs ${idOne} -10`);
			await rpc.wait(notifyWith(/Showing tail 1 B|Full output/));
			await rpc.prompt("/logs b 10");
			await rpc.wait(notifyWith(/Background logs error:[\s\S]*Ambiguous task ID prefix/));
		});
	});

	it("prints non-installing /bg-update instructions offline", async () => {
		await withRpc(async (rpc) => {
			const response = await rpc.prompt("/bg-update");
			assert.equal(response["success"], true);
			await rpc.wait(notifyWith(/pi install npm:pi-background-tasks@latest[\s\S]*does not install or self-update/));
		});
	});

	it("keeps /tasks and /bg-tasks callable in RPC mode without hanging", async () => {
		await withRpc(async (rpc) => {
			const tasksResponse = await rpc.prompt("/tasks");
			assert.equal(tasksResponse["success"], true);
			await rpc.wait((event) => event["type"] === "extension_ui_request" && event["method"] === "setStatus" && event["statusKey"] === "background-tasks");
			const bgTasksResponse = await rpc.prompt("/bg-tasks bdeadbeef");
			assert.equal(bgTasksResponse["success"], true);
		});
	});

	it("fails tasks that exceed the output cap and preserves a bounded log", async () => {
		await withRpc(async (rpc) => {
			await rpc.prompt('/bg --name "RPC Output Cap" node -e "process.stdout.write(\'x\'.repeat(4096))"');
			const started = await rpc.wait(notifyWith(/Started RPC Output Cap/));
			const id = extractTaskId(started);
			await new Promise((resolve) => setTimeout(resolve, 750));
			await rpc.prompt("/jobs");
			await rpc.wait(notifyWith(/failed[\s\S]*RPC Output Cap[\s\S]*Output exceeded cap|failed[\s\S]*Output exceeded cap[\s\S]*RPC Output Cap/), 15_000);
			await rpc.prompt(`/logs ${id} 200`);
			await rpc.wait(notifyWith(/background task error:[\s\S]*Output exceeded cap/));
		}, { PI_BG_MAX_OUTPUT_BYTES: "256" });
	});
});

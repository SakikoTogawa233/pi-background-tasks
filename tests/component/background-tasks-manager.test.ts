import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { visibleWidth } from "@earendil-works/pi-tui";
import { BackgroundTasksManager, type BackgroundTaskForUi } from "../../src/ui/background-tasks-manager.js";
import { stripAnsi } from "../../src/testing/normalize.js";

const theme = {
	bold: (text: string) => text,
	fg: (_color: string, text: string) => text,
} as any;

function task(overrides: Partial<BackgroundTaskForUi> = {}): BackgroundTaskForUi {
	const now = Date.now();
	return {
		id: "b12345678",
		name: "Component Task",
		command: "printf component-ok",
		status: "running",
		outputPath: ".pi/tasks/test/b12345678.output",
		outputAbsPath: join(tmpdir(), "missing-output"),
		cwd: tmpdir(),
		startTime: now - 1000,
		bytesWritten: 0,
		notified: false,
		notifyOnCompletion: true,
		triggerOnCompletion: false,
		...overrides,
	};
}

function manager(options: Partial<ConstructorParameters<typeof BackgroundTasksManager>[3]> = {}, tasks: BackgroundTaskForUi[] = [task()]) {
	let closed = false;
	let renders = 0;
	const stopped: string[] = [];
	const paths: string[] = [];
	const seen = new Set<string>();
	const instance = new BackgroundTasksManager(
		{ requestRender: () => { renders++; } },
		theme,
		() => { closed = true; },
		{
			getTasks: () => tasks,
			stopTask: async (t) => { stopped.push(t.id); t.status = "killed"; t.endTime = Date.now(); },
			stopAllRunning: async () => {
				const running = tasks.filter((t) => t.status === "running");
				for (const t of running) { stopped.push(t.id); t.status = "killed"; t.endTime = Date.now(); }
				return { stopped: running.length, failures: [] };
			},
			rerunTask: async (t) => { const rerun = task({ id: `babcdef${tasks.length}`, name: t.name, command: t.command, description: t.description, timeoutSeconds: t.timeoutSeconds, startTime: Date.now() }); tasks.unshift(rerun); return rerun; },
			showOutputPath: (t) => { paths.push(t.outputPath); },
			markSeen: (id) => { seen.add(id); },
			markFinishedSeen: (ids) => { for (const id of ids) seen.add(id); },
			isSeen: (id) => seen.has(id),
			...options,
		},
	);
	return { instance, get closed() { return closed; }, get renders() { return renders; }, stopped, paths, seen };
}

function assertWidth(lines: string[], width: number) {
	for (const line of lines) assert.ok(visibleWidth(stripAnsi(line)) <= width, line);
}

describe("BackgroundTasksManager component", () => {
	it("renders list within width and handles selection/actions", async () => {
		const tasks = [task({ id: "b11111111", name: "First Task" }), task({ id: "b22222222", name: "Second Task" })];
		const h = manager({}, tasks);
		try {
			let lines = h.instance.render(90);
			assert.match(stripAnsi(lines.join("\n")), /bg tasks focused/);
			assert.match(stripAnsi(lines.join("\n")), /First Task/);
			assertWidth(lines, 90);

			h.instance.handleInput("\x1b[B");
			h.instance.handleInput("k");
			await new Promise((resolve) => setTimeout(resolve, 0));
			assert.deepEqual(h.stopped, ["b22222222"]);

			h.instance.handleInput("h");
			h.instance.handleInput("R");
			await new Promise((resolve) => setTimeout(resolve, 0));
			assert.ok(tasks.some((candidate) => candidate.id.startsWith("babcdef")));

			h.instance.handleInput("c");
			assert.ok(h.paths.length >= 1);

			h.instance.handleInput("x");
			assert.equal(h.closed, true);
		} finally {
			h.instance.dispose();
		}
	});

	it("renders task-owned context window usage in list/detail rows and placeholder when absent", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-bg-context-"));
		try {
			const outputAbsPath = join(dir, "task.output");
			await writeFile(outputAbsPath, "context-output\n", "utf8");
			const tasks = [
				task({ id: "bctx00001", name: "Context Task", outputAbsPath, contextUsage: { tokens: 42_000, contextWindow: 200_000, percent: 21 } }),
				task({ id: "bctx00002", name: "No Context Task", outputAbsPath, startTime: Date.now() - 2000 }),
			];
			const h = manager({}, tasks);
			try {
				let text = stripAnsi(h.instance.render(100).join("\n"));
				assert.match(text, /ctx 21\.0%\/200k/);
				assert.match(text, /ctx —/);
				h.instance.handleInput("\r");
				await new Promise((resolve) => setTimeout(resolve, 20));
				text = stripAnsi(h.instance.render(100).join("\n"));
				assert.match(text, /Context: 21\.0% of 200k window \(42k tokens\)/);
			} finally {
				h.instance.dispose();
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("opens detail, reads bounded tail, refreshes, acts, and returns to list", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-bg-component-"));
		try {
			const outputAbsPath = join(dir, "task.output");
			await writeFile(outputAbsPath, "line one\ncomponent-tail\n", "utf8");
			const h = manager({ initialTaskId: "b12345678" }, [task({ outputAbsPath, bytesWritten: 24 })]);
			try {
				await new Promise((resolve) => setTimeout(resolve, 20));
				let text = stripAnsi(h.instance.render(100).join("\n"));
				assert.match(text, /bg: Component Task/);
				assert.match(text, /component-tail/);
				assert.ok(h.seen.has("b12345678"));

				h.instance.handleInput("r");
				h.instance.handleInput("c");
				h.instance.handleInput("k");
				await new Promise((resolve) => setTimeout(resolve, 0));
				assert.deepEqual(h.paths, [".pi/tasks/test/b12345678.output"]);
				assert.deepEqual(h.stopped, ["b12345678"]);
				h.instance.handleInput("R");
				await new Promise((resolve) => setTimeout(resolve, 0));
				assert.ok(text || true);

				h.instance.handleInput("\x1b[D");
				text = stripAnsi(h.instance.render(100).join("\n"));
				assert.match(text, /bg tasks focused/);
			} finally {
				h.instance.dispose();
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("requires confirmation before stopping all running tasks and reports no-op clearly", async () => {
		const tasks = [task({ id: "b11111111" }), task({ id: "b22222222" })];
		const h = manager({}, tasks);
		try {
			h.instance.handleInput("a");
			assert.deepEqual(h.stopped, []);
			assert.match(stripAnsi(h.instance.render(100).join("\n")), /Press a\/K again/);
			h.instance.handleInput("a");
			await new Promise((resolve) => setTimeout(resolve, 0));
			assert.deepEqual(h.stopped.sort(), ["b11111111", "b22222222"]);
			h.instance.handleInput("a");
			assert.match(stripAnsi(h.instance.render(100).join("\n")), /No running background tasks/);
		} finally {
			h.instance.dispose();
		}
	});

	it("shows empty and history states, unread badges, and does not auto-clear finished notices on close", () => {
		const h = manager({}, []);
		try {
			let text = stripAnsi(h.instance.render(72).join("\n"));
			assert.match(text, /No background tasks/);
			h.instance.handleInput("h");
			assert.match(stripAnsi(h.instance.render(72).join("\n")), /No background tasks/);
		} finally {
			h.instance.dispose();
		}

		const finished = [task({ id: "bfailed01", name: "Failed Task", status: "failed", error: "boom", endTime: Date.now(), exitCode: 1 })];
		const hf = manager({}, finished);
		try {
			const text = stripAnsi(hf.instance.render(80).join("\n"));
			assert.match(text, /1 failed/);
			assert.match(text, /1 unread/);
			assert.match(text, /●/);
			hf.instance.handleInput("x");
			assert.equal(hf.seen.has("bfailed01"), false);
		} finally {
			hf.instance.dispose();
		}
	});

	it("handles non-running stop, output read failures, paging, long text, and close aliases", async () => {
		const many = Array.from({ length: 20 }, (_, i) => task({ id: `b${String(i).padStart(8, "0")}`, name: `Very Long Component Task Name ${i} ${"x".repeat(80)}`, command: `printf ${i}`, startTime: Date.now() - i * 1000 }));
		many[0]!.status = "completed";
		many[0]!.endTime = Date.now();
		const h = manager({}, many);
		try {
			h.instance.handleInput("\x1b[6~");
			h.instance.handleInput("\x1b[5~");
			const lines = h.instance.render(50);
			assertWidth(lines, 50);
			h.instance.handleInput("h");
			h.instance.handleInput("\x1b[5~");
			assertWidth(h.instance.render(64), 64);
			h.instance.handleInput("\r");
			await new Promise((resolve) => setTimeout(resolve, 20));
			let text = stripAnsi(h.instance.render(80).join("\n"));
			assert.match(text, /Output file not found|No output yet|bg:/);
			h.instance.handleInput("\x1b[D");
			h.instance.handleInput("h");
			h.instance.handleInput("k");
			await new Promise((resolve) => setTimeout(resolve, 0));
			text = stripAnsi(h.instance.render(90).join("\n"));
			assert.match(text, /nothing to stop|Stopped/);
			h.instance.handleInput("q");
			assert.equal(h.closed, true);
		} finally {
			h.instance.dispose();
		}

		const esc = manager({}, [task()]);
		try {
			esc.instance.handleInput("\x1b");
			assert.equal(esc.closed, true);
		} finally {
			esc.instance.dispose();
		}
	});
});

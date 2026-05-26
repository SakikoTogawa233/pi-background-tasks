import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, statSync, type WriteStream } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, formatSize } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { Type } from "typebox";

/**
 * Project-local Pi background task manager.
 *
 * Scope:
 * - Explicit background shell jobs only: /bg and bg_run spawn commands directly.
 * - No Ctrl+B support for backgrounding an already-running built-in bash tool.
 * - No detached/restart reattachment: live child processes belong to this Pi
 *   extension runtime and are killed on session shutdown/reload.
 */

type TaskStatus = "running" | "completed" | "failed" | "killed";
type KillKind = "user" | "timeout" | "output_cap" | "shutdown";

type BgTaskSnapshot = {
	id: string;
	command: string;
	description?: string;
	status: TaskStatus;
	outputPath: string;
	cwd: string;
	startTime: number;
	endTime?: number;
	exitCode?: number | null;
	signal?: string | null;
	pid?: number;
	bytesWritten: number;
	error?: string;
	notified: boolean;
	notifyOnCompletion: boolean;
	triggerOnCompletion: boolean;
	timeoutSeconds?: number;
};

type BgTask = BgTaskSnapshot & {
	outputAbsPath: string;
	metadataAbsPath: string;
	child?: ChildProcess;
	stream?: WriteStream;
	timeoutHandle?: NodeJS.Timeout;
	killKind?: KillKind;
	killSignalSent?: boolean;
	capExceeded?: boolean;
	finalized?: boolean;
	waiters: Array<() => void>;
};

type BgRunDetails = {
	task: BgTaskSnapshot;
};

type BgStatusDetails = {
	tasks: BgTaskSnapshot[];
};

type BgLogsDetails = {
	task: BgTaskSnapshot;
	path: string;
	bytesRead: number;
	truncated: boolean;
	tail: boolean;
};

type BgKillDetails = {
	task: BgTaskSnapshot;
	message: string;
};

const DEFAULT_LOG_BYTES = Math.min(DEFAULT_MAX_BYTES, 50 * 1024);
const MAX_LOG_BYTES = Math.min(DEFAULT_MAX_BYTES, 50 * 1024);
const MAX_OUTPUT_BYTES = Number(process.env.PI_BG_MAX_OUTPUT_BYTES ?? 20 * 1024 * 1024);
const KILL_GRACE_MS = 3000;
const STOP_WAIT_MS = KILL_GRACE_MS + 1500;
const MAX_RECENT_TASKS = 100;
const STATUS_INTERVAL_MS = 1000;
const COMMAND_PREVIEW_CHARS = 90;
const DETAIL_TAIL_BYTES = 8 * 1024;
const LIST_VISIBLE_ROWS = 14;
const DETAIL_VISIBLE_OUTPUT_LINES = 12;
const LIGHT_BLUE_BG = "\x1b[48;2;183;223;255m";
const LIGHT_BLUE_FG = "\x1b[38;2;11;70;110m";
const LIGHT_BLUE_BORDER = "\x1b[38;2;83;160;215m";
const ANSI_RESET = "\x1b[0m";

function sanitizePathSegment(value: string): string {
	const sanitized = value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized || "session";
}

function stripMatchingQuotes(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed[trimmed.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

function truncateChars(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	const remSeconds = seconds % 60;
	if (minutes < 60) return `${minutes}m${remSeconds ? `${remSeconds}s` : ""}`;
	const hours = Math.floor(minutes / 60);
	const remMinutes = minutes % 60;
	return `${hours}h${remMinutes ? `${remMinutes}m` : ""}`;
}

function formatTime(timestamp: number): string {
	return new Date(timestamp).toLocaleTimeString();
}

function padAnsi(value: string, width: number): string {
	return value + " ".repeat(Math.max(0, width - visibleWidth(value)));
}

function lightBlue(value: string): string {
	return `${LIGHT_BLUE_BG}${LIGHT_BLUE_FG}${value}${ANSI_RESET}`;
}

function blueBorder(value: string): string {
	return `${LIGHT_BLUE_BORDER}${value}${ANSI_RESET}`;
}

function statusLabel(status: TaskStatus): string {
	if (status === "completed") return "done";
	if (status === "failed") return "error";
	if (status === "killed") return "stopped";
	return "running";
}

function statusColor(theme: Theme, status: TaskStatus, text = statusLabel(status)): string {
	if (status === "completed") return theme.fg("success", text);
	if (status === "failed") return theme.fg("error", text);
	if (status === "killed") return theme.fg("warning", text);
	return theme.fg("accent", text);
}

function sortTasksForUi(tasks: BgTask[]): BgTask[] {
	const rank = (task: BgTask) => (task.status === "running" ? 0 : task.status === "failed" ? 1 : task.status === "killed" ? 2 : 3);
	return [...tasks].sort((a, b) => {
		const rankDiff = rank(a) - rank(b);
		if (rankDiff !== 0) return rankDiff;
		return (b.endTime ?? b.startTime) - (a.endTime ?? a.startTime);
	});
}

function shellInvocation(command: string): { shell: string; args: string[] } {
	if (process.platform === "win32") {
		return { shell: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", command] };
	}
	return { shell: process.env.SHELL || "/bin/sh", args: ["-c", command] };
}

function normalizeMaxBytes(value: unknown, fallback = DEFAULT_LOG_BYTES): number {
	const raw = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
	return Math.max(1, Math.min(MAX_LOG_BYTES, raw));
}

function snapshot(task: BgTask): BgTaskSnapshot {
	return {
		id: task.id,
		command: task.command,
		description: task.description,
		status: task.status,
		outputPath: task.outputPath,
		cwd: task.cwd,
		startTime: task.startTime,
		endTime: task.endTime,
		exitCode: task.exitCode,
		signal: task.signal,
		pid: task.pid,
		bytesWritten: task.bytesWritten,
		error: task.error,
		notified: task.notified,
		notifyOnCompletion: task.notifyOnCompletion,
		triggerOnCompletion: task.triggerOnCompletion,
		timeoutSeconds: task.timeoutSeconds,
	};
}

function textContent(text: string) {
	return [{ type: "text" as const, text }];
}

function taskAge(task: BgTask, now = Date.now()): string {
	return formatDuration((task.endTime ?? now) - task.startTime);
}

function formatTaskLine(task: BgTask, now = Date.now()): string {
	const statusIcon =
		task.status === "running" ? "▶" : task.status === "completed" ? "✓" : task.status === "killed" ? "■" : "✗";
	const code = task.exitCode !== undefined ? ` exit=${task.exitCode}` : "";
	const pid = task.pid ? ` pid=${task.pid}` : "";
	const error = task.error ? ` error=${truncateChars(task.error, 80)}` : "";
	const label = task.description || task.command;
	return `${statusIcon} ${task.id} ${task.status} ${taskAge(task, now)}${code}${pid} — ${truncateChars(label, COMMAND_PREVIEW_CHARS)}${error}\n    output: ${task.outputPath}`;
}

function formatTaskList(tasks: BgTask[], now = Date.now()): string {
	if (tasks.length === 0) return "No background tasks in this Pi extension runtime.";
	const running = tasks.filter((task) => task.status === "running");
	const finished = tasks
		.filter((task) => task.status !== "running")
		.sort((a, b) => (b.endTime ?? b.startTime) - (a.endTime ?? a.startTime))
		.slice(0, 20);
	const ordered = [...running.sort((a, b) => a.startTime - b.startTime), ...finished];
	return ordered.map((task) => formatTaskLine(task, now)).join("\n");
}

function formatSnapshotList(tasks: BgTaskSnapshot[], now = Date.now()): string {
	if (tasks.length === 0) return "No background tasks in this Pi extension runtime.";
	return tasks
		.map((task) => {
			const statusIcon =
				task.status === "running" ? "▶" : task.status === "completed" ? "✓" : task.status === "killed" ? "■" : "✗";
			const age = formatDuration((task.endTime ?? now) - task.startTime);
			const code = task.exitCode !== undefined ? ` exit=${task.exitCode}` : "";
			const pid = task.pid ? ` pid=${task.pid}` : "";
			const error = task.error ? ` error=${truncateChars(task.error, 80)}` : "";
			const label = task.description || task.command;
			return `${statusIcon} ${task.id} ${task.status} ${age}${code}${pid} — ${truncateChars(label, COMMAND_PREVIEW_CHARS)}${error}\n    output: ${task.outputPath}`;
		})
		.join("\n");
}

async function boundedRead(filePath: string, maxBytes: number, tail: boolean): Promise<{ content: string; truncated: boolean; bytesRead: number; totalBytes: number }> {
	const stat = statSync(filePath);
	const totalBytes = stat.size;
	const bytesToRead = Math.min(totalBytes, maxBytes);
	if (bytesToRead === 0) {
		return { content: "", truncated: false, bytesRead: 0, totalBytes };
	}

	const file = await open(filePath, "r");
	try {
		const buffer = Buffer.alloc(bytesToRead);
		const position = tail ? Math.max(0, totalBytes - bytesToRead) : 0;
		const { bytesRead } = await file.read(buffer, 0, bytesToRead, position);
		return {
			content: buffer.subarray(0, bytesRead).toString("utf8"),
			truncated: totalBytes > bytesRead,
			bytesRead,
			totalBytes,
		};
	} finally {
		await file.close();
	}
}

function renderPlainResult(result: { content?: Array<{ type: string; text?: string }> }, _options: ToolRenderResultOptions, _theme: any) {
	const first = result.content?.find((part) => part.type === "text");
	return new Text(first?.text ?? "", 0, 0);
}

type TaskManagerResult = "closed" | "killed";

type TaskManagerOptions = {
	initialTaskId?: string;
	getTasks: () => BgTask[];
	stopTask: (task: BgTask) => Promise<void>;
	markSeen: (taskId: string) => void;
	isSeen: (taskId: string) => boolean;
};

class BackgroundTasksManager implements Component {
	private mode: "list" | "detail" = "list";
	private selectedIndex = 0;
	private listScroll = 0;
	private detailTaskId: string | undefined;
	private showHistory = false;
	private tailText = "";
	private tailBytesRead = 0;
	private tailTotalBytes = 0;
	private tailTruncated = false;
	private tailError: string | undefined;
	private actionMessage: string | undefined;
	private refreshTimer: NodeJS.Timeout;

	constructor(
		private readonly tui: Pick<TUI, "requestRender">,
		private readonly theme: Theme,
		private readonly done: (result: TaskManagerResult) => void,
		private readonly options: TaskManagerOptions,
	) {
		if (options.initialTaskId) {
			this.detailTaskId = options.initialTaskId;
			this.mode = "detail";
			this.options.markSeen(options.initialTaskId);
			void this.refreshTail();
		}
		this.refreshTimer = setInterval(() => {
			if (this.mode === "detail") void this.refreshTail();
			this.tui.requestRender();
		}, STATUS_INTERVAL_MS);
	}

	dispose(): void {
		clearInterval(this.refreshTimer);
	}

	invalidate(): void {}

	handleInput(data: string): void {
		this.actionMessage = undefined;
		if (matchesKey(data, "escape") || data === "q" || data === "Q") {
			if (this.mode === "detail" && this.currentTasks().length > 1) {
				this.mode = "list";
				this.detailTaskId = undefined;
				this.tui.requestRender();
				return;
			}
			this.done("closed");
			return;
		}

		if (this.mode === "detail") {
			this.handleDetailInput(data);
			return;
		}
		this.handleListInput(data);
	}

	render(width: number): string[] {
		const boxWidth = Math.max(48, Math.min(width, 96));
		return this.mode === "detail" ? this.renderDetail(boxWidth) : this.renderList(boxWidth);
	}

	private handleListInput(data: string): void {
		const tasks = this.currentTasks();
		if (tasks.length === 0) {
			if (matchesKey(data, "return")) this.done("closed");
			return;
		}
		if (matchesKey(data, "up")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.ensureSelectionVisible();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "down")) {
			this.selectedIndex = Math.min(tasks.length - 1, this.selectedIndex + 1);
			this.ensureSelectionVisible();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.selectedIndex = Math.max(0, this.selectedIndex - LIST_VISIBLE_ROWS);
			this.ensureSelectionVisible();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.selectedIndex = Math.min(tasks.length - 1, this.selectedIndex + LIST_VISIBLE_ROWS);
			this.ensureSelectionVisible();
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "return") || matchesKey(data, "right")) {
			const task = tasks[this.selectedIndex];
			if (!task) return;
			this.openDetail(task.id);
			return;
		}
		if (data === "x" || data === "X") {
			const task = tasks[this.selectedIndex];
			if (task) void this.killTaskFromUi(task);
			return;
		}
		if (data === "h" || data === "H") {
			this.showHistory = !this.showHistory;
			this.selectedIndex = 0;
			this.listScroll = 0;
			this.tui.requestRender();
		}
	}

	private handleDetailInput(data: string): void {
		const task = this.detailTask();
		if (matchesKey(data, "left")) {
			this.mode = "list";
			this.detailTaskId = undefined;
			this.tui.requestRender();
			return;
		}
		if (data === "r" || data === "R") {
			void this.refreshTail();
			return;
		}
		if ((data === "x" || data === "X") && task) {
			void this.killTaskFromUi(task);
		}
	}

	private currentTasks(): BgTask[] {
		const allTasks = this.options.getTasks();
		const visible = this.showHistory ? allTasks : allTasks.filter((task) => task.status === "running");
		return sortTasksForUi(visible);
	}

	private detailTask(): BgTask | undefined {
		return this.options.getTasks().find((task) => task.id === this.detailTaskId);
	}

	private openDetail(taskId: string): void {
		this.detailTaskId = taskId;
		this.mode = "detail";
		this.tailText = "";
		this.tailError = undefined;
		this.options.markSeen(taskId);
		void this.refreshTail();
		this.tui.requestRender();
	}

	private ensureSelectionVisible(): void {
		if (this.selectedIndex < this.listScroll) this.listScroll = this.selectedIndex;
		if (this.selectedIndex >= this.listScroll + LIST_VISIBLE_ROWS) this.listScroll = this.selectedIndex - LIST_VISIBLE_ROWS + 1;
	}

	private async killTaskFromUi(task: BgTask): Promise<void> {
		if (task.status !== "running") {
			this.actionMessage = `Task ${task.id} is ${task.status}; nothing to stop.`;
			this.tui.requestRender();
			return;
		}
		this.actionMessage = `Stopping ${task.id}…`;
		this.tui.requestRender();
		try {
			await this.options.stopTask(task);
			this.actionMessage = `Stopped ${task.id}.`;
			this.done("killed");
		} catch (error) {
			this.actionMessage = `Stop failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		this.tui.requestRender();
	}

	private async refreshTail(): Promise<void> {
		const task = this.detailTask();
		if (!task) return;
		try {
			if (!existsSync(task.outputAbsPath)) {
				this.tailText = "";
				this.tailBytesRead = 0;
				this.tailTotalBytes = 0;
				this.tailTruncated = false;
				this.tailError = `Output file not found: ${task.outputPath}`;
				return;
			}
			const read = await boundedRead(task.outputAbsPath, DETAIL_TAIL_BYTES, true);
			this.tailText = read.content;
			this.tailBytesRead = read.bytesRead;
			this.tailTotalBytes = read.totalBytes;
			this.tailTruncated = read.truncated;
			this.tailError = undefined;
		} catch (error) {
			this.tailError = `Output read failed: ${error instanceof Error ? error.message : String(error)}`;
		}
		this.tui.requestRender();
	}

	private frame(title: string, subtitle: string, body: string[], footer: string, width: number): string[] {
		const inner = width - 2;
		const top = blueBorder(`╭${"─".repeat(inner)}╮`);
		const bottom = blueBorder(`╰${"─".repeat(inner)}╯`);
		const row = (content = "") => `${blueBorder("│")}${padAnsi(truncateToWidth(content, inner), inner)}${blueBorder("│")}`;
		const header = lightBlue(padAnsi(` ${title}`, inner));
		const subtitleLine = subtitle ? lightBlue(padAnsi(` ${subtitle}`, inner)) : lightBlue(" ".repeat(inner));
		const lines = [top, row(header), row(subtitleLine), row()];
		for (const line of body) lines.push(row(line));
		lines.push(row());
		lines.push(row(footer));
		lines.push(bottom);
		return lines;
	}

	private renderList(width: number): string[] {
		const tasks = this.currentTasks();
		if (this.selectedIndex >= tasks.length) this.selectedIndex = Math.max(0, tasks.length - 1);
		this.ensureSelectionVisible();

		const allTasks = this.options.getTasks();
		const allRunning = allTasks.filter((task) => task.status === "running").length;
		const historyCount = allTasks.length - allRunning;
		const unread = allTasks.filter((task) => task.status !== "running" && !this.options.isSeen(task.id)).length;
		const subtitle = this.showHistory
			? `${allRunning} active · ${historyCount} history${unread ? ` · ${unread} unread` : ""}`
			: allRunning > 0
				? `${allRunning} active shell${allRunning === 1 ? "" : "s"}`
				: "No active shells";

		const body: string[] = [];
		if (tasks.length === 0) {
			const message = this.showHistory
				? "  No background tasks in this session."
				: historyCount > 0
					? "  No running background tasks. Press h to show recent history."
					: "  No running background tasks.";
			body.push(this.theme.fg("dim", message));
		} else {
			const maxLabelWidth = Math.max(16, width - 42);
			const visible = tasks.slice(this.listScroll, this.listScroll + LIST_VISIBLE_ROWS);
			for (let i = 0; i < visible.length; i++) {
				const task = visible[i]!;
				const index = this.listScroll + i;
				const selected = index === this.selectedIndex;
				const pointer = selected ? "›" : " ";
				const unreadMark = task.status !== "running" && !this.options.isSeen(task.id) ? this.theme.fg("warning", "● ") : "  ";
				const label = truncateChars(task.description || task.command, maxLabelWidth);
				const status = statusColor(this.theme, task.status, statusLabel(task.status));
				const runtime = taskAge(task);
				const size = formatSize(task.bytesWritten);
				let row = ` ${pointer} ${unreadMark}${this.theme.fg("accent", task.id)} ${label} ${this.theme.fg("dim", "·")} ${status} ${this.theme.fg("dim", `${runtime} ${size}`)}`;
				if (selected) row = lightBlue(padAnsi(truncateToWidth(row, width - 4), width - 4));
				body.push(row);
			}
			if (tasks.length > LIST_VISIBLE_ROWS) {
				body.push(this.theme.fg("dim", `  Showing ${this.listScroll + 1}-${Math.min(tasks.length, this.listScroll + LIST_VISIBLE_ROWS)} of ${tasks.length}`));
			}
		}
		if (this.actionMessage) body.push(this.theme.fg("warning", `  ${this.actionMessage}`));
		return this.frame(
			"Background tasks",
			subtitle,
			body,
			` ${this.theme.fg("dim", `↑/↓ select · Enter inspect · x stop · h ${this.showHistory ? "hide" : "show"} history · Esc close`)}`,
			width,
		);
	}

	private renderDetail(width: number): string[] {
		const task = this.detailTask();
		if (!task) {
			this.mode = "list";
			return this.renderList(width);
		}
		const status = statusColor(this.theme, task.status);
		const exit = task.exitCode !== undefined ? ` exit=${task.exitCode}` : "";
		const body: string[] = [
			` ${this.theme.fg("toolTitle", "Status:")} ${status}${this.theme.fg("dim", exit)}`,
			` ${this.theme.fg("toolTitle", "Runtime:")} ${taskAge(task)}${task.pid ? this.theme.fg("dim", ` · pid ${task.pid}`) : ""}`,
			` ${this.theme.fg("toolTitle", "Started:")} ${formatTime(task.startTime)}${task.endTime ? this.theme.fg("dim", ` · ended ${formatTime(task.endTime)}`) : ""}`,
			` ${this.theme.fg("toolTitle", "Output:")} ${this.theme.fg("accent", task.outputPath)}`,
			` ${this.theme.fg("toolTitle", "Command:")} ${truncateToWidth(task.command, width - 13)}`,
		];
		if (task.error) body.push(` ${this.theme.fg("error", `Error: ${task.error}`)}`);
		body.push("", ` ${this.theme.fg("toolTitle", "Output tail:")}`);
		body.push(...this.renderOutputBox(width - 4));
		if (this.actionMessage) body.push(this.theme.fg("warning", ` ${this.actionMessage}`));
		const subtitle = `${task.id} · ${task.status === "running" ? "live tail refreshes every second" : "final output"}`;
		const footer = ` ${this.theme.fg("dim", "← back · r refresh · x stop running task · Esc close")}`;
		return this.frame("Shell details", subtitle, body, footer, width);
	}

	private renderOutputBox(width: number): string[] {
		const inner = Math.max(20, width - 2);
		const top = ` ${blueBorder(`╭${"─".repeat(inner)}╮`)}`;
		const bottom = ` ${blueBorder(`╰${"─".repeat(inner)}╯`)}`;
		const row = (content = "") => ` ${blueBorder("│")}${padAnsi(truncateToWidth(content, inner), inner)}${blueBorder("│")}`;
		const lines = [top];
		if (this.tailError) {
			lines.push(row(this.theme.fg("error", this.tailError)));
		} else if (!this.tailText) {
			lines.push(row(this.theme.fg("dim", "No output yet")));
		} else {
			const outputLines = this.tailText.replace(/\r/g, "").split("\n").filter((line, index, array) => line.length > 0 || index < array.length - 1);
			const visible = outputLines.slice(-DETAIL_VISIBLE_OUTPUT_LINES);
			for (const line of visible) lines.push(row(this.theme.fg("toolOutput", line)));
		}
		while (lines.length < DETAIL_VISIBLE_OUTPUT_LINES + 1) lines.push(row());
		lines.push(bottom);
		const suffix = this.tailTruncated ? ` of ${formatSize(this.tailTotalBytes)}` : "";
		lines.push(` ${this.theme.fg("dim", `Showing tail ${formatSize(this.tailBytesRead)}${suffix}`)}`);
		return lines;
	}
}

export default function backgroundTasksExtension(pi: ExtensionAPI): void {
	const tasks = new Map<string, BgTask>();
	let runtimeDirAbs: string | undefined;
	let runtimeDirDisplay: string | undefined;
	let currentCtx: ExtensionContext | undefined;
	let shuttingDown = false;
	let statusInterval: NodeJS.Timeout | undefined;
	const seenTaskIds = new Set<string>();

	function makeTaskId(): string {
		for (let attempt = 0; attempt < 20; attempt++) {
			const id = `b${randomBytes(4).toString("hex")}`;
			if (!tasks.has(id)) return id;
		}
		throw new Error("Could not generate a unique background task ID after 20 attempts");
	}

	async function ensureRuntimeDir(ctx: ExtensionContext): Promise<{ abs: string; display: string }> {
		if (runtimeDirAbs && runtimeDirDisplay) return { abs: runtimeDirAbs, display: runtimeDirDisplay };
		const sessionId = sanitizePathSegment(ctx.sessionManager.getSessionId?.() || "session");
		const runId = `${sessionId}-${process.pid}`;
		runtimeDirAbs = join(ctx.cwd, ".pi", "tasks", runId);
		runtimeDirDisplay = join(".pi", "tasks", runId);
		await mkdir(runtimeDirAbs, { recursive: true });
		return { abs: runtimeDirAbs, display: runtimeDirDisplay };
	}

	async function writeMetadata(task: BgTask): Promise<void> {
		await writeFile(task.metadataAbsPath, `${JSON.stringify(snapshot(task), null, 2)}\n`, "utf8");
	}

	function updateUi(ctx = currentCtx): void {
		if (shuttingDown || !ctx) return;
		try {
			if (!ctx.hasUI) return;
			const running = [...tasks.values()].filter((task) => task.status === "running");
			ctx.ui.setWidget("background-tasks", undefined);
			if (running.length === 0) {
				ctx.ui.setStatus("background-tasks", undefined);
				return;
			}

			const label = ` bg ${running.length} running · /tasks `;
			ctx.ui.setStatus("background-tasks", lightBlue(label));
		} catch (error) {
			console.error(`[background-tasks] UI update failed: ${error instanceof Error ? error.message : String(error)}`);
			currentCtx = undefined;
		}
	}

	function appendToOutput(task: BgTask, data: Buffer | string): void {
		if (!task.stream || task.stream.destroyed) return;
		const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
		if (buffer.length === 0) return;

		const nextBytes = task.bytesWritten + buffer.length;
		if (nextBytes <= MAX_OUTPUT_BYTES) {
			task.stream.write(buffer);
			task.bytesWritten = nextBytes;
			return;
		}

		const remaining = Math.max(0, MAX_OUTPUT_BYTES - task.bytesWritten);
		if (remaining > 0) {
			task.stream.write(buffer.subarray(0, remaining));
			task.bytesWritten += remaining;
		}

		if (!task.capExceeded) {
			task.capExceeded = true;
			task.error = `Output exceeded cap of ${formatSize(MAX_OUTPUT_BYTES)}; terminating task`;
			const notice = `\n\n[background task error: ${task.error}]\n`;
			task.stream.write(notice);
			task.bytesWritten += Buffer.byteLength(notice, "utf8");
			task.killKind = "output_cap";
			try {
				requestKill(task, "SIGTERM");
			} catch (error) {
				task.error = `${task.error}; kill failed: ${error instanceof Error ? error.message : String(error)}`;
				void finalizeTask(task, "failed", null, undefined, task.error);
			}
		}
	}

	function requestKill(task: BgTask, signal: NodeJS.Signals = "SIGTERM"): void {
		if (task.status !== "running") {
			throw new Error(`Task ${task.id} is ${task.status}, not running`);
		}
		if (!task.child) {
			throw new Error(`Task ${task.id} has no child process handle`);
		}
		if (!task.pid) {
			throw new Error(`Task ${task.id} has no process id`);
		}
		if (task.killSignalSent && signal === "SIGTERM") return;

		const errors: string[] = [];
		let killed = false;

		if (process.platform !== "win32") {
			try {
				process.kill(-task.pid, signal);
				killed = true;
			} catch (error) {
				errors.push(`process group kill failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		if (!killed) {
			try {
				task.child.kill(signal);
				killed = true;
			} catch (error) {
				errors.push(`child kill failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		if (!killed) {
			throw new Error(`Could not kill task ${task.id}: ${errors.join("; ")}`);
		}

		task.killSignalSent = true;
		setTimeout(() => {
			if (task.status !== "running") return;
			try {
				requestKill(task, "SIGKILL");
			} catch (error) {
				task.error = `SIGKILL failed: ${error instanceof Error ? error.message : String(error)}`;
				void writeMetadata(task).catch((metadataError) => {
					console.error(`[background-tasks] failed to write metadata for ${task.id}:`, metadataError);
				});
			}
		}, KILL_GRACE_MS).unref?.();
	}

	function waitForEnd(task: BgTask, timeoutMs: number): Promise<boolean> {
		if (task.status !== "running") return Promise.resolve(true);
		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				const idx = task.waiters.indexOf(done);
				if (idx >= 0) task.waiters.splice(idx, 1);
				resolve(false);
			}, timeoutMs);
			const done = () => {
				clearTimeout(timeout);
				resolve(true);
			};
			task.waiters.push(done);
		});
	}

	async function stopTask(task: BgTask, kind: KillKind, reason?: string): Promise<BgTask> {
		if (task.status !== "running") {
			throw new Error(`Task ${task.id} is ${task.status}, not running`);
		}
		task.killKind = kind;
		if (reason) task.error = reason;
		requestKill(task, "SIGTERM");
		const stopped = await waitForEnd(task, STOP_WAIT_MS);
		if (!stopped) {
			throw new Error(`Task ${task.id} did not exit within ${formatDuration(STOP_WAIT_MS)} after SIGTERM/SIGKILL`);
		}
		return task;
	}

	async function notifyCompletion(task: BgTask): Promise<void> {
		if (!task.notifyOnCompletion || task.notified || shuttingDown) return;
		task.notified = true;
		const exit = task.exitCode === undefined ? "" : `\n  <exit-code>${task.exitCode}</exit-code>`;
		const error = task.error ? `\n  <error>${escapeXml(task.error)}</error>` : "";
		const content = [
			"<background-task-notification>",
			`  <task-id>${task.id}</task-id>`,
			`  <status>${task.status}</status>`,
			exit,
			error,
			`  <output-file>${escapeXml(task.outputPath)}</output-file>`,
			`  <summary>${escapeXml(`Background command ${JSON.stringify(task.description || task.command)} ${task.status}`)}</summary>`,
			"</background-task-notification>",
		]
			.filter(Boolean)
			.join("\n");

		try {
			pi.sendMessage(
				{
					customType: "background-task-notification",
					content,
					display: true,
					details: snapshot(task),
				},
				{ deliverAs: "followUp", triggerTurn: task.triggerOnCompletion },
			);
		} catch (error) {
			task.notified = false;
			throw new Error(`Failed to send background task notification for ${task.id}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	function escapeXml(value: string): string {
		return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	}

	async function finalizeTask(task: BgTask, status: TaskStatus, exitCode: number | null, signal?: string | null, error?: string): Promise<void> {
		if (task.finalized) return;
		task.finalized = true;
		if (task.timeoutHandle) clearTimeout(task.timeoutHandle);
		task.status = status;
		task.exitCode = exitCode;
		task.signal = signal ?? null;
		task.endTime = Date.now();
		if (error) task.error = error;
		if (task.stream && !task.stream.destroyed) task.stream.end();

		for (const waiter of task.waiters.splice(0)) waiter();

		try {
			await writeMetadata(task);
		} catch (metadataError) {
			console.error(`[background-tasks] failed to write metadata for ${task.id}:`, metadataError);
		}

		updateUi();
		try {
			await notifyCompletion(task);
		} catch (notificationError) {
			console.error(`[background-tasks] notification failed for ${task.id}:`, notificationError);
		}
		try {
			await writeMetadata(task);
		} catch (metadataError) {
			console.error(`[background-tasks] failed to update notification metadata for ${task.id}:`, metadataError);
		}
		pruneOldTasks();
	}

	function pruneOldTasks(): void {
		if (tasks.size <= MAX_RECENT_TASKS) return;
		const removable = [...tasks.values()]
			.filter((task) => task.status !== "running")
			.sort((a, b) => (a.endTime ?? a.startTime) - (b.endTime ?? b.startTime));
		while (tasks.size > MAX_RECENT_TASKS && removable.length > 0) {
			const task = removable.shift();
			if (task) tasks.delete(task.id);
		}
	}

	async function startTask(
		ctx: ExtensionContext,
		command: string,
		options: { description?: string; timeoutSeconds?: number; notifyOnCompletion?: boolean; triggerOnCompletion?: boolean } = {},
	): Promise<BgTask> {
		const normalizedCommand = stripMatchingQuotes(command);
		if (!normalizedCommand) throw new Error("Background command is empty");
		if (shuttingDown) throw new Error("Cannot start a background task while Pi is shutting down");

		currentCtx = ctx;
		const dir = await ensureRuntimeDir(ctx);
		const id = makeTaskId();
		const outputAbsPath = join(dir.abs, `${id}.output`);
		const metadataAbsPath = join(dir.abs, `${id}.json`);
		const outputPath = join(dir.display, `${id}.output`);
		const timeoutSeconds =
			typeof options.timeoutSeconds === "number" && Number.isFinite(options.timeoutSeconds) && options.timeoutSeconds > 0
				? Math.floor(options.timeoutSeconds)
				: undefined;

		const task: BgTask = {
			id,
			command: normalizedCommand,
			description: options.description?.trim() || undefined,
			status: "running",
			outputPath,
			outputAbsPath,
			metadataAbsPath,
			cwd: ctx.cwd,
			startTime: Date.now(),
			exitCode: undefined,
			pid: undefined,
			bytesWritten: 0,
			notified: false,
			notifyOnCompletion: options.notifyOnCompletion ?? true,
			triggerOnCompletion: options.triggerOnCompletion ?? false,
			timeoutSeconds,
			waiters: [],
		};
		tasks.set(id, task);

		const stream = createWriteStream(outputAbsPath, { flags: "a", encoding: "utf8" });
		task.stream = stream;
		stream.on("error", (error) => {
			task.error = `Output file write failed: ${error.message}`;
			if (task.status === "running") {
				task.killKind = "output_cap";
				try {
					requestKill(task, "SIGTERM");
				} catch (killError) {
					void finalizeTask(
						task,
						"failed",
						null,
						undefined,
						`${task.error}; kill failed: ${killError instanceof Error ? killError.message : String(killError)}`,
					);
				}
			}
		});

		try {
			const invocation = shellInvocation(normalizedCommand);
			const child = spawn(invocation.shell, invocation.args, {
				cwd: ctx.cwd,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
				env: process.env,
				windowsHide: true,
			});

			task.child = child;
			task.pid = child.pid;

			child.stdout?.on("data", (data) => appendToOutput(task, data));
			child.stderr?.on("data", (data) => appendToOutput(task, data));

			child.on("error", (error) => {
				appendToOutput(task, `\n[background task spawn error: ${error.message}]\n`);
				void finalizeTask(task, "failed", null, undefined, error.message);
			});

			child.on("close", (code, signalName) => {
				let status: TaskStatus;
				let error: string | undefined;
				if (task.killKind === "user" || task.killKind === "shutdown") {
					status = "killed";
				} else if (task.killKind === "timeout") {
					status = "failed";
					error = task.error || `Timed out after ${task.timeoutSeconds}s`;
				} else if (task.killKind === "output_cap") {
					status = "failed";
					error = task.error || `Output exceeded cap of ${formatSize(MAX_OUTPUT_BYTES)}`;
				} else if ((code ?? 0) === 0) {
					status = "completed";
				} else {
					status = "failed";
					error = `Exited with code ${code ?? "null"}${signalName ? ` (${signalName})` : ""}`;
				}
				void finalizeTask(task, status, code, signalName, error);
			});

			if (timeoutSeconds) {
				task.timeoutHandle = setTimeout(() => {
					if (task.status !== "running") return;
					task.killKind = "timeout";
					task.error = `Timed out after ${timeoutSeconds}s`;
					appendToOutput(task, `\n[background task timeout: ${task.error}]\n`);
					try {
						requestKill(task, "SIGTERM");
					} catch (error) {
						void finalizeTask(task, "failed", null, undefined, `${task.error}; kill failed: ${error instanceof Error ? error.message : String(error)}`);
					}
				}, timeoutSeconds * 1000);
			}

			await writeMetadata(task);
			updateUi(ctx);
			return task;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			appendToOutput(task, `\n[background task spawn exception: ${message}]\n`);
			await finalizeTask(task, "failed", null, undefined, message);
			throw new Error(`Failed to start background task: ${message}`);
		}
	}

	function resolveTask(idOrPrefix: string): BgTask {
		const id = idOrPrefix.trim();
		if (!id) throw new Error("Task ID is required");
		const exact = tasks.get(id);
		if (exact) return exact;
		const matches = [...tasks.values()].filter((task) => task.id.startsWith(id));
		if (matches.length === 1) return matches[0];
		if (matches.length > 1) throw new Error(`Ambiguous task ID prefix "${id}": ${matches.map((task) => task.id).join(", ")}`);
		throw new Error(`Unknown background task ID: ${id}`);
	}

	async function getTaskLogs(task: BgTask, maxBytes: number, tail: boolean): Promise<{ text: string; details: BgLogsDetails }> {
		if (!existsSync(task.outputAbsPath)) {
			throw new Error(`Output file does not exist for ${task.id}: ${task.outputPath}`);
		}
		const read = await boundedRead(task.outputAbsPath, maxBytes, tail);
		const direction = tail ? "tail" : "head";
		let text = read.content || "(no output yet)";
		if (read.truncated) {
			const omitted = read.totalBytes - read.bytesRead;
			const notice = `\n\n[Showing ${direction} ${formatSize(read.bytesRead)} of ${formatSize(read.totalBytes)}; ${formatSize(omitted)} omitted. Full output: ${task.outputPath}]`;
			text = tail ? `${notice}\n\n${text}` : `${text}${notice}`;
		} else {
			text += `\n\n[Full output: ${task.outputPath}]`;
		}
		return {
			text,
			details: {
				task: snapshot(task),
				path: task.outputPath,
				bytesRead: read.bytesRead,
				truncated: read.truncated,
				tail,
			},
		};
	}

	async function openTaskManager(ctx: ExtensionCommandContext | ExtensionContext, initialTaskId?: string): Promise<void> {
		currentCtx = ctx;
		if (!ctx.hasUI) {
			ctx.ui.notify("Background task manager requires an interactive Pi UI. Use /jobs, /logs, or the bg_status/bg_logs tools in non-interactive mode.", "error");
			return;
		}
		await ctx.ui.custom<TaskManagerResult>(
			(tui, theme, _keybindings, done) =>
				new BackgroundTasksManager(tui, theme, done, {
					initialTaskId,
					getTasks: () => [...tasks.values()],
					stopTask: async (task) => {
						await stopTask(task, "user");
						updateUi(ctx);
					},
					markSeen: (taskId) => {
						seenTaskIds.add(taskId);
						updateUi(ctx);
					},
					isSeen: (taskId) => seenTaskIds.has(taskId),
				}),
			{
				overlay: true,
				overlayOptions: { anchor: "center", width: "86%", minWidth: 64, maxHeight: "85%", margin: 1 },
			},
		);
		updateUi(ctx);
	}

	pi.registerMessageRenderer<BgTaskSnapshot>("background-task-notification", (message, _options, theme) => {
		const task = message.details;
		const status = task?.status ?? "completed";
		const color = status === "completed" ? "success" : status === "failed" ? "error" : status === "killed" ? "warning" : "accent";
		const id = task?.id ?? "background task";
		const output = task?.outputPath ? `\n${theme.fg("dim", `Output: ${task.outputPath}`)}` : "";
		const error = task?.error ? `\n${theme.fg("error", task.error)}` : "";
		return new Text(`${theme.fg(color as any, `[bg ${status}]`)} ${theme.fg("accent", id)}${output}${error}`, 0, 0);
	});

	pi.on("session_start", async (_event, ctx) => {
		shuttingDown = false;
		currentCtx = ctx;
		await ensureRuntimeDir(ctx);
		updateUi(ctx);
		if (statusInterval) clearInterval(statusInterval);
		statusInterval = setInterval(() => updateUi(), STATUS_INTERVAL_MS);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		shuttingDown = true;
		currentCtx = undefined;
		if (statusInterval) {
			clearInterval(statusInterval);
			statusInterval = undefined;
		}
		const running = [...tasks.values()].filter((task) => task.status === "running");
		if (running.length === 0) return;

		const failures: string[] = [];
		await Promise.all(
			running.map(async (task) => {
				try {
					await stopTask(task, "shutdown", "Killed during Pi session shutdown/reload");
				} catch (error) {
					const message = `${task.id}: ${error instanceof Error ? error.message : String(error)}`;
					failures.push(message);
					console.error(`[background-tasks] shutdown cleanup failed for ${message}`);
				}
			}),
		);
		if (failures.length > 0 && ctx.hasUI) {
			ctx.ui.notify(`Background task cleanup failed:\n${failures.join("\n")}`, "error");
		}
	});

	pi.registerCommand("bg", {
		description: "Start a shell command as a tracked background task: /bg <command>",
		handler: async (args, ctx) => {
			try {
				const task = await startTask(ctx, args, { notifyOnCompletion: true, triggerOnCompletion: false });
				ctx.ui.notify(`Started ${task.id}\nOutput: ${task.outputPath}\nCommand: ${task.command}`, "info");
			} catch (error) {
				ctx.ui.notify(`Background task failed to start: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("tasks", {
		description: "Open the Claude-like background task manager UI",
		handler: async (args, ctx) => {
			const taskId = args.trim() || undefined;
			await openTaskManager(ctx, taskId);
		},
	});

	pi.registerCommand("bg-tasks", {
		description: "Open the background task manager UI",
		handler: async (args, ctx) => {
			const taskId = args.trim() || undefined;
			await openTaskManager(ctx, taskId);
		},
	});

	pi.registerShortcut("shift+down" as any, {
		description: "Open background task manager",
		handler: async (ctx) => {
			await openTaskManager(ctx);
		},
	});

	pi.registerCommand("jobs", {
		description: "List running and recent background tasks",
		handler: async (_args, ctx) => {
			currentCtx = ctx;
			ctx.ui.notify(formatTaskList([...tasks.values()]), "info");
			updateUi(ctx);
		},
	});

	pi.registerCommand("logs", {
		description: "Show bounded output from a background task: /logs <id> [maxBytes]",
		getArgumentCompletions: (prefix) => {
			const matches = [...tasks.values()]
				.filter((task) => task.id.startsWith(prefix.trim()))
				.slice(0, 20)
				.map((task) => ({ value: task.id, label: task.id, description: `${task.status} — ${truncateChars(task.command, 60)}` }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			try {
				currentCtx = ctx;
				const [id, bytes] = args.trim().split(/\s+/, 2);
				const task = resolveTask(id || "");
				const maxBytes = normalizeMaxBytes(Number(bytes));
				const logs = await getTaskLogs(task, maxBytes, true);
				ctx.ui.notify(logs.text, "info");
			} catch (error) {
				ctx.ui.notify(`Background logs error: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.registerCommand("kill", {
		description: "Stop a running background task: /kill <id>",
		getArgumentCompletions: (prefix) => {
			const matches = [...tasks.values()]
				.filter((task) => task.status === "running" && task.id.startsWith(prefix.trim()))
				.slice(0, 20)
				.map((task) => ({ value: task.id, label: task.id, description: truncateChars(task.command, 70) }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			try {
				currentCtx = ctx;
				const task = resolveTask(args.trim());
				await stopTask(task, "user");
				ctx.ui.notify(`Killed ${task.id}. Output: ${task.outputPath}`, "info");
				updateUi(ctx);
			} catch (error) {
				ctx.ui.notify(`Background kill error: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	const BgRunParams = Type.Object({
		command: Type.String({ description: "Shell command to start in the background" }),
		description: Type.Optional(Type.String({ description: "Short human-readable task description" })),
		timeoutSeconds: Type.Optional(Type.Number({ description: "Optional timeout; task is failed and killed when exceeded" })),
		notifyOnCompletion: Type.Optional(Type.Boolean({ description: "Whether to show a completion notification. Default: true." })),
		triggerOnCompletion: Type.Optional(Type.Boolean({ description: "Whether completion should trigger a follow-up agent turn. Default: true for bg_run." })),
	});

	pi.registerTool<typeof BgRunParams, BgRunDetails>({
		name: "bg_run",
		label: "Background Run",
		description: `Start a long-running shell command in the background and return immediately with a task ID and output path. Output is written to .pi/tasks and model-visible logs are bounded to ${formatSize(MAX_LOG_BYTES)}.`,
		promptSnippet: "Start long-running shell commands in the background and return a task ID plus output file path",
		promptGuidelines: [
			"Use bg_run instead of bash for commands expected to run for a long time, such as test suites, dev servers, watchers, builds, or sleeps.",
			"After bg_run, use bg_status and bg_logs to inspect progress; do not assume the background task completed until status says completed, failed, or killed.",
			"When a <background-task-notification> appears, react to it: inspect bg_status/bg_logs as needed, then report completion, failure, or next steps to the user.",
		],
		parameters: BgRunParams,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = await startTask(ctx, params.command, {
				description: params.description,
				timeoutSeconds: params.timeoutSeconds,
				notifyOnCompletion: params.notifyOnCompletion ?? true,
				triggerOnCompletion: params.triggerOnCompletion ?? true,
			});
			return {
				content: textContent(`Started background task ${task.id}\nStatus: ${task.status}\nPID: ${task.pid ?? "unknown"}\nOutput: ${task.outputPath}`),
				details: { task: snapshot(task) },
			};
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("bg_run "))}${theme.fg("muted", truncateChars(args.description || args.command || "", 90))}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const task = result.details?.task;
			if (!task) return renderPlainResult(result, _options, theme);
			return new Text(`${theme.fg("success", "✓ started")} ${theme.fg("accent", task.id)}\n${theme.fg("dim", `Output: ${task.outputPath}`)}`, 0, 0);
		},
	});

	const BgStatusParams = Type.Object({
		taskId: Type.Optional(Type.String({ description: "Optional task ID or unambiguous prefix. If omitted, all running/recent tasks are returned." })),
	});

	pi.registerTool<typeof BgStatusParams, BgStatusDetails>({
		name: "bg_status",
		label: "Background Status",
		description: "Inspect one background task or list all running/recent background tasks.",
		promptSnippet: "Inspect status for one or all background tasks",
		promptGuidelines: ["Use bg_status before bg_logs when you need to know whether a background task is still running or has finished."],
		parameters: BgStatusParams,
		async execute(_toolCallId, params) {
			const selected = params.taskId ? [resolveTask(params.taskId)] : [...tasks.values()];
			const snapshots = selected.map(snapshot);
			return {
				content: textContent(formatSnapshotList(snapshots)),
				details: { tasks: snapshots },
			};
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("bg_status"))}${args.taskId ? ` ${theme.fg("accent", args.taskId)}` : ""}`, 0, 0);
		},
		renderResult: renderPlainResult,
	});

	const BgLogsParams = Type.Object({
		taskId: Type.String({ description: "Task ID or unambiguous prefix" }),
		maxBytes: Type.Optional(Type.Number({ description: `Maximum bytes to return, capped at ${formatSize(MAX_LOG_BYTES)}. Default: ${formatSize(DEFAULT_LOG_BYTES)}.` })),
		tail: Type.Optional(Type.Boolean({ description: "Read the tail of the log when true, head when false. Default: true." })),
	});

	pi.registerTool<typeof BgLogsParams, BgLogsDetails>({
		name: "bg_logs",
		label: "Background Logs",
		description: `Read bounded output from a background task. Output is capped at ${formatSize(MAX_LOG_BYTES)} for model safety and points to the full output file when truncated.`,
		promptSnippet: "Read bounded output from a background task log",
		promptGuidelines: ["Use bg_logs with a modest maxBytes value to inspect background task progress without flooding context."],
		parameters: BgLogsParams,
		async execute(_toolCallId, params) {
			const task = resolveTask(params.taskId);
			const logs = await getTaskLogs(task, normalizeMaxBytes(params.maxBytes), params.tail ?? true);
			return {
				content: textContent(logs.text),
				details: logs.details,
			};
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("bg_logs "))}${theme.fg("accent", args.taskId)}`, 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			const details = result.details;
			if (!details) return renderPlainResult(result, { expanded, isPartial: false }, theme);
			let text = `${theme.fg("accent", details.task.id)} ${theme.fg("muted", details.tail ? "tail" : "head")} ${formatSize(details.bytesRead)}`;
			if (details.truncated) text += theme.fg("warning", " (truncated)");
			text += `\n${theme.fg("dim", `Full output: ${details.path}`)}`;
			if (expanded) {
				const content = result.content?.[0];
				if (content?.type === "text") text += `\n${theme.fg("toolOutput", content.text.split("\n").slice(0, 30).join("\n"))}`;
			}
			return new Text(text, 0, 0);
		},
	});

	const BgKillParams = Type.Object({
		taskId: Type.String({ description: "Task ID or unambiguous prefix to stop" }),
	});

	pi.registerTool<typeof BgKillParams, BgKillDetails>({
		name: "bg_kill",
		label: "Background Kill",
		description: "Stop a running background task by ID. Fails loudly if the task is unknown or already finished.",
		promptSnippet: "Stop a running background task by ID",
		promptGuidelines: ["Use bg_kill when the user asks to stop a background task or when a bg_run command is no longer needed."],
		parameters: BgKillParams,
		async execute(_toolCallId, params) {
			const task = resolveTask(params.taskId);
			await stopTask(task, "user");
			const message = `Killed background task ${task.id}. Output: ${task.outputPath}`;
			return {
				content: textContent(message),
				details: { task: snapshot(task), message },
			};
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("bg_kill "))}${theme.fg("accent", args.taskId)}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const task = result.details?.task;
			if (!task) return renderPlainResult(result, _options, theme);
			return new Text(`${theme.fg("warning", "■ killed")} ${theme.fg("accent", task.id)}\n${theme.fg("dim", `Output: ${task.outputPath}`)}`, 0, 0);
		},
	});
}

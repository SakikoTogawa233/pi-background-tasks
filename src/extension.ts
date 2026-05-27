import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, statSync, type WriteStream } from "node:fs";
import { mkdir, open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, formatSize } from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import { BackgroundTasksManager, type StopAllResult, type TaskManagerResult } from "./ui/background-tasks-manager.js";
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

type TaskContextUsage = { tokens: number | null; contextWindow: number; percent: number | null };

type BgTaskSnapshot = {
	id: string;
	name: string;
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
	contextUsage?: TaskContextUsage;
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
	contextUsageBuffer?: string;
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

type StartTaskOptions = {
	name?: string;
	description?: string;
	timeoutSeconds?: number;
	notifyOnCompletion?: boolean;
	triggerOnCompletion?: boolean;
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

function compactWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function truncateChars(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function normalizeTaskName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = compactWhitespace(stripMatchingQuotes(value));
	if (!normalized) return undefined;
	return truncateChars(normalized, 80);
}

function deriveTaskNameFromCommand(command: string): string {
	const normalized = compactWhitespace(stripMatchingQuotes(command));
	if (!normalized) return "Background task";

	const packageScript = normalized.match(/^(npm|pnpm|yarn|bun)\s+(?:(run)\s+)?([^\s;&|]+)/);
	if (packageScript) {
		const runner = packageScript[1];
		const run = packageScript[2] ? " run" : "";
		const script = packageScript[3];
		return truncateChars(`${runner}${run} ${script}`, 48);
	}

	const words = normalized.split(/\s+/).slice(0, 5).join(" ");
	return truncateChars(words || normalized, 48);
}

function taskDisplayName(task: { name?: string; description?: string; command?: string; id?: string }): string {
	return normalizeTaskName(task.name) ?? normalizeTaskName(task.description) ?? (task.command ? deriveTaskNameFromCommand(task.command) : undefined) ?? task.id ?? "Background task";
}

function parseNameValueAndRest(valueAndRest: string): { value: string; rest: string } | undefined {
	const input = valueAndRest.trimStart();
	if (!input) return undefined;
	const quote = input[0];
	if (quote === '"' || quote === "'") {
		let escaped = false;
		let value = "";
		for (let i = 1; i < input.length; i++) {
			const char = input[i]!;
			if (escaped) {
				value += char;
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === quote) {
				return { value, rest: input.slice(i + 1).trimStart() };
			}
			value += char;
		}
		return undefined;
	}
	const match = input.match(/^(\S+)(?:\s+([\s\S]*))?$/);
	if (!match) return undefined;
	return { value: match[1]!, rest: match[2]?.trimStart() ?? "" };
}

function parseBgCommandArgs(args: string): { name?: string; command: string } {
	const input = args.trim();
	for (const prefix of ["--name=", "-n="]) {
		if (input.startsWith(prefix)) {
			const parsed = parseNameValueAndRest(input.slice(prefix.length));
			if (!parsed) throw new Error(`${prefix.slice(0, -1)} requires a task name`);
			return { name: normalizeTaskName(parsed.value), command: parsed.rest };
		}
	}
	for (const prefix of ["--name", "-n"]) {
		if (input === prefix || input.startsWith(`${prefix} `) || input.startsWith(`${prefix}\t`)) {
			const parsed = parseNameValueAndRest(input.slice(prefix.length));
			if (!parsed) throw new Error(`${prefix} requires a task name`);
			return { name: normalizeTaskName(parsed.value), command: parsed.rest };
		}
	}
	return { command: input };
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
		name: taskDisplayName(task),
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
		contextUsage: task.contextUsage,
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
	const label = taskDisplayName(task);
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
			const label = taskDisplayName(task);
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

export default function backgroundTasksExtension(pi: ExtensionAPI): void {
	const tasks = new Map<string, BgTask>();
	let runtimeDirAbs: string | undefined;
	let runtimeDirDisplay: string | undefined;
	let currentCtx: ExtensionContext | undefined;
	let dockOpen = false;
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

	function unseenFinishedTasks(): BgTask[] {
		return [...tasks.values()].filter((task) => task.status !== "running" && !seenTaskIds.has(task.id));
	}

	function clearFinishedNotices(ctx = currentCtx): number {
		const unseen = unseenFinishedTasks();
		for (const task of unseen) seenTaskIds.add(task.id);
		updateUi(ctx);
		return unseen.length;
	}

	function updateUi(ctx = currentCtx): void {
		if (shuttingDown || !ctx) return;
		try {
			if (!ctx.hasUI) return;
			const allTasks = [...tasks.values()];
			const running = allTasks.filter((task) => task.status === "running");
			const unseenFailed = allTasks.filter((task) => task.status === "failed" && !seenTaskIds.has(task.id));
			const unseenStopped = allTasks.filter((task) => task.status === "killed" && !seenTaskIds.has(task.id));
			const unseenDone = allTasks.filter((task) => task.status === "completed" && !seenTaskIds.has(task.id));
			const unseenFinishedCount = unseenFailed.length + unseenStopped.length + unseenDone.length;
			ctx.ui.setWidget("background-tasks", undefined);
			if (running.length === 0 && unseenFinishedCount === 0) {
				ctx.ui.setStatus("background-tasks", undefined);
				return;
			}

			const parts: string[] = [];
			if (running.length > 0) parts.push(`${running.length} running`);
			if (unseenFailed.length > 0) parts.push(`${unseenFailed.length} failed`);
			if (unseenStopped.length > 0) parts.push(`${unseenStopped.length} stopped`);
			if (unseenDone.length > 0) parts.push(`${unseenDone.length} done`);
			const entryHint = dockOpen ? "focused" : `Shift↓${unseenFinishedCount > 0 ? " · C clear" : ""}`;
			const label = ` bg ${parts.join(" · ")} · ${entryHint} `;
			ctx.ui.setStatus("background-tasks", lightBlue(label));
		} catch (error) {
			console.error(`[background-tasks] UI update failed: ${error instanceof Error ? error.message : String(error)}`);
			currentCtx = undefined;
		}
	}

	function normalizeContextUsage(value: unknown): TaskContextUsage | undefined {
		if (!value || typeof value !== "object") return undefined;
		const input = value as { tokens?: unknown; contextWindow?: unknown; percent?: unknown };
		const contextWindow = typeof input.contextWindow === "number" && Number.isFinite(input.contextWindow) && input.contextWindow > 0
			? Math.floor(input.contextWindow)
			: undefined;
		if (!contextWindow) return undefined;
		const tokens = input.tokens === null
			? null
			: typeof input.tokens === "number" && Number.isFinite(input.tokens) && input.tokens >= 0
				? Math.floor(input.tokens)
				: null;
		const percent = input.percent === null
			? null
			: typeof input.percent === "number" && Number.isFinite(input.percent) && input.percent >= 0
				? input.percent
				: tokens === null
					? null
					: (tokens / contextWindow) * 100;
		return { tokens, contextWindow, percent };
	}

	function parseContextUsageXml(xml: string): TaskContextUsage | undefined {
		const readNumber = (tag: string): number | null | undefined => {
			const match = xml.match(new RegExp(`<${tag}>(.*?)</${tag}>`, "i"));
			if (!match) return undefined;
			const raw = match[1]?.trim();
			if (raw === "null" || raw === "?") return null;
			const parsed = Number(raw);
			return Number.isFinite(parsed) ? parsed : undefined;
		};
		const tokens = readNumber("tokens");
		const contextWindow = readNumber("context-window") ?? readNumber("contextWindow");
		const percent = readNumber("percent");
		return normalizeContextUsage({ tokens, contextWindow, percent });
	}

	function ingestContextUsageTelemetry(task: BgTask, text: string): void {
		if (!text) return;
		task.contextUsageBuffer = `${task.contextUsageBuffer ?? ""}${text}`.slice(-16 * 1024);
		let latest: TaskContextUsage | undefined;
		for (const line of task.contextUsageBuffer.split(/\r?\n/)) {
			if (!line.includes("background-task-context-usage")) continue;
			const trimmed = line.trim();
			if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
				try {
					const parsed = JSON.parse(trimmed);
					if (parsed?.type === "background-task-context-usage") latest = normalizeContextUsage(parsed) ?? latest;
				} catch {
					// Ignore malformed optional telemetry; task output remains authoritative for debugging.
				}
			}
		}
		const xmlMatches = task.contextUsageBuffer.matchAll(/<background-task-context-usage>[\s\S]*?<\/background-task-context-usage>/gi);
		for (const match of xmlMatches) latest = parseContextUsageXml(match[0]) ?? latest;
		if (latest) {
			task.contextUsage = latest;
			updateUi();
			void writeMetadata(task).catch((error) => {
				console.error(`[background-tasks] failed to write context usage metadata for ${task.id}:`, error);
			});
		}
	}

	function appendToOutput(task: BgTask, data: Buffer | string): void {
		if (!task.stream || task.stream.destroyed) return;
		const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
		if (buffer.length === 0) return;
		ingestContextUsageTelemetry(task, buffer.toString("utf8"));

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
		const taskName = taskDisplayName(task);
		const content = [
			"<background-task-notification>",
			`  <task-id>${task.id}</task-id>`,
			`  <task-name>${escapeXml(taskName)}</task-name>`,
			`  <status>${task.status}</status>`,
			exit,
			error,
			`  <output-file>${escapeXml(task.outputPath)}</output-file>`,
			`  <summary>${escapeXml(`Background task ${JSON.stringify(taskName)} ${task.status}`)}</summary>`,
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
		options: StartTaskOptions = {},
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
		const taskName = normalizeTaskName(options.name) ?? normalizeTaskName(options.description) ?? deriveTaskNameFromCommand(normalizedCommand);

		const task: BgTask = {
			id,
			name: taskName,
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
		dockOpen = true;
		updateUi(ctx);
		try {
			await ctx.ui.custom<TaskManagerResult>(
				(tui, theme, _keybindings, done) =>
					new BackgroundTasksManager(tui, theme, done, {
						initialTaskId,
						getTasks: () => [...tasks.values()],
						stopTask: async (task) => {
							await stopTask(resolveTask(task.id), "user");
							updateUi(ctx);
						},
						stopAllRunning: async () => {
							const running = [...tasks.values()].filter((task) => task.status === "running");
							const failures: string[] = [];
							let stopped = 0;
							await Promise.all(
								running.map(async (task) => {
									try {
										await stopTask(task, "user");
										stopped++;
									} catch (error) {
										failures.push(`${taskDisplayName(task)} (${task.id}): ${error instanceof Error ? error.message : String(error)}`);
									}
								}),
							);
							updateUi(ctx);
							return { stopped, failures };
						},
						rerunTask: async (task) => {
							const rerun = await startTask(ctx, task.command, {
								name: taskDisplayName(task),
								description: task.description,
								timeoutSeconds: task.timeoutSeconds,
								notifyOnCompletion: true,
								triggerOnCompletion: false,
							});
							updateUi(ctx);
							return rerun;
						},
						showOutputPath: (task) => {
							ctx.ui.notify(`Output path for ${taskDisplayName(task)} (${task.id}):\n${task.outputPath}`, "info");
						},
						markSeen: (taskId) => {
							seenTaskIds.add(taskId);
							updateUi(ctx);
						},
						markFinishedSeen: (taskIds) => {
							for (const taskId of taskIds) seenTaskIds.add(taskId);
							updateUi(ctx);
						},
						isSeen: (taskId) => seenTaskIds.has(taskId),
					}),
				{
					overlay: true,
					overlayOptions: { anchor: "bottom-center", width: "96%", minWidth: 64, maxHeight: "60%", margin: { bottom: 1, left: 1, right: 1 } },
				},
			);
		} finally {
			dockOpen = false;
			updateUi(ctx);
		}
	}

	pi.registerMessageRenderer<BgTaskSnapshot>("background-task-notification", (message, _options, theme) => {
		const task = message.details;
		const status = task?.status ?? "completed";
		const color = status === "completed" ? "success" : status === "failed" ? "error" : status === "killed" ? "warning" : "accent";
		const id = task?.id ?? "background task";
		const name = task ? taskDisplayName(task) : "Background task";
		const output = task?.outputPath ? `\n${theme.fg("dim", `Output: ${task.outputPath}`)}` : "";
		const error = task?.error ? `\n${theme.fg("error", task.error)}` : "";
		return new Text(`${theme.fg(color as any, `[bg ${status}]`)} ${theme.fg("accent", name)} ${theme.fg("dim", `(${id})`)}${output}${error}`, 0, 0);
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
		description: "Start a shell command as a tracked background task: /bg [--name \"Task name\"] <command>",
		handler: async (args, ctx) => {
			try {
				const parsed = parseBgCommandArgs(args);
				const task = await startTask(ctx, parsed.command, { name: parsed.name, notifyOnCompletion: true, triggerOnCompletion: false });
				ctx.ui.notify(`Started ${taskDisplayName(task)} (${task.id})\nOutput: ${task.outputPath}\nCommand: ${task.command}`, "info");
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
		description: "Open focused background task footer dock",
		handler: async (ctx) => {
			await openTaskManager(ctx);
		},
	});

	pi.registerShortcut("shift+c" as any, {
		description: "Clear finished background task footer notices",
		handler: (ctx) => {
			currentCtx = ctx;
			const cleared = clearFinishedNotices(ctx);
			if (ctx.hasUI) {
				ctx.ui.notify(
					cleared > 0
						? `Cleared ${cleared} finished background task notice${cleared === 1 ? "" : "s"}.`
						: "No finished background task notices to clear.",
					cleared > 0 ? "info" : "warning",
				);
			}
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
				.map((task) => ({ value: task.id, label: `${task.id} ${taskDisplayName(task)}`, description: `${task.status} — ${truncateChars(task.command, 60)}` }));
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
				.map((task) => ({ value: task.id, label: `${task.id} ${taskDisplayName(task)}`, description: truncateChars(task.command, 70) }));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			try {
				currentCtx = ctx;
				const task = resolveTask(args.trim());
				await stopTask(task, "user");
				ctx.ui.notify(`Killed ${taskDisplayName(task)} (${task.id}). Output: ${task.outputPath}`, "info");
				updateUi(ctx);
			} catch (error) {
				ctx.ui.notify(`Background kill error: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	const BgRunParams = Type.Object({
		name: Type.String({ description: "Short human-readable task name shown in the bg footer dock. Required; use 2-6 words, not the raw command." }),
		command: Type.String({ description: "Shell command to start in the background" }),
		description: Type.Optional(Type.String({ description: "Optional longer human-readable context for the task" })),
		timeoutSeconds: Type.Optional(Type.Number({ description: "Optional timeout; task is failed and killed when exceeded" })),
		notifyOnCompletion: Type.Optional(Type.Boolean({ description: "Whether to show a completion notification. Default: true." })),
		triggerOnCompletion: Type.Optional(Type.Boolean({ description: "Whether completion should trigger a follow-up agent turn. Default: true for bg_run." })),
	});

	pi.registerTool<typeof BgRunParams, BgRunDetails>({
		name: "bg_run",
		label: "Background Run",
		description: `Start a named long-running shell command in the background and return immediately with a task ID and output path. Output is written to .pi/tasks and model-visible logs are bounded to ${formatSize(MAX_LOG_BYTES)}.`,
		promptSnippet: "Start named long-running shell commands in the background and return a task ID plus output file path",
		promptGuidelines: [
			"Use bg_run instead of bash for commands expected to run for a long time, such as test suites, dev servers, watchers, builds, or sleeps.",
			"When using bg_run, always set name to a concise 2-6 word human-readable label for the footer task dock; do not use the raw command as the name unless it is already short and meaningful.",
			"After bg_run, use bg_status and bg_logs to inspect progress; do not assume the background task completed until status says completed, failed, or killed.",
			"When a <background-task-notification> appears, react to it: inspect bg_status/bg_logs as needed, then report completion, failure, or next steps to the user.",
		],
		parameters: BgRunParams,
		prepareArguments(args) {
			const fallback = { name: "Background task", command: "" };
			if (!args || typeof args !== "object") return fallback;
			const input = args as { name?: unknown; command?: unknown; description?: unknown };
			if (normalizeTaskName(input.name) && typeof input.command === "string") return input as any;
			if (typeof input.command !== "string") return fallback;
			return {
				...input,
				name: normalizeTaskName(input.description) ?? deriveTaskNameFromCommand(input.command),
			};
		},
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const task = await startTask(ctx, params.command, {
				name: params.name,
				description: params.description,
				timeoutSeconds: params.timeoutSeconds,
				notifyOnCompletion: params.notifyOnCompletion ?? true,
				triggerOnCompletion: params.triggerOnCompletion ?? true,
			});
			return {
				content: textContent(`Started background task ${taskDisplayName(task)} (${task.id})\nStatus: ${task.status}\nPID: ${task.pid ?? "unknown"}\nOutput: ${task.outputPath}`),
				details: { task: snapshot(task) },
			};
		},
		renderCall(args, theme) {
			return new Text(`${theme.fg("toolTitle", theme.bold("bg_run "))}${theme.fg("muted", truncateChars(taskDisplayName(args), 90))}`, 0, 0);
		},
		renderResult(result, _options, theme) {
			const task = result.details?.task;
			if (!task) return renderPlainResult(result, _options, theme);
			return new Text(`${theme.fg("success", "✓ started")} ${theme.fg("accent", taskDisplayName(task))} ${theme.fg("dim", `(${task.id})`)}\n${theme.fg("dim", `Output: ${task.outputPath}`)}`, 0, 0);
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
			let text = `${theme.fg("accent", taskDisplayName(details.task))} ${theme.fg("dim", `(${details.task.id})`)} ${theme.fg("muted", details.tail ? "tail" : "head")} ${formatSize(details.bytesRead)}`;
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
			const message = `Killed background task ${taskDisplayName(task)} (${task.id}). Output: ${task.outputPath}`;
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
			return new Text(`${theme.fg("warning", "■ killed")} ${theme.fg("accent", taskDisplayName(task))} ${theme.fg("dim", `(${task.id})`)}\n${theme.fg("dim", `Output: ${task.outputPath}`)}`, 0, 0);
		},
	});
}

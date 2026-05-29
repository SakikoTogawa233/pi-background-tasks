import { statSync } from "node:fs";
import { open } from "node:fs/promises";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";

export type TaskStatus = "running" | "completed" | "failed" | "killed";
export type KillKind = "user" | "timeout" | "output_cap" | "shutdown";

export type TaskContextUsage = {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
};

export type TaskTokenUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	costTotal?: number;
};

export type TaskToolUsage = {
	total: number;
	failed: number;
	byName: Record<string, number>;
};

export type BgTaskSnapshot = {
	id: string;
	name?: string | undefined;
	command: string;
	description?: string | undefined;
	status: TaskStatus;
	outputPath: string;
	cwd: string;
	startTime: number;
	endTime?: number | undefined;
	exitCode?: number | null | undefined;
	signal?: string | null | undefined;
	pid?: number | undefined;
	bytesWritten: number;
	isAgent: boolean;
	error?: string | undefined;
	notified: boolean;
	notifyOnCompletion: boolean;
	triggerOnCompletion: boolean;
	timeoutSeconds?: number | undefined;
	contextUsage?: TaskContextUsage | undefined;
	tokenUsage?: TaskTokenUsage | undefined;
	toolUsage?: TaskToolUsage | undefined;
	model?: string | undefined;
};

export type BgTask = Omit<BgTaskSnapshot, "name"> & {
	name: string;
	outputAbsPath: string;
	metadataAbsPath: string;
	child?: import("./registry.js").BackgroundTaskChildProcess | undefined;
	stream?: import("node:fs").WriteStream | undefined;
	timeoutHandle?: NodeJS.Timeout | undefined;
	killKind?: KillKind | undefined;
	killSignalSent?: boolean | undefined;
	capExceeded?: boolean | undefined;
	finalized?: boolean | undefined;
	contextUsageBuffer?: string | undefined;
	waiters: Array<() => void>;
};

export type BgRunDetails = {
	task: BgTaskSnapshot;
};

export type BgStatusDetails = {
	tasks: BgTaskSnapshot[];
};

export type BgLogsDetails = {
	task: BgTaskSnapshot;
	path: string;
	bytesRead: number;
	truncated: boolean;
	tail: boolean;
};

export type BgKillDetails = {
	task: BgTaskSnapshot;
	message: string;
};

export type StartTaskOptions = {
	name?: string | undefined;
	description?: string | undefined;
	isAgent?: boolean | undefined;
	timeoutSeconds?: number | undefined;
	notifyOnCompletion?: boolean | undefined;
	triggerOnCompletion?: boolean | undefined;
};

export const DEFAULT_LOG_BYTES = Math.min(DEFAULT_MAX_BYTES, 50 * 1024);
export const MAX_LOG_BYTES = Math.min(DEFAULT_MAX_BYTES, 50 * 1024);
export const COMMAND_PREVIEW_CHARS = 90;

export function sanitizePathSegment(value: string): string {
	const sanitized = value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
	return sanitized || "session";
}

export function stripMatchingQuotes(value: string): string {
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

export function compactWhitespace(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

export function truncateChars(value: string, maxChars: number): string {
	if (value.length <= maxChars) return value;
	return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

export function normalizeTaskName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = compactWhitespace(stripMatchingQuotes(value));
	if (!normalized) return undefined;
	return truncateChars(normalized, 80);
}

export function deriveTaskNameFromCommand(command: string): string {
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

export function taskDisplayName(task: { name?: string | undefined; description?: string | undefined; command?: string | undefined; id?: string | undefined }): string {
	return normalizeTaskName(task.name)
		?? normalizeTaskName(task.description)
		?? (task.command ? deriveTaskNameFromCommand(task.command) : undefined)
		?? task.id
		?? "Background task";
}

function parseNameValueAndRest(valueAndRest: string): { value: string; rest: string } | undefined {
	const input = valueAndRest.trimStart();
	if (!input) return undefined;
	const quote = input[0];
	if (quote === '"' || quote === "'") {
		let escaped = false;
		let value = "";
		for (let i = 1; i < input.length; i++) {
			const char = input.charAt(i);
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
	const parsedValue = match[1];
	if (parsedValue === undefined) return undefined;
	return { value: parsedValue, rest: match[2]?.trimStart() ?? "" };
}

export function parseBgCommandArgs(args: string): { name?: string; command: string; isAgent: boolean } {
	let input = args.trim();
	let name: string | undefined;
	let isAgent = false;

	while (input) {
		let consumed = false;
		for (const prefix of ["--name=", "-n="]) {
			if (input.startsWith(prefix)) {
				const parsed = parseNameValueAndRest(input.slice(prefix.length));
				if (!parsed) throw new Error(`${prefix.slice(0, -1)} requires a task name`);
				name = normalizeTaskName(parsed.value);
				input = parsed.rest;
				consumed = true;
				break;
			}
		}
		if (consumed) continue;

		for (const prefix of ["--name", "-n"]) {
			if (input === prefix || input.startsWith(`${prefix} `) || input.startsWith(`${prefix}\t`)) {
				const parsed = parseNameValueAndRest(input.slice(prefix.length));
				if (!parsed) throw new Error(`${prefix} requires a task name`);
				name = normalizeTaskName(parsed.value);
				input = parsed.rest;
				consumed = true;
				break;
			}
		}
		if (consumed) continue;

		for (const flag of ["--agent", "--llm-agent"]) {
			if (input === flag || input.startsWith(`${flag} `) || input.startsWith(`${flag}\t`)) {
				isAgent = true;
				input = input.slice(flag.length).trimStart();
				consumed = true;
				break;
			}
		}
		if (consumed) continue;

		for (const flag of ["--script", "--no-agent"]) {
			if (input === flag || input.startsWith(`${flag} `) || input.startsWith(`${flag}\t`)) {
				isAgent = false;
				input = input.slice(flag.length).trimStart();
				consumed = true;
				break;
			}
		}
		if (consumed) continue;

		if (input === "--") {
			input = "";
			break;
		}
		if (input.startsWith("-- ")) {
			input = input.slice(3).trimStart();
			break;
		}
		break;
	}

	return name ? { name, command: input, isAgent } : { command: input, isAgent };
}

export function formatDuration(ms: number): string {
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

export function formatCompactNumber(count: number): string {
	const normalized = Math.max(0, Math.floor(count));
	if (normalized < 1000) return normalized.toString();
	if (normalized < 10000) return `${(normalized / 1000).toFixed(1)}k`;
	if (normalized < 1000000) return `${Math.round(normalized / 1000)}k`;
	if (normalized < 10000000) return `${(normalized / 1000000).toFixed(1)}M`;
	return `${Math.round(normalized / 1000000)}M`;
}

export function formatContextUsageSummary(usage?: TaskContextUsage): string | undefined {
	if (!usage || !usage.contextWindow) return undefined;
	const window = formatCompactNumber(usage.contextWindow);
	if (usage.percent === null || usage.tokens === null) return `ctx=?/${window}`;
	return `ctx=${usage.percent.toFixed(1)}%/${window}`;
}

export function formatTokenUsageSummary(usage?: TaskTokenUsage): string | undefined {
	if (!usage || usage.totalTokens <= 0) return undefined;
	return `tokens=${formatCompactNumber(usage.totalTokens)}`;
}

export function formatToolUsageSummary(usage?: TaskToolUsage): string | undefined {
	if (!usage || (usage.total <= 0 && usage.failed <= 0)) return undefined;
	const failed = usage.failed > 0 ? ` failed=${usage.failed}` : "";
	return `tools=${usage.total}${failed}`;
}

export function formatModelSummary(model?: string): string | undefined {
	if (!model) return undefined;
	return `model=${model}`;
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function shellInvocation(
	command: string,
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env,
): { shell: string; args: string[] } {
	if (platform === "win32") {
		return { shell: env["ComSpec"] || "cmd.exe", args: ["/d", "/s", "/c", command] };
	}
	return { shell: env["SHELL"] || "/bin/sh", args: ["-c", command] };
}

export function normalizeMaxBytes(value: unknown, fallback = DEFAULT_LOG_BYTES): number {
	const raw = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
	return Math.max(1, Math.min(MAX_LOG_BYTES, raw));
}

export function snapshot(task: BgTask): BgTaskSnapshot {
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
		isAgent: task.isAgent,
		error: task.error,
		notified: task.notified,
		notifyOnCompletion: task.notifyOnCompletion,
		triggerOnCompletion: task.triggerOnCompletion,
		timeoutSeconds: task.timeoutSeconds,
		contextUsage: task.contextUsage,
		tokenUsage: task.tokenUsage,
		toolUsage: task.toolUsage,
		model: task.model,
	};
}

export function formatSnapshotList(tasks: BgTaskSnapshot[], now = Date.now()): string {
	if (tasks.length === 0) return "No background tasks in this Pi extension runtime.";
	return tasks.map((task) => {
		const statusIcon = task.status === "running" ? "▶" : task.status === "completed" ? "✓" : task.status === "killed" ? "■" : "✗";
		const age = formatDuration((task.endTime ?? now) - task.startTime);
		const code = task.exitCode !== undefined ? ` exit=${task.exitCode}` : "";
		const pid = task.pid ? ` pid=${task.pid}` : "";
		const error = task.error ? ` error=${truncateChars(task.error, 80)}` : "";
		const telemetry = [
			formatContextUsageSummary(task.contextUsage),
			formatModelSummary(task.model),
			formatTokenUsageSummary(task.tokenUsage),
			formatToolUsageSummary(task.toolUsage),
		].filter(Boolean).join(" ");
		const telemetryText = telemetry ? ` ${telemetry}` : "";
		return `${statusIcon} ${task.id} ${task.status} ${age}${code}${pid}${telemetryText} — ${truncateChars(taskDisplayName(task), COMMAND_PREVIEW_CHARS)}${error}\n    output: ${task.outputPath}`;
	}).join("\n");
}

export async function boundedRead(
	filePath: string,
	maxBytes: number,
	tail: boolean,
): Promise<{ content: string; truncated: boolean; bytesRead: number; totalBytes: number }> {
	const stats = statSync(filePath);
	const totalBytes = stats.size;
	const bytesToRead = Math.min(totalBytes, maxBytes);
	if (bytesToRead === 0) return { content: "", truncated: false, bytesRead: 0, totalBytes };

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

export function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

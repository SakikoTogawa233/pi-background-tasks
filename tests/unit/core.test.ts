import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	boundedRead,
	deriveTaskNameFromCommand,
	formatCompactNumber,
	formatDuration,
	formatModelSummary,
	formatSnapshotList,
	normalizeMaxBytes,
	normalizeTaskName,
	parseBgCommandArgs,
	sanitizePathSegment,
	shellInvocation,
	taskDisplayName,
	truncateChars,
} from "../../src/core/common.js";

describe("core", () => {
	it("parses /bg names, aliases, equals forms, quotes, and empty commands", () => {
		assert.deepEqual(parseBgCommandArgs('--name "Build Docs" npm run docs'), { name: "Build Docs", command: "npm run docs", isAgent: false });
		assert.deepEqual(parseBgCommandArgs("--name=Build npm test"), { name: "Build", command: "npm test", isAgent: false });
		assert.deepEqual(parseBgCommandArgs("-n 'Quoted Name' printf ok"), { name: "Quoted Name", command: "printf ok", isAgent: false });
		assert.deepEqual(parseBgCommandArgs("-n=One printf one"), { name: "One", command: "printf one", isAgent: false });
		assert.deepEqual(parseBgCommandArgs("--agent --name Agent pi -p hi"), { name: "Agent", command: "pi -p hi", isAgent: true });
		assert.deepEqual(parseBgCommandArgs("--name Agent --script pi -p hi"), { name: "Agent", command: "pi -p hi", isAgent: false });
		assert.deepEqual(parseBgCommandArgs("echo ok"), { command: "echo ok", isAgent: false });
		assert.deepEqual(parseBgCommandArgs("--name 'Only Name'"), { name: "Only Name", command: "", isAgent: false });
		assert.throws(() => parseBgCommandArgs("--name"), /requires a task name/);
		assert.throws(() => parseBgCommandArgs('--name "unterminated'), /requires a task name/);
	});

	it("normalizes task names and derives stable fallbacks", () => {
		assert.equal(normalizeTaskName(' "A   B" '), "A B");
		assert.equal(normalizeTaskName("\n\t"), undefined);
		assert.equal(normalizeTaskName(123), undefined);
		assert.equal(normalizeTaskName("x".repeat(100)), `${"x".repeat(79)}…`);
		assert.equal(deriveTaskNameFromCommand("npm run test -- --watch"), "npm run test");
		assert.equal(deriveTaskNameFromCommand("pnpm build && echo done"), "pnpm build");
		assert.equal(deriveTaskNameFromCommand(""), "Background task");
		assert.equal(taskDisplayName({ description: "Longer description", command: "echo ok" }), "Longer description");
		assert.equal(taskDisplayName({ command: "echo one two three four five six" }), "echo one two three four");
		assert.equal(taskDisplayName({ id: "b123" }), "b123");
	});

	it("formats durations, paths, snapshots, and byte limits", () => {
		assert.equal(formatDuration(999), "999ms");
		assert.equal(formatDuration(1000), "1s");
		assert.equal(formatDuration(65_000), "1m5s");
		assert.equal(formatDuration(3_660_000), "1h1m");
		assert.equal(formatCompactNumber(999), "999");
		assert.equal(formatCompactNumber(1250), "1.3k");
		assert.equal(formatCompactNumber(42_000), "42k");
		assert.equal(sanitizePathSegment("a/b c"), "a-b-c");
		assert.equal(sanitizePathSegment("///"), "session");
		assert.ok(shellInvocation("echo ok").args.includes("echo ok"));
		assert.equal(normalizeMaxBytes(-1, 123), 1);
		assert.equal(normalizeMaxBytes(Number.NaN, 123), 123);
		assert.equal(normalizeMaxBytes(1.9, 123), 1);
		assert.equal(truncateChars("abcdef", 4), "abc…");

		const text = formatSnapshotList([
			{
				id: "b12345678",
				name: "Unit Task",
				command: "echo ok",
				status: "completed",
				outputPath: ".pi/tasks/run/b12345678.output",
				cwd: "/tmp",
				startTime: 1000,
				endTime: 2000,
				exitCode: 0,
				bytesWritten: 3,
				isAgent: true,
				notified: true,
				notifyOnCompletion: true,
				triggerOnCompletion: false,
				contextUsage: { tokens: 1250, contextWindow: 200_000, percent: 0.625 },
				tokenUsage: { input: 1000, output: 200, cacheRead: 30, cacheWrite: 20, totalTokens: 1250 },
				toolUsage: { total: 2, failed: 1, byName: { read: 1, bash: 1 } },
				model: "anthropic/claude-sonnet-4",
			},
			{ id: "b99999999", command: "bad", status: "failed", outputPath: ".pi/tasks/run/b99999999.output", cwd: "/tmp", startTime: 1000, endTime: 2000, exitCode: 1, bytesWritten: 0, isAgent: false, error: "x".repeat(100), notified: false, notifyOnCompletion: true, triggerOnCompletion: true },
		], 2000);
		assert.match(text, /Unit Task/);
		assert.match(text, /ctx=0\.6%\/200k/);
		assert.match(text, /model=anthropic\/claude-sonnet-4/);
		assert.match(text, /tokens=1\.3k/);
		assert.match(text, /tools=2 failed=1/);
		assert.match(text, /✗ b99999999 failed/);
		assert.match(text, /output: \.pi\/tasks/);
		assert.equal(formatModelSummary("anthropic/claude-sonnet-4"), "model=anthropic/claude-sonnet-4");
		assert.equal(formatModelSummary(undefined), undefined);
		assert.equal(formatModelSummary(""), undefined);
	});

	it("boundedRead supports head, tail, truncation, and empty files", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-bg-unit-"));
		try {
			const f = join(dir, "out");
			await writeFile(f, "abcdef");
			assert.deepEqual(await boundedRead(f, 3, true), { content: "def", truncated: true, bytesRead: 3, totalBytes: 6 });
			assert.deepEqual(await boundedRead(f, 3, false), { content: "abc", truncated: true, bytesRead: 3, totalBytes: 6 });
			assert.deepEqual(await boundedRead(f, 99, false), { content: "abcdef", truncated: false, bytesRead: 6, totalBytes: 6 });
			const empty = join(dir, "empty");
			await writeFile(empty, "");
			assert.deepEqual(await boundedRead(empty, 3, true), { content: "", truncated: false, bytesRead: 0, totalBytes: 0 });
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

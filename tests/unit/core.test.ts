import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
	boundedRead,
	deriveTaskNameFromCommand,
	formatDuration,
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
		assert.deepEqual(parseBgCommandArgs('--name "Build Docs" npm run docs'), { name: "Build Docs", command: "npm run docs" });
		assert.deepEqual(parseBgCommandArgs("--name=Build npm test"), { name: "Build", command: "npm test" });
		assert.deepEqual(parseBgCommandArgs("-n 'Quoted Name' printf ok"), { name: "Quoted Name", command: "printf ok" });
		assert.deepEqual(parseBgCommandArgs("-n=One printf one"), { name: "One", command: "printf one" });
		assert.deepEqual(parseBgCommandArgs("echo ok"), { command: "echo ok" });
		assert.deepEqual(parseBgCommandArgs("--name 'Only Name'"), { name: "Only Name", command: "" });
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
		assert.equal(sanitizePathSegment("a/b c"), "a-b-c");
		assert.equal(sanitizePathSegment("///"), "session");
		assert.ok(shellInvocation("echo ok").args.includes("echo ok"));
		assert.equal(normalizeMaxBytes(-1, 123), 1);
		assert.equal(normalizeMaxBytes(Number.NaN, 123), 123);
		assert.equal(normalizeMaxBytes(1.9, 123), 1);
		assert.equal(truncateChars("abcdef", 4), "abc…");

		const text = formatSnapshotList([
			{ id: "b12345678", name: "Unit Task", command: "echo ok", status: "completed", outputPath: ".pi/tasks/run/b12345678.output", cwd: "/tmp", startTime: 1000, endTime: 2000, exitCode: 0, bytesWritten: 3, notified: true, notifyOnCompletion: true, triggerOnCompletion: false },
			{ id: "b99999999", command: "bad", status: "failed", outputPath: ".pi/tasks/run/b99999999.output", cwd: "/tmp", startTime: 1000, endTime: 2000, exitCode: 1, bytesWritten: 0, error: "x".repeat(100), notified: false, notifyOnCompletion: true, triggerOnCompletion: true },
		], 2000);
		assert.match(text, /Unit Task/);
		assert.match(text, /✗ b99999999 failed/);
		assert.match(text, /output: \.pi\/tasks/);
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

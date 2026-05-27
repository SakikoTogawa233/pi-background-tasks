import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isolatedTestEnv, stripAnsi } from "../../src/testing/normalize.js";

const extensionPath = resolve("extensions/background-tasks.ts");

function tclQuote(value: string): string {
	return `{${value.replace(/}/g, "\\}")}}`;
}

async function runExpect(body: string, timeoutSeconds = 35): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-bg-pty-"));
	const cwd = join(root, "project");
	await mkdir(cwd, { recursive: true });
	const script = join(root, "scenario.expect");
	const content = `
set timeout ${timeoutSeconds}
set env(PI_OFFLINE) "${isolatedTestEnv.PI_OFFLINE}"
set env(PI_SKIP_VERSION_CHECK) "${isolatedTestEnv.PI_SKIP_VERSION_CHECK}"
set env(PI_TELEMETRY) "${isolatedTestEnv.PI_TELEMETRY}"
set env(CI) "${isolatedTestEnv.CI}"
set env(PI_CODING_AGENT_DIR) ${tclQuote(join(root, "agent"))}
set env(PI_CODING_AGENT_SESSION_DIR) ${tclQuote(join(root, "sessions"))}
set env(NPM_CONFIG_CACHE) "/tmp/pi-npm-cache"
set env(TERM) "xterm-256color"
spawn -noecho /usr/local/bin/pi --offline --no-session --no-extensions -e ${tclQuote(extensionPath)} --no-skills --no-prompt-templates --no-context-files --no-tools
expect {
  -re ">" {}
  timeout { puts "INITIAL_PROMPT_TIMEOUT"; exit 2 }
}
${body}
send "\\003"
after 500
exit 0
`;
	await writeFile(script, content, "utf8");
	try {
		const result = spawnSync("/usr/bin/expect", [script], { cwd, encoding: "utf8", timeout: (timeoutSeconds + 5) * 1000 });
		const output = `${result.stdout}\n${result.stderr}`;
		assert.equal(result.status, 0, stripAnsi(output));
		return stripAnsi(output).replace(/\r/g, "");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("interactive PTY", () => {
	it("opens the focused dock from /tasks and closes with x", { timeout: 45_000 }, async () => {
		const output = await runExpect(`
send "/tasks"
send "\\r"
expect {
  -re "bg tasks focused|No background tasks" {}
  timeout { puts "TASKS_DOCK_TIMEOUT"; exit 3 }
}
send "x"
`, 30);
		assert.match(output, /bg tasks focused|No background tasks/);
	});

	it("opens the footer dock via Shift+Down after starting a named task", { timeout: 55_000 }, async () => {
		const output = await runExpect(`
send {/bg --name "PTY Sleep" node -e "setTimeout(()=>{},4000)"}
send "\\r"
expect {
  -re "Started PTY Sleep" {}
  timeout { puts "BG_START_TIMEOUT"; exit 4 }
}
send "\\033\\[1;2B"
expect {
  -re "bg tasks focused(.|\n)*PTY Sleep" {}
  timeout { puts "SHIFT_DOWN_DOCK_TIMEOUT"; exit 5 }
}
send "x"
`, 40);
		assert.match(output, /PTY Sleep/);
		assert.match(output, /bg tasks focused/);
	});

	it("drives real dock detail, history, stop, and close keys", { timeout: 70_000 }, async () => {
		const output = await runExpect(`
send {/bg --name "PTY Action" node -e "let i=0; const t=setInterval(()=>{console.log('pty-action-'+(++i)); if(i===20) clearInterval(t)},100)"}
send "\\r"
expect {
  -re "Started PTY Action" {}
  timeout { puts "ACTION_START_TIMEOUT"; exit 6 }
}
send "\\033\\[1;2B"
expect {
  -re "bg tasks focused(.|\n)*PTY Action" {}
  timeout { puts "ACTION_DOCK_TIMEOUT"; exit 7 }
}
send "\\r"
expect {
  -re "bg: PTY Action|Output tail" {}
  timeout { puts "ACTION_DETAIL_TIMEOUT"; exit 8 }
}
send "r"
after 300
send "\\033\\[D"
expect {
  -re "bg tasks focused" {}
  timeout { puts "ACTION_BACK_TIMEOUT"; exit 9 }
}
send "h"
expect {
  -re "history|active" {}
  timeout { puts "ACTION_HISTORY_TIMEOUT"; exit 10 }
}
send "k"
expect {
  -re "Stopping|Stopped|stopped" {}
  timeout { puts "ACTION_STOP_TIMEOUT"; exit 11 }
}
send "x"
`, 55);
		assert.match(output, /PTY Action/);
		assert.match(output, /bg tasks focused/);
		assert.match(output, /bg: PTY Action|Output tail/);
	});
});

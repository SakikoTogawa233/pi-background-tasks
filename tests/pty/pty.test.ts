import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PTY_SKIP_REASON, ptyInputSupported, runExpect } from '../helpers/pty-harness.js';


void describe('interactive PTY', () => {
  void it(
    'opens the focused dock from /tasks and closes with x',
    { timeout: 45_000 },
    async (t) => {
      if (!(await ptyInputSupported())) {
        t.skip(PTY_SKIP_REASON);
        return;
      }
      const output = await runExpect(
        `
send "/tasks"
send "\\r"
expect {
  -re "bg tasks focused|No background tasks" {}
  timeout { puts "TASKS_DOCK_TIMEOUT"; exit 3 }
}
send "x"
`,
        30,
      );
      assert.match(output, /bg tasks focused|No background tasks/);
    },
  );

  void it(
    'opens the footer dock via Shift+Down after starting a named task',
    { timeout: 55_000 },
    async (t) => {
      if (!(await ptyInputSupported())) {
        t.skip(PTY_SKIP_REASON);
        return;
      }
      const output = await runExpect(
        `
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
`,
        40,
      );
      assert.match(output, /PTY Sleep/);
      assert.match(output, /bg tasks focused/);
    },
  );

  void it(
    'drives real dock detail, history, stop, and close keys',
    { timeout: 70_000 },
    async (t) => {
      if (!(await ptyInputSupported())) {
        t.skip(PTY_SKIP_REASON);
        return;
      }
      const output = await runExpect(
        `
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
`,
        55,
      );
      assert.match(output, /PTY Action/);
      assert.match(output, /bg tasks focused/);
      assert.match(output, /bg: PTY Action|Output tail/);
    },
  );

  void it(
    'scrolls the detail output tail with real arrow/page keys',
    { timeout: 60_000 },
    async (t) => {
      if (!(await ptyInputSupported())) {
        t.skip(PTY_SKIP_REASON);
        return;
      }
      const output = await runExpect(
        `
send {/bg --name "PTY Scroll" node -e "for(let i=1;i<=60;i++)console.log('PTYSCROLL-'+i)"}
send "\\r"
expect {
  -re "Started PTY Scroll" {}
  timeout { puts "SCROLL_START_TIMEOUT"; exit 33 }
}
after 600
send "\\033\\[1;2B"
expect {
  -re "bg tasks focused" {}
  timeout { puts "SCROLL_DOCK_TIMEOUT"; exit 34 }
}
send "\\r"
expect {
  -re "bg: PTY Scroll" {}
  timeout { puts "SCROLL_DETAIL_TIMEOUT"; exit 35 }
}
after 700
send "\\033\\[A"
send "\\033\\[A"
send "\\033\\[A"
expect {
  -re {of 60} {}
  timeout { puts "SCROLL_INDICATOR_TIMEOUT"; exit 36 }
}
send "x"
`,
        45,
        { rows: 80, cols: 120 },
      );
      assert.match(output, /PTY Scroll/);
      assert.match(output, /lines [0-9]+.*of 60/);
    },
  );

  void it(
    'covers secondary dock keys for selection, output path, rerun, and stop-all',
    { timeout: 80_000 },
    async (t) => {
      if (!(await ptyInputSupported())) {
        t.skip(PTY_SKIP_REASON);
        return;
      }
      const output = await runExpect(
        `
send {/bg --name "PTY Alpha" node -e "setInterval(()=>console.log('alpha'),200)"}
send "\\r"
expect {
  -re "Started PTY Alpha" {}
  timeout { puts "SECONDARY_ALPHA_TIMEOUT"; exit 12 }
}
send {/bg --name "PTY Beta" node -e "setInterval(()=>console.log('beta'),200)"}
send "\\r"
expect {
  -re "Started PTY Beta" {}
  timeout { puts "SECONDARY_BETA_TIMEOUT"; exit 13 }
}
send "\\033\\[1;2B"
expect {
  -re "bg tasks focused(.|\n)*PTY Beta(.|\n)*PTY Alpha|bg tasks focused(.|\n)*PTY Alpha(.|\n)*PTY Beta" {}
  timeout { puts "SECONDARY_DOCK_TIMEOUT"; exit 14 }
}
send "c"
expect {
  -re "Output path shown for PTY Beta|Output path for PTY Beta" {}
  timeout { puts "SECONDARY_PATH_BETA_TIMEOUT"; exit 15 }
}
send "\\033\\[B"
expect {
  -re "PTY Alpha" {}
  timeout { puts "SECONDARY_DOWN_TIMEOUT"; exit 16 }
}
send "c"
expect {
  -re "Output path shown for PTY Alpha|Output path for PTY Alpha" {}
  timeout { puts "SECONDARY_PATH_ALPHA_TIMEOUT"; exit 17 }
}
send "\\033\\[A"
expect {
  -re "PTY Beta" {}
  timeout { puts "SECONDARY_UP_TIMEOUT"; exit 18 }
}
send "R"
expect {
  -re "Reran as PTY Beta|Rerunning PTY Beta" {}
  timeout { puts "SECONDARY_RERUN_TIMEOUT"; exit 19 }
}
send "a"
expect {
  -re "Press a/K again to stop all" {}
  timeout { puts "SECONDARY_STOP_ALL_ARM_TIMEOUT"; exit 20 }
}
send "K"
expect {
  -re {Stopped [0-9]+ running task} {}
  timeout { puts "SECONDARY_STOP_ALL_TIMEOUT"; exit 21 }
}
send "x"
`,
        65,
      );
      assert.match(output, /PTY Alpha/);
      assert.match(output, /PTY Beta/);
      assert.match(output, /Output path shown for PTY/);
      assert.match(output, /Reran as PTY Beta|Rerunning PTY Beta/);
      assert.match(output, /Stopped [0-9]+ running task/);
    },
  );

  void it(
    'reruns completed, failed, and killed history tasks in a real dock',
    { timeout: 70_000 },
    async (t) => {
      if (!(await ptyInputSupported())) {
        t.skip(PTY_SKIP_REASON);
        return;
      }
      const output = await runExpect(
        `
send {/bg --name "PTY Done Rerun" printf done-rerun}
send "\\r"
expect {
  -re "Started PTY Done Rerun" {}
  timeout { puts "RERUN_COMPLETE_START_TIMEOUT"; exit 22 }
}
after 400
send "\\033\\[1;2B"
expect {
  -re "bg tasks focused" {}
  timeout { puts "RERUN_COMPLETE_DOCK_TIMEOUT"; exit 23 }
}
send "R"
expect {
  -re "Reran as PTY Done Rerun|Rerunning PTY Done Rerun" {}
  timeout { puts "RERUN_COMPLETE_ACTION_TIMEOUT"; exit 24 }
}
send "x"
after 200
send {/bg --name "PTY Stop Rerun" sleep 20}
send "\\r"
expect {
  -re "Started PTY Stop Rerun" {}
  timeout { puts "RERUN_KILLED_START_TIMEOUT"; exit 25 }
}
send "\\033\\[1;2B"
expect {
  -re "bg tasks focused" {}
  timeout { puts "RERUN_KILLED_DOCK_TIMEOUT"; exit 26 }
}
send "k"
expect {
  -re "Stopping|Stopped|stopped" {}
  timeout { puts "RERUN_KILLED_STOP_TIMEOUT"; exit 27 }
}
send "R"
expect {
  -re "Reran as PTY Stop Rerun|Rerunning PTY Stop Rerun" {}
  timeout { puts "RERUN_KILLED_ACTION_TIMEOUT"; exit 28 }
}
send "k"
expect {
  -re "Stopping|Stopped|stopped" {}
  timeout { puts "RERUN_KILLED_RERUN_STOP_TIMEOUT"; exit 29 }
}
send "x"
after 200
send {/bg --name "PTY Bad Rerun" node -e "process.exit(5)"}
send "\\r"
expect {
  -re "Started PTY Bad Rerun" {}
  timeout { puts "RERUN_FAILED_START_TIMEOUT"; exit 30 }
}
after 500
send "\\033\\[1;2B"
expect {
  -re "bg tasks focused" {}
  timeout { puts "RERUN_FAILED_DOCK_TIMEOUT"; exit 31 }
}
send "R"
expect {
  -re "Reran as PTY Bad Rerun|Rerunning PTY Bad Rerun" {}
  timeout { puts "RERUN_FAILED_ACTION_TIMEOUT"; exit 32 }
}
send "x"
`,
        55,
      );
      assert.match(output, /Reran as PTY Done Rerun|Rerunning PTY Done Rerun/);
      assert.match(output, /Reran as PTY Bad Rerun|Rerunning PTY Bad Rerun/);
      assert.match(output, /Reran as PTY Stop Rerun|Rerunning PTY Stop Rerun/);
    },
  );

  void it(
    'covers /bg-tasks history, failed unread badges, and page keys',
    { timeout: 200_000 },
    async (t) => {
      if (!(await ptyInputSupported())) {
        t.skip(PTY_SKIP_REASON);
        return;
      }
      const output = await runExpect(
        `
set send_slow {1 .004}
for {set i 1} {$i <= 16} {incr i} {
  send -s "/bg --name \\"PTY Page $i\\" printf page-$i"
  send "\\r"
  expect {
    -re "Started PTY Page $i" {}
    timeout { puts "PAGE_START_TIMEOUT_$i"; exit 22 }
  }
  after 80
}
send {/bg --name "PTY Fails" node -e "process.exit(4)"}
send "\\r"
expect {
  -re "Started PTY Fails" {}
  timeout { puts "PAGE_FAIL_START_TIMEOUT"; exit 23 }
}
after 700
send "/bg-tasks"
send "\\r"
expect {
  -re "bg tasks focused(.|\n)*(failed|unread)(.|\n)*PTY Fails" {}
  timeout { puts "PAGE_DOCK_TIMEOUT"; exit 24 }
}
send "\\033\\[6~"
after 300
send "\\033\\[5~"
after 300
send "x"
`,
        170,
      );
      assert.match(output, /PTY Fails/);
      assert.match(output, /failed|unread/);
      assert.match(output, /PTY Page/);
    },
  );
});

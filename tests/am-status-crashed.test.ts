// `am status` on an app whose last run crashed said plain "stopped" — the same
// word as a clean stop; the crash was only in `am logs`. Now a stopped app
// whose framework log has no clean-shutdown summary after its last start
// reads "stopped — crashed" (JSON: `crashed: true` + `lastError`, additive;
// `status` stays "stopped", exit 1 as before).
import "./store-sandbox.ts";
import { assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { crashOfLog } from "../src/am/am-cmd-status.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const T = "2026-10-24 05:20:43.913+02:00";
const STARTED = `${T}  INFO   app         started  cells=hc port=4000`;
const STOPPED =
  `${T}  INFO   app         stopped  uptime=207ms dispatched=2 errors=0`;
const CRASH =
  `${T}  ERROR  crash       [crash-handler] unhandledrejection: boom  stack=Error: boom\\n    at x`;

Deno.test("crashOfLog: clean stop, crash, kill, and a tail that cannot tell", () => {
  assertEquals(crashOfLog([STARTED, STOPPED].join("\n")), null);
  // A line written after the summary does not turn a clean stop into a crash.
  assertEquals(
    crashOfLog([STARTED, STOPPED, `${T}  WARN   aio  late`].join("\n")),
    null,
  );
  assertEquals(
    crashOfLog([STARTED, CRASH].join("\n")),
    "crash [crash-handler] unhandledrejection: boom",
  );
  // A crash in a later run, after an earlier clean one.
  assertEquals(
    crashOfLog([STARTED, STOPPED, STARTED, CRASH].join("\n")),
    "crash [crash-handler] unhandledrejection: boom",
  );
  // Killed: started, never a summary, no error.
  assertEquals(
    crashOfLog([STARTED, `${T}  INFO   cell:hc  ready`].join("\n")),
    "no shutdown line — the process ended without one",
  );
  // A boot that was refused writes its summary with no `started`: not a crash.
  assertEquals(crashOfLog(`${T}  ERROR  boot  refused\n${STOPPED}`), null);
  assertEquals(crashOfLog(`${T}  INFO   aio  something`), null);
  assertEquals(crashOfLog(""), null);
});

Deno.test("am status: a stopped app whose last run crashed says so", async () => {
  const root = await tempDir("aio-am-crashed-");
  try {
    const appId = "am-status-crash-probe";
    const logs = join(root, appId, "logs");
    await Deno.mkdir(logs, { recursive: true });
    await Deno.writeTextFile(join(logs, "app.log"), `${STARTED}\n${CRASH}\n`);
    const run = (args: string[]) =>
      new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          fromFileUrl(new URL("../src/am.ts", import.meta.url)),
          "status",
          `--app=${appId}`,
          ...args,
        ],
        env: { AIO_APPS_DIR: root, NO_COLOR: "1" },
        stdout: "piped",
        stderr: "piped",
      }).output();
    const json = await run(["--json"]);
    assertEquals(json.code, 1);
    const row = JSON.parse(new TextDecoder().decode(json.stdout).trim());
    assertEquals(row.status, "stopped");
    assertEquals(row.crashed, true);
    assertEquals(
      row.lastError,
      "crash [crash-handler] unhandledrejection: boom",
    );
    // A clean stop: no `crashed` key at all.
    await Deno.writeTextFile(join(logs, "app.log"), `${STARTED}\n${STOPPED}\n`);
    const clean = JSON.parse(
      new TextDecoder().decode((await run(["--json"])).stdout).trim(),
    );
    assertEquals(clean.crashed, undefined);
  } finally {
    await dropTempDir(root);
  }
});

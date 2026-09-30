// No credential lands in a log FILE.
//
// The `--expose` banner prints the share link (`?token=<the app key>`) and the
// one-shot pair code for the operator to copy. The terminal needs them whole;
// app.log (and debug.log) kept them too, forever, in a file that is copied
// into bug reports and backups — 0600 bounded who could read it, not where it
// went. Browser/renderer lines forwarded to client.log carried the page URL,
// `?token=` included. Every file sink now masks them; the console does not.
import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { AioLogger } from "../src/diagnostics/logger-core.ts";
import {
  disposeClientLog,
  flushClientLog,
  initClientLog,
  writeClientLog,
} from "../src/server/client-log.ts";

const KEY = "Zk3y-THE-APP-KEY-9f2a";
const PIN = "482913";
/** A credential reaching the line through `data`, not `msg`. The console sink
 *  redacted `msg` only, so this one was written through in cleartext. */
const DATA_KEY = "DATA-KEY-7q2x";

Deno.test("log files: the share-link token and the pair code are masked on disk", async () => {
  const dir = await tempDir("aio-log-mask-");
  const logger = new AioLogger({ dir, level: "debug", console: false });
  try {
    await logger.init();
    logger.pub("info", "aio", `share: https://10.0.0.5:8443?token=${KEY}`);
    logger.pub("info", "aio", `share (ann/admin): https://h:1?token=${KEY}`);
    logger.pub(
      "info",
      "aio",
      `pair code: ${PIN}  (enter it in the aio client)`,
    );
    await logger.flush();
    for (const kind of ["app", "debug"] as const) {
      const text = await Deno.readTextFile(logger.path(kind));
      assert(!text.includes(KEY), `${kind}.log holds the app key:\n${text}`);
      assert(!text.includes(PIN), `${kind}.log holds the pair code:\n${text}`);
      assertStringIncludes(text, "share: https://10.0.0.5:8443?token=…");
    }
  } finally {
    logger.onStop();
    await logger.flush();
    await dropTempDir(dir);
  }
});

// `am start` sends the app's stdout into `logs/stdout.log` — there the console
// IS a log file. It says so through the env; a terminal (or a test harness
// reading the pipe) still gets the link whole.
Deno.test("console: masked only when am says stdout is a log file", async () => {
  const printer =
    new URL("../src/diagnostics/logger-format.ts", import.meta.url)
      .href;
  const code = `import { printConsole } from "${printer}";
printConsole({ ts: "t", lvl: "info", cat: "aio", msg: "share: https://h:1?token=${KEY}" });
printConsole({ ts: "t", lvl: "info", cat: "aio", msg: "pair code: ${PIN}" });
printConsole({ ts: "t", lvl: "info", cat: "aio", msg: "detail", data: { url: "share: https://h:2?token=${DATA_KEY}" } });`;
  const run = async (env: Record<string, string>) =>
    new TextDecoder().decode(
      (await new Deno.Command(Deno.execPath(), {
        args: ["eval", "--ext=ts", code],
        env: { NO_COLOR: "1", ...env },
        stdout: "piped",
        stderr: "piped",
      }).output()).stdout,
    );
  const captured = await run({ AIO_STDOUT_IS_LOG: "1" });
  assert(!captured.includes(KEY) && !captured.includes(PIN), captured);
  assert(
    !captured.includes(DATA_KEY),
    `a token in \`data\` reached the log file in cleartext:\n${captured}`,
  );
  assertStringIncludes(captured, "?token=…");
  const terminal = await run({});
  assertStringIncludes(terminal, `?token=${KEY}`);
  assertStringIncludes(terminal, `pair code: ${PIN}`);
  // The terminal is the one place the link stays whole — including via data.
  assertStringIncludes(terminal, DATA_KEY);
  const am = await Deno.readTextFile(
    new URL("../src/am/am-cmd-process.ts", import.meta.url),
  );
  assertStringIncludes(am, `[STDOUT_IS_LOG_ENV]: "1"`);
});

Deno.test("client log: a forwarded ?token= URL is masked on disk", async () => {
  const dir = await tempDir("aio-clientlog-mask-");
  try {
    initClientLog(dir);
    writeClientLog(
      0,
      {
        ts: Date.now(),
        level: "info",
        msg: `page loaded: https://h:1/?token=${KEY}`,
      } as Parameters<typeof writeClientLog>[1],
    );
    await flushClientLog();
    const text = await Deno.readTextFile(join(dir, "client.log"));
    assert(!text.includes(KEY), `client.log holds the app key:\n${text}`);
    assertStringIncludes(text, "?token=…");
  } finally {
    disposeClientLog();
    await dropTempDir(dir);
  }
});

// An error, a fix, the same break again: the second throw is identical to the
// first, and error.log's repeat suppression counted it as "repeated" instead
// of writing it — so `am errors --since=reload` (by timestamp) listed nothing
// under the reload that broke it. A hot reload starts a new log generation.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  createFileWatcher,
  DEBOUNCE_MS,
} from "../src/server/server-watcher.ts";
import { AioLogger, closeLogger } from "../src/diagnostics/logger-core.ts";
import {
  installAppLogger,
  releaseAppLogger,
} from "../src/diagnostics/logger-api.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const settle = () => new Promise((r) => setTimeout(r, DEBOUNCE_MS + 400));

Deno.test("a hot reload resets error.log's repeat memo: the same error after it is a new line", async () => {
  const tmp = await tempDir("aio-reload-log-gen-");
  const dir = join(tmp, "logs");
  const logger = new AioLogger({ dir, console: false, heartbeat: 0 });
  await logger.init();
  installAppLogger(logger);
  const sent: string[] = [];
  const reloads: string[] = [];
  const w = createFileWatcher({
    absBaseDir: tmp,
    importMapObj: {},
    debug: () => {},
    broadcastWs: (m) => sent.push(m),
    onReload: (s) => reloads.push(s),
    graphTimeoutMs: 0,
  });
  const o = { log: console.log, info: console.info, warn: console.warn };
  console.log = console.info = console.warn = () => {};
  try {
    const css = join(tmp, "style.css");
    logger.pub("error", "air", "TypeError: x is undefined");
    await Deno.writeTextFile(css, "a{}"); // appearing: a reload
    w.scheduleReload(css);
    await settle();
    await Deno.writeTextFile(css, "b{}"); // an edit: a restyle, no new code
    w.scheduleReload(css);
    await settle();
    logger.pub("error", "air", "TypeError: x is undefined");
    logger.pub("error", "air", "TypeError: x is undefined");
    await logger.flush(500);
    assertEquals(reloads, ["reload", "css"]);
    const lines = (await Deno.readTextFile(join(dir, "error.log")))
      .split("\n").filter((l) => l.includes("x is undefined"));
    // Once before the reload, once after it — the second after it is still
    // a repeat (and a restyle is not a new generation).
    assertEquals(lines.length, 2, lines.join("\n"));
  } finally {
    Object.assign(console, o);
    w.shutdown();
    releaseAppLogger(logger);
    await logger.flush(500);
    closeLogger(logger);
    await dropTempDir(tmp);
  }
});

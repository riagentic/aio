// amui's Start sends the app's stdout into the project-local
// `.aio-amui-start.log` — there the console IS a log file. `am start` says so
// to the child (`AIO_STDOUT_IS_LOG`), which is what masks an `--expose`
// banner's share-link token and pair code; amui's launch did not, so the app
// key was written to that file in clear.
//
// The fixture prints the banner's two lines through the framework's own
// console printer (the masking decider) instead of really binding 0.0.0.0.
import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  logLinesOf,
  startApp,
  startLogPath,
} from "../amui/src/server/proc.server.ts";
import { childSaid } from "../src/am/am-cmd-process.ts";
import { isProcessAlive } from "../src/server/single-instance-lock.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";

const KEY = "k3yK3yk3yK3yk3yK3yk3yK3y";
const PIN = "482913";

Deno.test("amui start: an --expose banner's token is masked in the start log", async () => {
  const dir = await tempDir("amui-start-mask-");
  const printer =
    new URL("../src/diagnostics/logger-format.ts", import.meta.url)
      .href;
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ name: "exposed", entry: "app.ts" }),
  );
  await Deno.writeTextFile(
    join(dir, "app.ts"),
    `import { printConsole } from "${spec(printer)}";
printConsole({ ts: "t", lvl: "info", cat: "aio", msg: "share: https://h:1?token=${KEY}" });
printConsole({ ts: "t", lvl: "info", cat: "aio", msg: "pair code: ${PIN}" });
`,
  );
  try {
    const r = await startApp(dir, "server-only");
    assert(r.ok && r.pid, `start failed: ${r.error}`);
    // The fixture prints and exits; its output is complete once it is gone.
    const deadline = Date.now() + 60_000;
    while (isProcessAlive(r.pid) && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 100));
    }
    const text = logLinesOf(childSaid(startLogPath(dir)).text).join("\n");
    assertStringIncludes(text, "?token=…");
    assert(!text.includes(KEY), `the start log holds the app key:\n${text}`);
    assert(!text.includes(PIN), `the start log holds the pair code:\n${text}`);
  } finally {
    await dropTempDir(dir);
  }
});

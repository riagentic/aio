// amui's Start hands the entry the command word its `dev` task gives it
// (`serve`), as `am start` does. The `cli` scaffold routes on `Deno.args[0]`:
// launched bare it exits "missing command — run `<app> --help`", so Start on
// a cli app never came up.
import "./store-sandbox.ts";
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

Deno.test("amui start: the dev task's command word reaches the entry", async () => {
  const dir = await tempDir("amui-start-word-");
  await Deno.mkdir(join(dir, "src"));
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      title: "wordy",
      tasks: { dev: "deno run -A src/app.ts serve" },
    }),
  );
  await Deno.writeTextFile(
    join(dir, "src", "app.ts"),
    `console.log("argv0=" + Deno.args[0]);\n`,
  );
  try {
    const r = await startApp(dir, "cli");
    assert(r.ok && r.pid, `start failed: ${r.error}`);
    const deadline = Date.now() + 60_000;
    while (isProcessAlive(r.pid) && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 100));
    }
    const text = logLinesOf(childSaid(startLogPath(dir)).text).join("\n");
    assertStringIncludes(text, "argv0=serve");
  } finally {
    await dropTempDir(dir);
  }
});

// A process that exits right after a line kept it only on the console: the
// file sink writes on an unref'd 250 ms timer, and `Deno.exit()` ends the
// process first. Measured on real update rollbacks — `app.log` missed "boot
// attempt 2/2" and both rollback lines, and a macOS boot that exited never
// created it at all. Child processes, because the failure is the exit.
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const CORE = new URL("../src/diagnostics/logger-core.ts", import.meta.url).href;
const CONFIG = fromFileUrl(new URL("../deno.json", import.meta.url));

async function run(body: string): Promise<string | null> {
  const dir = await tempDir("aio-log-exit-");
  try {
    const logs = join(dir, "logs");
    const script = join(dir, "s.ts");
    await Deno.writeTextFile(
      script,
      `import { AioLogger } from ${JSON.stringify(CORE)};
const l = new AioLogger({ dir: ${
        JSON.stringify(logs)
      }, heartbeat: 0, console: false });
${body}
`,
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", CONFIG, script],
      stdout: "null",
      stderr: "piped",
    }).output();
    assertEquals(out.code, 3, new TextDecoder().decode(out.stderr));
    try {
      return await Deno.readTextFile(join(logs, "app.log"));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return null;
      throw e;
    }
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("logger: a line logged right before Deno.exit() reaches app.log", async () => {
  const log = await run(
    `await l.init();
l.pub("error", "updates", "rolling back to 2.0.0");
Deno.exit(3);`,
  );
  assert(log?.includes("rolling back to 2.0.0"), `app.log: ${log}`);
});

Deno.test("logger: a line held before init() finished reaches app.log at exit", async () => {
  const log = await run(
    `void l.init();
l.pub("error", "updates", "exited mid-init");
Deno.exit(3);`,
  );
  assert(log?.includes("exited mid-init"), `app.log: ${log}`);
});

Deno.test("logger: a logger never initialised writes nothing at exit (--help)", async () => {
  const log = await run(`l.pub("info", "app", "early"); Deno.exit(3);`);
  assertEquals(log, null);
});

Deno.test("logger: a log directory removed under a running logger is recreated at exit — its last lines land in app.log", async () => {
  const dir = await tempDir("aio-log-exit-");
  try {
    const logs = join(dir, "logs");
    const script = join(dir, "s.ts");
    await Deno.writeTextFile(
      script,
      `import { AioLogger } from ${JSON.stringify(CORE)};
const l = new AioLogger({ dir: ${
        JSON.stringify(logs)
      }, heartbeat: 0, console: false });
await l.init();
await l.flush();
Deno.removeSync(${JSON.stringify(logs)}, { recursive: true });
l.pub("error", "updates", "after the sandbox went");
Deno.exit(3);
`,
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", CONFIG, script],
      stdout: "null",
      stderr: "piped",
    }).output();
    const err = new TextDecoder().decode(out.stderr);
    assertEquals(out.code, 3, err);
    const log = await Deno.readTextFile(join(logs, "app.log"));
    assert(log.includes("after the sandbox went"), log);
    assert(!err.includes("could not reach"), `stderr: ${err}`);
  } finally {
    await dropTempDir(dir);
  }
});

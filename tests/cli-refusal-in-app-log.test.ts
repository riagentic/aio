// A command-line refusal reaches app.log when the app's logs folder exists
// (R9-hw: a packaged app double-clicked with a bad argument — a stale
// shortcut, a file association — exits before any logger, and its reason
// went to a console nobody has). A first start still creates nothing.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { childEnv } from "./e2e-app-harness.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));

Deno.test("a bad CLI argument is appended to an existing app.log; a first start creates no home", async () => {
  const dir = await tempDir("cli-refusal-log-");
  try {
    const appId = `clirefuse${Deno.pid}`;
    const apps = join(dir, "apps");
    await Deno.writeTextFile(
      join(dir, "a.ts"),
      `import { aio, cell } from "${toFileUrl(join(ROOT, "mod.ts")).href}";
const c = cell("c", { state: { n: 0 }, methods: { bump(s) { return ++s.n; } } });
await aio.run({ appId: "${appId}", cells: [c], client: "server-only" });
`,
    );
    const start = () =>
      new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--config",
          join(ROOT, "deno.json"),
          "a.ts",
          "--port=notaport",
        ],
        cwd: dir,
        env: childEnv({ AIO_APPS_DIR: apps }),
        stdout: "null",
        stderr: "piped",
      }).output();
    // First start: refused, said on the console, and no home appears.
    const first = await start();
    assertEquals(first.code, 1);
    assertStringIncludes(
      new TextDecoder().decode(first.stderr),
      "--port=notaport",
    );
    let made = true;
    try {
      Deno.statSync(join(apps, appId));
    } catch {
      made = false;
    }
    assert(!made, "a refused first start created the app's home");
    // A home with logs (an app that ran before): the reason lands in app.log.
    const logs = join(apps, appId, "logs");
    await Deno.mkdir(logs, { recursive: true });
    await Deno.writeTextFile(join(logs, "app.log"), "earlier run\n");
    assertEquals((await start()).code, 1);
    const text = await Deno.readTextFile(join(logs, "app.log"));
    assert(text.startsWith("earlier run\n"), "appended, not replaced");
    assert(
      /ERROR {2}boot {8}refused — the app did not start: .*--port=notaport is not a value/
        .test(text),
      text,
    );
  } finally {
    await dropTempDir(dir);
  }
});

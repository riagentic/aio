// guardDispatches keeps an app alive through a stray rejection, never through
// its own top level failing (crash-handler.ts `exitIfMainModuleFailed`). The
// check exited only when `import(Deno.mainModule)` rejected with the SAME
// reason as the event. A worker cell's failing method reaches main twice — one
// copy of its error rejects the awaiting caller (so the top level), another
// arrives as a stray — and asking about the stray handled the module's
// evaluation, so the top level's own event never came: the entry logged one
// unhandledrejection and then hung, the rest of it never run (measured).
import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ENTRY = new URL("./fixtures/tla-worker-reject-app.ts", import.meta.url);
const CONFIG = new URL("../deno.json", import.meta.url);

Deno.test("crash handler: an entry whose top level awaits a failing worker method exits 1, loudly", async () => {
  const home = await tempDir("aio-tla-worker-");
  try {
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        fromFileUrl(CONFIG),
        ENTRY.href,
        `--home=${home}`,
        `--port=${freePort()}`,
      ],
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const killer = setTimeout(() => child.kill("SIGKILL"), 20_000);
    const out = await child.output();
    clearTimeout(killer);
    const text = new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
    assertEquals(out.code, 1, text.slice(-3000));
    assertStringIncludes(text, "top level threw");
    assertStringIncludes(text, "Cause: boom in a worker method");
  } finally {
    await dropTempDir(home);
  }
});

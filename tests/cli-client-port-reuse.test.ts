// A PORT IS NOT AN IDENTITY.
//
// A dev server takes a FREE port, so an app that dies can have its port taken
// by a different app. This client would then reconnect to the stranger, flush
// the offline queue into its database, and resolve every one of those calls as
// success. MEASURED with two scaffolded apps sharing one port: two decrements
// queued for app A landed in app B, whose counter went 0 → -2, with nothing
// said anywhere. The browser transport already scopes its offline queue by
// appId for exactly this reason; this transport carried no identity at all.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { createServer } from "../src/server/server.ts";
import { connectCli } from "../src/server/cli-client.ts";
import { freePort } from "../src/testing/server-test.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const PORT = freePort();

async function waitFor(fn: () => boolean, ms = 8000): Promise<boolean> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

/** A server on the shared PORT, identified by `appId`, recording dispatches. */
async function serve(appId: string, seen: unknown[]) {
  const dir = await tempDir(`cli-reuse-${appId}-`);
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );
  const server = createServer({
    port: PORT,
    appId,
    title: appId,
    getUIState: () => ({ who: appId }),
    dispatch: (a: unknown) => seen.push(a),
    // A real app always supplies this (aio.run does); `/__aio/health` is what
    // carries the appId, and it is the identity this client compares.
    getHealth: () => ({ status: "healthy", appId, cells: {} }),
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
    // deno-lint-ignore no-explicit-any
  } as any);
  await new Promise((r) => setTimeout(r, 60));
  return {
    stop: async () => {
      await server.shutdown();
      await dropTempDir(dir);
    },
  };
}

Deno.test("cli-client: a reused port belonging to ANOTHER app is refused", async () => {
  const errors: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, cat: string, msg?: string) => {
        if (lvl === "error") errors.push(`${cat} ${msg ?? ""}`);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );

  const seenA: unknown[] = [];
  const seenB: unknown[] = [];
  let a = await serve("identity-a", seenA);
  const cli = connectCli<{ who: string }>(`http://127.0.0.1:${PORT}`);
  try {
    const first = await cli.ready;
    assertEquals(first.who, "identity-a");
    // the identity is learned in the background on the first open
    assert(
      await waitFor(() => errors.length >= 0 && true, 100),
      "settle",
    );
    await new Promise((r) => setTimeout(r, 400));

    await a.stop();
    assert(await waitFor(() => !cli.connected), "client noticed the drop");

    // queued for app A, and A alone
    cli.send({ type: "counter:decrement" });
    cli.send({ type: "counter:decrement" });

    // a DIFFERENT app takes the port
    const b = await serve("identity-b", seenB);
    try {
      const refused = await waitFor(
        () => errors.some((e) => e.includes("DIFFERENT app")),
        10_000,
      );
      assert(
        refused,
        `no refusal was logged; errors were:\n${errors.join("\n") || "(none)"}`,
      );
      const hit = errors.find((e) => e.includes("DIFFERENT app"))!;
      assertStringIncludes(hit, "identity-b");
      assertStringIncludes(hit, "identity-a");
      // …and nothing of A's reached B
      assertEquals(seenB, [], "app B received app A's queued actions");
      assertEquals(cli.connected, false, "client attached to the wrong app");
    } finally {
      await b.stop();
    }

    // The REAL app comes back: the queue must still flush. A refusal that also
    // broke ordinary reconnection would be a worse bug than the one it fixes.
    a = await serve("identity-a", seenA);
    const flushed = await waitFor(() => seenA.length >= 2, 15_000);
    assert(
      flushed,
      `the queue never reached the app it belonged to (saw ${seenA.length})`,
    );
    await a.stop();
  } finally {
    cli.close();
    setLogger(prev);
  }
});

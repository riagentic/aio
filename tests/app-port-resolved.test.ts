// `app.port` must be the port the process is REALLY on.
//
// The type calls it "server port — available after aio.run(), useful for
// connectCli()". The app object is built before a listener exists, so it
// carried the REQUESTED port: an app started with `port: 0` ("pick a free
// port") handed its caller a literal 0 while serving on a real one, and the
// use the type names could not be done from the handle at all.
//
// aio.ts already had the right value and the right reasoning — "every place
// that NAMES a port — the boot report, the ws URL, the lock — has to say the
// resolved one. Printing 0 is the same confidently-wrong line as printing a
// number for an app that bound nothing." The public handle was the surface
// that did not get it: a value in two of three places, which is this repo's
// most repeated bug shape.
import { assert, assertEquals } from "@std/assert";

Deno.test("app.port is the RESOLVED port, not the requested 0", async () => {
  const { aio, cell } = await import("../mod.ts");
  const c = cell("portresolved", { state: { n: 0 }, methods: {} });
  const dir = Deno.makeTempDirSync();
  const app = await aio.run({
    cells: [c],
    appId: `portresolved-${Deno.pid}`,
    client: "server-only",
    persist: false,
    libraryMode: true,
    singleton: false,
    port: 0, // "pick a free port"
    baseDir: dir,
    dbPath: ":memory:",
  } as never);
  const handle = app as unknown as {
    port?: number;
    close: () => Promise<void>;
  };
  try {
    assert(
      typeof handle.port === "number" && handle.port > 0,
      `app.port is ${handle.port} — the caller cannot reach their own server`,
    );
    // The number has to be USABLE, not merely non-zero.
    const res = await fetch(`http://localhost:${handle.port}/__aio/health`);
    assertEquals(res.status, 200);
    await res.body?.cancel();
  } finally {
    await handle.close();
    Deno.removeSync(dir, { recursive: true });
  }
});

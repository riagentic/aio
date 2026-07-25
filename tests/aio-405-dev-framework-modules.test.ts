// AIO-405 — the dev server must serve framework modules under /__aio/ in
// non-prod (transpile) mode. Folderization moved server-static.ts into
// src/server/, so `new URL(".", import.meta.url)` pointed at src/server/ and
// every framework module 404'd → the client's `import('/__aio/air/
// aio-renderer.ts')` threw → blank screen for ALL browser/dev apps.
//
// These check the module URLs resolve to real files (the dev server fetches +
// transpiles them). A transpile failure returns a 200 whose body is a
// `throw new Error("... transpile failed ...")` stub — so "no throw stub" is
// the real assertion, not just status 200.
import { assert, assertStringIncludes } from "@std/assert";
import { createServer } from "../src/server/server.ts";
import { freePort } from "../src/testing/server-test.ts";

const BASE = new URL("../src/server/", import.meta.url);

async function resolves(rel: string): Promise<boolean> {
  try {
    await Deno.stat(new URL(rel, BASE));
    return true;
  } catch {
    return false;
  }
}

Deno.test("aio-405: framework entry modules resolve from src/server/", async () => {
  // The exact paths server-static.ts builds for the /__aio/ virtual modules.
  assert(await resolves("../browser-air.ts"), "browser-air.ts (/__aio/ui.js)");
  assert(await resolves("../air.ts"), "air.ts (/__aio/air.js)");
  assert(
    await resolves("../state/listeners.ts"),
    "state/listeners.ts (/__aio/listeners.ts)",
  );
  assert(
    await resolves("../jsx-runtime.ts"),
    "jsx-runtime.ts (/__aio/jsx-runtime.ts)",
  );
});

Deno.test("aio-405: the mounted renderer + a cross-folder dep resolve under /__aio/", async () => {
  // Client entry does `import('/__aio/air/aio-renderer.ts')`. AIO_SRC_BASE_URL
  // is src/ root, so the /__aio/<folder>/<file> path maps to src/<folder>/<file>
  // and the module's own `../state/*.ts` imports stay inside /__aio/.
  const SRC = new URL("../src/", import.meta.url);
  assert(
    await (async () => {
      try {
        await Deno.stat(new URL("air/aio-renderer.ts", SRC));
        return true;
      } catch {
        return false;
      }
    })(),
    "air/aio-renderer.ts must exist (the client mounts it)",
  );
  // A representative cross-folder transitive import.
  assert(
    await (async () => {
      try {
        await Deno.stat(new URL("state/signal.ts", SRC));
        return true;
      } catch {
        return false;
      }
    })(),
    "state/signal.ts (reached via ../state/ from air/) must exist",
  );
});

Deno.test("aio-405: booted dev server serves /__aio/ modules as real JS (not throw-stubs)", async () => {
  const PORT = freePort();
  const dir = await Deno.makeTempDir({ prefix: "aio-405-" });
  const server = createServer(
    {
      port: PORT,
      title: "405",
      getUIState: () => ({ ok: true }),
      dispatch: () => {},
      baseDir: dir,
      debug: () => {},
      prod: false, // dev/transpile mode — this is the path that regressed
    } as unknown as Parameters<typeof createServer>[0],
  );
  await new Promise((r) => setTimeout(r, 60));
  try {
    for (
      const path of [
        "/__aio/air/aio-renderer.ts", // the module the client mounts
        "/__aio/ui.js", // browser-air entry
        "/__aio/state/signal.ts", // cross-folder transitive dep
        "/__aio/jsx-runtime.ts",
      ]
    ) {
      const resp = await fetch(`http://127.0.0.1:${PORT}${path}`);
      const body = await resp.text();
      assert(resp.status === 200, `${path} → ${resp.status}`);
      // A resolution/transpile failure returns 200 with a throw-stub body.
      assert(
        !body.includes("transpile failed"),
        `${path} served a transpile-failure stub:\n${body.slice(0, 160)}`,
      );
      assert(body.length > 50, `${path} suspiciously short (${body.length}b)`);
    }
    // Sanity: the renderer really exports mount.
    const rend = await (await fetch(
      `http://127.0.0.1:${PORT}/__aio/air/aio-renderer.ts`,
    )).text();
    assertStringIncludes(rend, "mount");
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

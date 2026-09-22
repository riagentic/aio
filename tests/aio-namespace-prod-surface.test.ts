// `/__aio/<framework source>.ts` serves framework source, live-transpiled per
// request. It exists for the DEV import map (`aio` → /__aio/ui.js); the prod
// HTML shell emits no import map at all and loads one bundled /app.js, so a
// production page never names this namespace.
//
// Leaving it mounted in prod was not just dead surface. Every hit costs a file
// read plus an esbuild transpile, and the responses carry `no-cache`, so
// nothing downstream absorbs a repeat either — an unauthenticated request that
// costs the server far more than the caller. That is the amplifier shape, and
// it does not get to exist in production for a route nothing calls.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createServer } from "../src/server/server.ts";
import { freePort } from "../src/testing/server-test.ts";
import { join } from "@std/path";

/** Wait until the fixture answers HTTP — not a duration.
 *
 *  `createServer` returns once Deno.serve has bound, but under a loaded suite
 *  the first request can still lose a race against accept. Sleeping 50 ms
 *  measured the machine; fetching until we get a response measures the
 *  server. */
async function waitUntilAnswering(url: string, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url, { redirect: "manual" });
      await resp.body?.cancel().catch(() => {});
      if (resp.status > 0) return;
      last = `status ${resp.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`${what} never answered at ${url} — last: ${last}`);
}

async function withServer(
  prod: boolean,
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const port = freePort();
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );
  // No App.tsx — these tests assert framework-source routes / the prod shell,
  // not a client graph. A stub would start graph validation + esbuild in the
  // prod:false case for no assertion benefit.
  const server = createServer({
    port,
    title: "T",
    getUIState: () => ({}),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod,
    distDir: join(dir, "dist"),
  });
  const url = `http://127.0.0.1:${port}`;
  await waitUntilAnswering(url, "aio-namespace fixture");
  try {
    await fn(url);
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** The framework-source routes — the whole live-transpile surface. */
const SOURCE_ROUTES = [
  "/__aio/ui.js",
  "/__aio/air.js",
  "/__aio/listeners.ts",
  "/__aio/jsx-runtime.ts",
  "/__aio/state/signal.ts",
];

Deno.test({
  name: "prod: the framework-source namespace is not mounted",
  async fn() {
    await withServer(true, async (url) => {
      for (const route of SOURCE_ROUTES) {
        const r = await fetch(url + route);
        const body = await r.text();
        assertEquals(
          r.status,
          404,
          `${route} must not be served in prod (got ${r.status})`,
        );
        // A 200 carrying a transpile-error `throw new Error(...)` would also be
        // "not useful output" while still having done all the work. Assert the
        // body is not transpiled framework code.
        assert(
          !body.includes("export "),
          `${route} must not return framework module code in prod`,
        );
      }
    });
  },
});

Deno.test({
  name: "prod: the shell that WOULD need those routes is never generated",
  async fn() {
    // The reason the routes may be removed: nothing in prod references them.
    // If a future change puts an import map back into the prod shell, this
    // fails and the route removal has to be revisited — the two facts are
    // pinned together rather than left to agree by luck.
    await withServer(true, async (url) => {
      const html = await (await fetch(url)).text();
      assert(
        !html.includes("importmap"),
        `prod shell must not emit an import map (it would need /__aio/*):\n${html}`,
      );
      // The framework-SOURCE routes specifically — not the whole `/__aio/`
      // namespace, which also carries runtime endpoints that are legitimately
      // mounted in prod (`/__aio/health`, `/__aio/blobs/…`, `/__aio/icon`).
      // What must never come back is a shell that needs code transpiled on
      // demand, because that is what the route removal took away.
      for (const route of SOURCE_ROUTES) {
        assert(
          !html.includes(route),
          `prod shell must not reference ${route} (dev-only source route):\n${html}`,
        );
      }
    });
  },
});

Deno.test({
  name: "dev: the framework-source namespace still serves (dev needs it)",
  async fn() {
    // The complement. Removing these in dev would break every dev page, so the
    // gate must be exactly `prod` and nothing broader.
    await withServer(false, async (url) => {
      const r = await fetch(url + "/__aio/air.js");
      assertEquals(r.status, 200, "dev must still serve /__aio/air.js");
      const body = await r.text();
      assertStringIncludes(
        body,
        "export",
        "dev /__aio/air.js must be the transpiled AIR module, not merely " +
          "a non-empty body",
      );
    });
  },
});

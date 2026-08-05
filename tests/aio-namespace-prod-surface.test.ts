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
import { assert, assertEquals } from "@std/assert";
import { createServer } from "../src/server/server.ts";
import { freePort } from "../src/testing/server-test.ts";
import { join } from "@std/path";

/** Boot a server in the given mode and run `fn` against its base URL. */
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
  // A minimal App so the dev shell has something to point at.
  await Deno.writeTextFile(
    join(dir, "App.tsx"),
    "export default function App() { return null }\n",
  );
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
  await new Promise((r) => setTimeout(r, 50));
  try {
    await fn(`http://127.0.0.1:${port}`);
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
  sanitizeResources: false,
  sanitizeOps: false,
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
  sanitizeResources: false,
  sanitizeOps: false,
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
      assert(
        !html.includes("/__aio/"),
        `prod shell must not reference the /__aio/ namespace:\n${html}`,
      );
    });
  },
});

Deno.test({
  name: "dev: the framework-source namespace still serves (dev needs it)",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    // The complement. Removing these in dev would break every dev page, so the
    // gate must be exactly `prod` and nothing broader.
    await withServer(false, async (url) => {
      const r = await fetch(url + "/__aio/air.js");
      assertEquals(r.status, 200, "dev must still serve /__aio/air.js");
      const body = await r.text();
      assert(body.length > 0, "dev /__aio/air.js must not be empty");
    });
  },
});

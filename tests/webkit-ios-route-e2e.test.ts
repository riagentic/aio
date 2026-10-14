// The iOS route, on Apple's engine: the `web` target (the PWA an iPhone
// installs from Safari) and the server-served page, driven in WebKit under
// iPhone and iPad emulation.
//
// What this proves: the pages parse, render, take taps, keep state and work
// offline in WebKit — the engine every iOS browser is. What it does NOT: Home
// Screen (standalone) mode, real backgrounding, the safe area, or anything a
// device adds; those need an iPhone (docs/build/targets.md says the same).
//
// Opt-in (`AIO_WEBKIT_E2E=1`, `deno task test:webkit`) — tracked as
// `ios route (webkit engine)` in the physical proof matrix. The engine is
// Playwright's WebKit build, found through `AIO_PLAYWRIGHT_DIR`: a directory
// where `npm i playwright` and `npx playwright install webkit` were run.
// Nothing is downloaded by this test; without the engine it is skipped, and
// says so.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { extname, join } from "@std/path";
import { createRequire } from "node:module";
import { buildFlags, freePort, makeApp } from "./e2e-app-harness.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const GATED = Deno.env.get("AIO_WEBKIT_E2E") === "1";

// deno-lint-ignore no-explicit-any
type Pw = any;

/** Playwright and its WebKit, or why this machine has neither. */
function engine(): { webkit: Pw; devices: Pw } | string {
  const dir = Deno.env.get("AIO_PLAYWRIGHT_DIR");
  if (!dir) {
    return "AIO_PLAYWRIGHT_DIR is not set (a directory with " +
      "node_modules/playwright and its WebKit installed)";
  }
  try {
    const pw = createRequire(join(dir, "package.json"))("playwright");
    const exe = pw.webkit.executablePath();
    if (!Deno.statSync(exe).isFile) return `${exe} is not a file`;
    return pw;
  } catch (e) {
    // aio-ok: no engine is this function's answer — the caller prints it as the skip reason.
    return `no Playwright WebKit under ${dir} (${
      String(e instanceof Error ? e.message : e).split("\n")[0]
    })`;
  }
}
const ENGINE = GATED ? engine() : "not asked for";
if (GATED && typeof ENGINE === "string") {
  console.warn(`[aio] ⚠ webkit lane SKIPPED — ${ENGINE}`);
}

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".md": "text/markdown",
  ".webmanifest": "application/manifest+json",
};

/** Poll `fn` until it returns non-null, or fail naming `what`. */
async function until<T>(
  what: string,
  fn: () => Promise<T | null>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v !== null) return v;
    } catch (e) {
      last = String(e).split("\n")[0]!; // aio-ok: kept for the timeout message below
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last}` : ""}`);
}

/** A counter whose page has what the checks read by id, a route that answers
 *  the SERVER's count, and a packaged asset. */
async function writeApp(dir: string): Promise<void> {
  await Deno.writeTextFile(
    join(dir, "src", "cell.ts"),
    `import { cell } from "aio";
export const counter = cell("counter", {
  state: { count: 0 },
  methods: {
    increment(s) {
      s.count += 1;
    },
  },
});
`,
  );
  await Deno.writeTextFile(
    join(dir, "src", "App.tsx"),
    `import type { JSX } from "aio";
import { counter } from "./cell.ts";
export default function App(): JSX.Element {
  return (
    <main>
      <h1>WebKit lane</h1>
      <output id="n">{counter.count}</output>
      <button type="button" id="plus" onClick={() => counter.increment()}>+</button>
      <input id="i" placeholder="text" />
      <textarea id="t"></textarea>
      <select id="s"><option>one</option></select>
    </main>
  );
}
`,
  );
  await Deno.writeTextFile(
    join(dir, "src", "app.ts"),
    `import { counter } from "./cell.ts";
import { aio } from "aio";
await aio.run({
  ui: { theme: "auto" },
  routes: { "/count": () => new Response(String(counter.count)) },
});
`,
  );
  const cfgPath = join(dir, "deno.json");
  const cfg = JSON.parse(await Deno.readTextFile(cfgPath));
  cfg.assets = { "/text": "./text" };
  await Deno.writeTextFile(cfgPath, JSON.stringify(cfg, null, 2));
  await Deno.mkdir(join(dir, "text", "en"), { recursive: true });
  await Deno.writeTextFile(join(dir, "text", "en", "a.md"), "# packaged");
  for (const f of ["style.css"]) {
    await Deno.remove(join(dir, "src", f)).catch(() => {
      // aio-ok: the scaffold ships none today — `theme: "auto"` needs it absent
    });
  }
}

/** The app's server, serving its page — never a window. */
function startServer(dir: string, port: number) {
  const proc = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "src/app.ts", "--client=server-only", `--port=${port}`],
    cwd: dir,
    env: { AIO_APPS_DIR: join(dir, ".home") },
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let text = "";
  const dec = new TextDecoder();
  const pump = (r: ReadableStream<Uint8Array>) =>
    r.pipeTo(
      new WritableStream({
        write(c) {
          text += dec.decode(c);
        },
      }),
    );
  const pumps = Promise.all([pump(proc.stdout), pump(proc.stderr)]);
  let exited = false;
  const status = proc.status.then(() => exited = true);
  return {
    log: () => text,
    stop: async () => {
      if (!exited) proc.kill("SIGTERM");
      await status;
      await pumps;
    },
  };
}

Deno.test({
  name:
    "ios route: the web build and the server page run in WebKit as an iPhone and an iPad",
  ignore: !GATED || typeof ENGINE === "string",
  sanitizeOps: false, // aio-ok(sanitizers): an external browser, a static server and the app's server, all stopped in `finally`
  sanitizeResources: false, // aio-ok(sanitizers): same — Playwright's pipes to the browser close with it
  async fn(t) {
    const { webkit, devices } = ENGINE as { webkit: Pw; devices: Pw };
    const dir = await makeApp("counter", "webkit-ios-route-");
    const foreign = await tempDir("webkit-ios-site-");
    let site: Deno.HttpServer | undefined;
    let server: ReturnType<typeof startServer> | undefined;
    let browser: Pw;
    try {
      await writeApp(dir);
      const b = await buildFlags(dir, "--web");
      assertEquals(b.code, 0, `web build failed:\n${b.out}\n${b.err}`);
      const placed = [...Deno.readDirSync(join(dir, "dist"))]
        .find((e) => e.isDirectory && e.name.endsWith("-web"));
      assert(placed, `no -web directory in dist/:\n${b.out}`);
      const root = join(foreign, "site");
      await copy(join(dir, "dist", placed.name), root);
      browser = await webkit.launch({ headless: true });
      const N = "document.getElementById('n').textContent";

      for (const device of ["iPhone 13", "iPad (gen 7)"]) {
        await t.step(`web build as ${device}`, async () => {
          const port = freePort();
          site = Deno.serve(
            { hostname: "127.0.0.1", port, onListen: () => {} },
            async (req) => {
              let path = decodeURIComponent(new URL(req.url).pathname);
              if (path.endsWith("/")) path += "index.html";
              try {
                return new Response(await Deno.readFile(join(root, path)), {
                  headers: {
                    "content-type": TYPES[extname(path)] ??
                      "application/octet-stream",
                  },
                });
              } catch {
                // aio-ok: a static server's 404 — the deep-route check below relies on it
                return new Response("not found", { status: 404 });
              }
            },
          );
          const url = `http://127.0.0.1:${port}/`;
          const ctx = await browser.newContext({
            ...devices[device],
            serviceWorkers: "allow",
          });
          try {
            const page = await ctx.newPage();
            const errors: string[] = [];
            page.on("pageerror", (e: unknown) => errors.push(String(e)));
            await page.goto(url, { waitUntil: "load" });
            const shows = (n: string) =>
              page.waitForFunction(
                (want: string) =>
                  document.getElementById("n")?.textContent === want,
                n,
                { timeout: 20_000 },
              );
            await shows("0");
            // A modern engine is never told it is too old.
            assert(
              !(await page.evaluate("document.body.innerText")).includes(
                "too old",
              ),
            );
            const m = await page.evaluate(`({
              ua: navigator.userAgent,
              viewport: document.querySelector('meta[name=viewport]').content,
              inner: innerWidth,
              scroll: document.documentElement.scrollWidth,
              apple: document.querySelectorAll('meta[name^="apple"],link[rel="apple-touch-icon"],link[rel=manifest],meta[name="theme-color"]').length,
              fonts: ["i", "t", "s"].map((id) => parseFloat(getComputedStyle(document.getElementById(id)).fontSize)),
              bg: getComputedStyle(document.body).backgroundColor,
            })`);
            assertStringIncludes(m.ua, "AppleWebKit");
            assertStringIncludes(m.viewport, "viewport-fit=cover");
            assert(m.scroll <= m.inner, `overflows: ${m.scroll} > ${m.inner}`);
            assert(m.apple >= 4, `apple/PWA head tags: ${m.apple}`);
            // iOS zooms the page when a focused control's text is under 16px.
            assert(
              m.fonts.every((f: number) => f >= 16),
              `control font sizes: ${m.fonts}`,
            );
            await page.locator("#plus").tap();
            await page.locator("#plus").tap();
            await shows("2");
            // The service worker installs, caches, and — after a reload —
            // controls the page; the state is the page's own.
            const sw = await page.evaluate(
              `navigator.serviceWorker.ready.then(async (r) => ({ state: r.active.state, caches: (await caches.keys()).length }))`,
            );
            assertEquals(sw.caches, 1, JSON.stringify(sw));
            await page.reload({ waitUntil: "load" });
            await shows("2");
            assert(
              await page.evaluate("!!navigator.serviceWorker.controller"),
              "the reloaded page is not controlled by the service worker",
            );
            await page.emulateMedia({ colorScheme: "dark" });
            const dark = await page.evaluate(
              "getComputedStyle(document.body).backgroundColor",
            );
            assert(dark !== m.bg, `dark scheme changed nothing: ${dark}`);

            // The server is GONE: the page, its state, a packaged asset and
            // a deep route all come from the cache.
            await site!.shutdown();
            site = undefined;
            await page.reload({ waitUntil: "load" });
            await shows("2");
            assertEquals(
              (await page.evaluate(
                `fetch("text/en/a.md").then((r) => r.text())`,
              )).trim(),
              "# packaged",
            );
            await page.goto(url + "some/deep/route", { waitUntil: "load" });
            await shows("2");
            assertEquals(errors, []);
          } finally {
            await ctx.close();
            await site?.shutdown();
            site = undefined;
          }
        });
      }

      await t.step(
        "server page as iPhone 13: a tap over the WebSocket, the socket lost and found, a call made meanwhile delivered",
        async () => {
          const port = freePort();
          const count = async () => {
            const r = await fetch(`http://127.0.0.1:${port}/count`);
            return r.ok ? await r.text() : (await r.body?.cancel(), null);
          };
          const up = (srv: ReturnType<typeof startServer>) =>
            until("the server", count, 60_000).catch((e) => {
              throw new Error(`${e.message}\nthe server said:\n${srv.log()}`);
            });
          server = startServer(dir, port);
          assertEquals(await up(server), "0");
          const ctx = await browser.newContext({ ...devices["iPhone 13"] });
          try {
            const page = await ctx.newPage();
            const errors: string[] = [];
            page.on("pageerror", (e: unknown) => errors.push(String(e)));
            await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
            await until(
              "the server page to render",
              async () => (await page.evaluate(N)) === "0" ? true : null,
            );
            assert(
              !(await page.evaluate("document.body.innerText")).includes(
                "too old",
              ),
            );
            await page.locator("#plus").tap();
            await until(
              "the tap to reach the server",
              async () => (await count()) === "1" ? true : null,
            );
            // The socket dies the way a backgrounded tab's does: its server
            // end goes away.
            await server.stop();
            await until(
              "the page to say it lost its server",
              async () =>
                (await page.evaluate("document.body.innerText")).includes(
                    "Reconnecting",
                  )
                  ? true
                  : null,
              60_000,
            );
            await page.locator("#plus").tap(); // a call made with no socket
            server = startServer(dir, port);
            assertEquals(await up(server), "1", "a tap arrived while offline");
            await until(
              "the call made offline to reach the server",
              async () => (await count()) === "2" ? true : null,
              90_000,
            );
            await until(
              "the page to show the server's count",
              async () => (await page.evaluate(N)) === "2" ? true : null,
            );
            assertEquals(errors, []);
          } finally {
            await ctx.close();
            await server.stop();
            server = undefined;
          }
        },
      );

      const { recordProof } = await import("../scripts/proof.ts");
      await recordProof(
        "ios route",
        "webkit engine",
        `WebKit ${browser.version()} as iPhone 13 and iPad (gen 7): web build (render, tap, state across a reload, service worker controls, offline from the cache with the server gone — page, state, asset, deep route — no overflow, 16px controls, dark scheme) + server page (tap over WebSocket, reconnect, a call made offline delivered). Not Home Screen mode, backgrounding or the safe area`,
      );
    } finally {
      await browser?.close();
      await site?.shutdown();
      await server?.stop();
      await dropTempDir(foreign);
      await Deno.remove(dir, { recursive: true });
    }
  },
});

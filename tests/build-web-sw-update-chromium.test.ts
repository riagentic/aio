// The `web` target's service worker (src/build/build-web.ts), run by a REAL
// Chromium against a static host that sends `Cache-Control: max-age` — as
// GitHub Pages, Netlify and most CDNs do. Build A is loaded, build B is
// deployed over it, the worker updates:
//   - the new cache holds B's bytes, not A's from the browser's HTTP cache
//     (a precache through the HTTP cache pinned the OLD bundle under the NEW
//     version, served cache-first until the build after next);
//   - a file named with ` `, `#` or `?` is cached (unescaped, it fetched
//     another URL, 404'd, and failed the whole install: B never took over);
//   - the old build's cache is dropped, and a file B removed is gone;
//   - a client route the host 404s (a reload on /settings) gets the shell,
//     online as offline;
//   - a CDN edge still serving the OLD bundle to the new worker (an edge
//     ignores the browser's `cache: "reload"`) fails the install instead of
//     pinning A's bytes under B's version — cache-first, for good — and B
//     takes over once the edge serves B;
//   - a host that rewrites an image (an optimizer recompresses a PNG) still
//     gets the offline cache: only code is digest-checked.
//
// Runs when a chromium/chrome binary is on the box; skipped (visibly)
// otherwise. Opt out with AIO_E2E=0.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { serviceWorker } from "../src/build/build-web.ts";
import { cdpConnect } from "../src/media/cdp.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { stopChild } from "./stop-child.ts";
import { findBrowser, freePort } from "./e2e-harness.ts";

const BROWSER = findBrowser();

async function waitFor<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v !== null && v !== undefined && v !== false) return v as T;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${what}`);
}

const SHELL = `<!doctype html><title>shell</title><p id=shell>shell</p>
<script>navigator.serviceWorker.register("./sw.js")</script>`;

async function deploy(
  site: string,
  version: string,
  files: Record<string, string>,
): Promise<void> {
  for (const e of Deno.readDirSync(site)) {
    await Deno.remove(join(site, e.name));
  }
  const all = { "index.html": SHELL, ...files };
  for (const [f, body] of Object.entries(all)) {
    await Deno.writeTextFile(join(site, f), body);
  }
  const sri: Record<string, string> = {};
  for (const [f, body] of Object.entries(files)) {
    const d = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(body),
    );
    sri[f] = "sha256-" + btoa(String.fromCharCode(...new Uint8Array(d)));
  }
  await Deno.writeTextFile(
    join(site, "sw.js"),
    serviceWorker("t", version, Object.keys(all).sort(), sri),
  );
}

Deno.test({
  name:
    "web sw (chromium): an update behind a max-age host caches the NEW bytes, drops the old build, serves the shell offline",
  ignore: BROWSER === null,
  sanitizeOps: false, // aio-ok(sanitizers): external browser + a static server, both stopped in `finally`
  sanitizeResources: false, // aio-ok(sanitizers): same — the browser child outlives the check
  async fn() {
    const site = await tempDir("aio-web-sw-site-");
    const profile = await tempDir("aio-web-sw-profile-");
    const port = freePort();
    // A CDN edge that has not seen the deploy yet: this path's OLD bytes.
    const stale = new Map<string, string>();
    let server: Deno.HttpServer | undefined = Deno.serve(
      { hostname: "127.0.0.1", port, onListen: () => {} },
      async (req) => {
        let path = decodeURIComponent(new URL(req.url).pathname);
        if (path.endsWith("/")) path += "index.html";
        try {
          const edge = stale.get(path);
          // An image optimizer (Cloudflare Polish) recompresses a PNG.
          const body = edge ??
            (path.endsWith(".png")
              ? (await Deno.readTextFile(join(site, path))) + "!"
              : await Deno.readFile(join(site, path)));
          return new Response(body, {
            headers: {
              "content-type": path.endsWith(".html")
                ? "text/html"
                : "text/javascript",
              "cache-control": "max-age=3600",
            },
          });
        } catch (e) {
          if (!(e instanceof Deno.errors.NotFound)) throw e;
          return new Response("not found", { status: 404 });
        }
      },
    );
    const browser = new Deno.Command(BROWSER!, {
      args: [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        `--user-data-dir=${profile}`,
        "--remote-debugging-port=0",
        "about:blank",
      ],
      env: testDisplayEnv(),
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    let cdp: Awaited<ReturnType<typeof cdpConnect>> | null = null;
    try {
      const wsUrl = await waitFor("devtools", async () => {
        const p = Number(
          (await Deno.readTextFile(`${profile}/DevToolsActivePort`))
            .split("\n")[0],
        );
        const targets = await (await fetch(`http://127.0.0.1:${p}/json`))
          .json() as { type: string; webSocketDebuggerUrl: string }[];
        return targets.find((t) => t.type === "page")?.webSocketDebuggerUrl;
      });
      cdp = await cdpConnect(wsUrl);
      const c = cdp;
      const js = async <T>(expression: string): Promise<T> => {
        const r = await c.call("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
        }) as { result?: { value?: T }; exceptionDetails?: unknown };
        assert(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
        return r.result?.value as T;
      };
      const cached = (f: string) =>
        js<string | null>(
          `caches.match(${JSON.stringify(f)}).then((r) => r ? r.text() : null)`,
        );

      await deploy(site, "a", {
        "app.js": "A",
        "gone.js": "G",
        "icon.png": "P",
      });
      await c.call("Page.navigate", { url: `http://127.0.0.1:${port}/` });
      await waitFor(
        "build A to control the page",
        () =>
          js<boolean>(
            // Not `.ready`: it never settles for a refused install, and the
            // wait would hang instead of timing out.
            `!!navigator.serviceWorker.controller`,
          ),
      );
      assertEquals(await cached("./app.js"), "A");

      const update = () =>
        js(`navigator.serviceWorker.getRegistration().then((r) => r.update())`);
      stale.set("/app.js", "A");
      await deploy(site, "b", {
        "app.js": "B",
        "notes #1?.js": "N",
        "logo@2x.svg": "L",
      });
      // A refused install may reject the update — what is asserted is below.
      await update().catch(() => {});
      await waitFor(
        "the update to settle",
        () =>
          js<boolean>(
            `navigator.serviceWorker.getRegistration().then((r) => !r.installing && !r.waiting)`,
          ),
      );
      assertEquals(
        await js<string | null>(
          `caches.open("aio-t-b").then((c) => c.match("./app.js")).then((r) => r ? r.text() : null)`,
        ),
        null,
        "the edge's OLD bundle was precached as build B",
      );
      assertEquals(
        await js<string>(`fetch("./app.js").then((r) => r.text())`),
        "A",
        "build A keeps serving, whole, until B can be fetched whole",
      );
      stale.clear();
      await update();
      await waitFor(
        "build B's cache to be the only one",
        async () =>
          JSON.stringify(await js<string[]>(`caches.keys()`)) ===
            `["aio-t-b"]`,
      );
      assertEquals(await cached("./app.js"), "B", "the new build's bytes");
      assertEquals(await cached("./gone.js"), null, "a removed file is gone");
      assertEquals(
        await cached("./notes%20%231%3F.js"),
        "N",
        "a name URLs escape",
      );
      assertEquals(
        await cached("./logo@2x.svg"),
        "L",
        "a name the page asks for unescaped — `%40` would be another key",
      );

      // Online, a client route the host has no file for (a reload on
      // /settings) is the shell too — as it is offline — not the host's 404.
      await c.call("Page.navigate", {
        url: `http://127.0.0.1:${port}/settings`,
      });
      assertEquals(
        await waitFor(
          "the shell online",
          () => js<string | null>(`document.getElementById("shell")?.id`),
        ),
        "shell",
      );

      await server.shutdown();
      server = undefined;
      await c.call("Page.navigate", {
        url: `http://127.0.0.1:${port}/deep/route?x=1`,
      });
      assertEquals(
        await waitFor(
          "the shell offline",
          () => js<string | null>(`document.getElementById("shell")?.id`),
        ),
        "shell",
      );
    } finally {
      await cdp?.close();
      await stopChild(browser, { quiet: true });
      await server?.shutdown();
      await dropTempDir(site);
      await dropTempDir(profile);
    }
  },
});

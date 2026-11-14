// The `web` target's service worker (src/build/build-web.ts) on a static host
// that redirects /index.html → / (Cloudflare Pages, Vercel cleanUrls,
// `npx serve`), run by a REAL Chromium. The precache's `cache.addAll` stores
// "./index.html" as a REDIRECTED response, and Chromium refuses a redirected
// response as a navigation's answer (ERR_FAILED): the installed app was dead
// offline on a reload of a client route one level deep (/settings), and on a
// navigation to /index.html itself. The worker hands a navigation a copy that
// is not redirected.
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
import { browserOsFlags, findBrowser, freePort } from "./e2e-harness.ts";
import { browserHomeEnv, dropBrowserProfile } from "../src/testing/chromium.ts";

const BROWSER = findBrowser();

async function waitFor<T>(
  what: string,
  fn: () => Promise<T | null | undefined | false>,
  timeoutMs = 20_000,
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

Deno.test({
  name:
    "web sw (chromium): offline, a host that redirects /index.html → / still gets the shell on a client route and on /index.html",
  ignore: BROWSER === null,
  sanitizeOps: false, // aio-ok(sanitizers): external browser + a static server, both stopped in `finally`
  sanitizeResources: false, // aio-ok(sanitizers): same — the browser child outlives the check
  async fn() {
    const site = await tempDir("aio-web-sw-redir-site-");
    const profile = await tempDir("aio-web-sw-redir-profile-");
    const port = freePort();
    await Deno.writeTextFile(join(site, "index.html"), SHELL);
    await Deno.writeTextFile(join(site, "app.js"), "A");
    await Deno.writeTextFile(
      join(site, "sw.js"),
      serviceWorker("t", "a", ["app.js", "index.html", "sw.js"]),
    );
    let server: Deno.HttpServer | undefined = Deno.serve(
      { hostname: "127.0.0.1", port, onListen: () => {} },
      async (req) => {
        let path = new URL(req.url).pathname;
        // Clean URLs: /index.html → / (308), as Cloudflare Pages and serve do.
        if (path.endsWith("/index.html")) {
          return new Response(null, {
            status: 308,
            headers: { location: path.slice(0, -"index.html".length) },
          });
        }
        if (path.endsWith("/")) path += "index.html";
        try {
          return new Response(await Deno.readFile(join(site, path)), {
            headers: {
              "content-type": path.endsWith(".html")
                ? "text/html"
                : "text/javascript",
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
        ...browserOsFlags,
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        `--user-data-dir=${profile}`,
        "--remote-debugging-port=0",
        "about:blank",
      ],
      env: { ...browserHomeEnv(profile), ...testDisplayEnv() },
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
      await c.call("Page.navigate", { url: `http://127.0.0.1:${port}/` });
      await waitFor(
        "the worker to control the page",
        () => js<boolean>(`!!navigator.serviceWorker.controller`),
      );
      assertEquals(
        await js<boolean>(
          `caches.match("./index.html").then((r) => !!r && r.redirected)`,
        ),
        true,
        "the host's redirect is what the precache holds (the case under test)",
      );
      await server.shutdown();
      server = undefined;
      for (const route of ["/settings", "/index.html"]) {
        await c.call("Page.navigate", {
          url: `http://127.0.0.1:${port}${route}`,
        });
        assertEquals(
          await waitFor(
            `the shell offline on ${route}`,
            () => js<string | null>(`document.getElementById("shell")?.id`),
            8_000,
          ),
          "shell",
        );
        await c.call("Page.navigate", { url: "about:blank" });
        await waitFor(
          "about:blank",
          () => js<boolean>(`location.href === "about:blank"`),
        );
      }
    } finally {
      await cdp?.close();
      await stopChild(browser, { quiet: true });
      await server?.shutdown();
      await dropTempDir(site);
      await dropBrowserProfile(profile);
    }
  },
});

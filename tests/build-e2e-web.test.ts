// The `web` target's artifact, proven the way a user meets it: built by the
// fleet from a scaffold, copied to a FOREIGN directory, served there by a plain
// static server, opened in a real Chromium — then the server is stopped and
// the page is reloaded. It must still boot (the service worker's offline
// cache) and still hold the count clicked before (cells in page storage, no
// server anywhere).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { copy } from "@std/fs";
import { extname, join } from "@std/path";
import { buildFlags, freePort, makeApp } from "./e2e-app-harness.ts";
import { findBrowser } from "./e2e-harness.ts";
import { cdpConnect } from "../src/media/cdp.ts";
import { tempDir } from "../src/testing/temp-dir.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { stopChild } from "./stop-child.ts";

const GATE = Deno.env.get("AIO_BUILD_E2E") === "1";
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
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timeout waiting for ${what}`);
}

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

Deno.test({
  name:
    "artifact: the `web` target runs from a foreign dir, offline after its first load, with its state",
  ignore: !GATE || BROWSER === null,
  sanitizeOps: false, // aio-ok(sanitizers): external browser + a static server, both stopped in `finally`
  sanitizeResources: false, // aio-ok(sanitizers): same — the browser child outlives the check
  fn: async () => {
    const dir = await makeApp("counter", "build-e2e-web-");
    const foreign = await tempDir("foreign-cwd-web-");
    const profile = await tempDir("aio-web-chromium-");
    let server: Deno.HttpServer | undefined;
    let browser: Deno.ChildProcess | undefined;
    let cdp: Awaited<ReturnType<typeof cdpConnect>> | null = null;
    try {
      const b = await buildFlags(dir, "--web");
      assertEquals(b.code, 0, `web build failed:\n${b.out}\n${b.err}`);
      const placed = [...Deno.readDirSync(join(dir, "dist"))]
        .filter((e) => e.isDirectory && e.name.endsWith("-web"));
      assertEquals(placed.length, 1, "one placed <name>-<version>-web/");
      const manifest = JSON.parse(
        await Deno.readTextFile(join(dir, "dist", "manifest.json")),
      ) as { targets: { target: string; artifacts: { file: string }[] }[] };
      assertEquals(
        manifest.targets.map((t) => [t.target, t.artifacts.map((a) => a.file)]),
        [["web", [placed[0]!.name]]],
      );
      const site = join(foreign, "site");
      await copy(join(dir, "dist", placed[0]!.name), site);
      // Nothing server-shaped ships: no binary, no source, no map.
      const files = [...Deno.readDirSync(site)].map((e) => e.name).sort();
      for (
        const f of ["app.js", "index.html", "manifest.webmanifest", "sw.js"]
      ) assert(files.includes(f), `${f} missing: ${files}`);
      assert(!files.some((f) => /\.(ts|tsx|map)$/.test(f)), String(files));
      const js = await Deno.readTextFile(join(site, "app.js"));
      assertStringIncludes(js, `__aioBundleTarget = "android"`); // the standalone shape

      const port = freePort();
      server = Deno.serve(
        { hostname: "127.0.0.1", port, onListen: () => {} },
        async (req) => {
          let path = decodeURIComponent(new URL(req.url).pathname);
          if (path.endsWith("/")) path += "index.html";
          try {
            const body = await Deno.readFile(join(site, path));
            return new Response(body, {
              headers: {
                "content-type": TYPES[extname(path)] ??
                  "application/octet-stream",
              },
            });
          } catch {
            return new Response("not found", { status: 404 });
          }
        },
      );
      browser = new Deno.Command(BROWSER!, {
        args: [
          "--headless=new",
          "--no-sandbox",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          "--password-store=basic",
          "--use-mock-keychain",
          `--user-data-dir=${profile}`,
          "--remote-debugging-port=0",
          "about:blank",
        ],
        cwd: foreign,
        env: testDisplayEnv(),
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn();
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
      const js$ = async <T>(expression: string): Promise<T> => {
        const r = await c.call("Runtime.evaluate", {
          expression,
          returnByValue: true,
          awaitPromise: true,
        }) as { result?: { value?: T }; exceptionDetails?: unknown };
        assert(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
        return r.result?.value as T;
      };
      const count = () =>
        js$<string | null>(
          `(() => { const el = [...document.querySelectorAll("main .card div")]
             .find((d) => /^-?\\d+$/.test(d.textContent.trim()));
             return el ? el.textContent.trim() : null; })()`,
        );
      const url = `http://127.0.0.1:${port}/`;
      await c.call("Page.navigate", { url });
      assertEquals(await waitFor("the counter to mount", count), "0");
      assertEquals(
        await js$<string>(
          `document.querySelector('link[rel="manifest"]').getAttribute("href")`,
        ),
        "./manifest.webmanifest",
      );
      // The + button (the last one in the row).
      await js$(`document.querySelectorAll("main button")[2].click()`);
      assertEquals(
        await waitFor("count 1", async () => (await count()) === "1" && "1"),
        "1",
      );
      // The offline cache is installed and controls the page.
      await waitFor(
        "the service worker to control the page",
        () =>
          js$<boolean>(
            `navigator.serviceWorker.ready.then(() => !!navigator.serviceWorker.controller)`,
          ),
      );

      // Offline: the server is gone, the page still boots with its state.
      await server.shutdown();
      server = undefined;
      await c.call("Page.reload", {});
      assertEquals(
        await waitFor("the counter offline", async () => {
          const v = await count();
          return v === "1" ? v : null;
        }),
        "1",
      );
    } finally {
      await cdp?.close();
      if (browser) await stopChild(browser, { quiet: true });
      await server?.shutdown();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

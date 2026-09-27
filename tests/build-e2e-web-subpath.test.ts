// The `web` target deployed under a sub-path — a GitHub Pages project site at
// `/repo/` — in a real Chromium. The router took no base there, so no
// `<Route>` ever matched; and the `assets` scaffold fetched `/media/…` from
// the origin's root, past the site. Built from the `assets` scaffold with a
// routed App, served at /repo/ by a plain static server.
//
// And a reload on a client route two levels deep (`/a/b`), at the origin's
// root and under `/repo/`, online and offline: the service worker served the
// shell there, but the shell's `./app.js` (and css, manifest, icons, sw.js)
// resolved against `/a/` — a blank page.
import { assert, assertEquals } from "@std/assert";
import { copy } from "@std/fs";
import { extname, join } from "@std/path";
import { buildFlags, freePort, makeApp } from "./e2e-app-harness.ts";
import { findBrowser } from "./e2e-harness.ts";
import { cdpConnect } from "../src/media/cdp.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
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
  ".txt": "text/plain",
};

const APP = `import type { JSX } from "aio";
import { Link, Route } from "aio";
import "./cell.ts";

export default function App(): JSX.Element {
  return (
    <main>
      <Route path="/" element={<p id="home">home</p>} />
      <Route path="/about" element={<p id="about">about</p>} />
      <Route path="/a/b" element={<p id="deep">deep</p>} />
      <Link to="/about">About</Link>
    </main>
  );
}
`;

/** A plain static host of `site` under `prefix` ("" = the origin's root):
 *  anything else, and any missing file, is a 404 — GitHub Pages without a
 *  404.html. */
function serveSite(
  site: string,
  prefix: string,
): { port: number; server: Deno.HttpServer } {
  const port = freePort();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port, onListen: () => {} },
    async (req) => {
      let path = decodeURIComponent(new URL(req.url).pathname);
      if (!path.startsWith(prefix + "/")) {
        return new Response("not found", { status: 404 });
      }
      path = path.slice(prefix.length);
      if (path.endsWith("/")) path += "index.html";
      try {
        return new Response(await Deno.readFile(join(site, path)), {
          headers: {
            "content-type": TYPES[extname(path)] ?? "application/octet-stream",
          },
        });
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
        return new Response("not found", { status: 404 });
      }
    },
  );
  return { port, server };
}

Deno.test({
  name:
    "artifact: a `web` build served under /repo/ routes relative to it and fetches its assets there",
  ignore: !GATE || BROWSER === null,
  sanitizeOps: false, // aio-ok(sanitizers): external browser + a static server, both stopped in `finally`
  sanitizeResources: false, // aio-ok(sanitizers): same — the browser child outlives the check
  fn: async () => {
    const dir = await makeApp("assets", "build-e2e-web-subpath-");
    const foreign = await tempDir("foreign-cwd-web-subpath-");
    const profile = await tempDir("aio-web-subpath-chromium-");
    const servers: Deno.HttpServer[] = [];
    let browser: Deno.ChildProcess | undefined;
    let cdp: Awaited<ReturnType<typeof cdpConnect>> | null = null;
    try {
      await Deno.writeTextFile(join(dir, "src", "App.tsx"), APP);
      const b = await buildFlags(dir, "--web");
      assertEquals(b.code, 0, `web build failed:\n${b.out}\n${b.err}`);
      const placed = [...Deno.readDirSync(join(dir, "dist"))]
        .find((e) => e.isDirectory && e.name.endsWith("-web"))!;
      const site = join(foreign, "site");
      await copy(join(dir, "dist", placed.name), site);

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

      // The deep route, reloaded: once over the network (the host 404s it,
      // the service worker answers with the shell), once with the host gone.
      const deepReload = async (origin: string, prefix: string) => {
        await waitFor(
          "the service worker to control the page",
          () => js$<boolean>(`!!navigator.serviceWorker.controller`),
        );
        for (const mode of ["online", "offline"]) {
          if (mode === "offline") await servers.pop()!.shutdown();
          await c.call("Page.navigate", { url: `${origin}${prefix}/a/b` });
          await waitFor(
            `<Route path='/a/b'> after a ${mode} reload of ${prefix}/a/b`,
            () =>
              js$<boolean>(
                `location.pathname === ${
                  JSON.stringify(prefix + "/a/b")
                } && !!document.getElementById("deep")`,
              ),
          );
          assertEquals(
            await js$<string>(`document.querySelector("main a").pathname`),
            `${prefix}/about`,
            `<Link> keeps the route base after a ${mode} deep reload`,
          );
          assertEquals(
            await js$<string>(
              `navigator.serviceWorker.getRegistration().then((r) => r.scope)`,
            ),
            `${origin}${prefix}/`,
            "no second service worker registered at the deep path",
          );
          assert(
            await js$<boolean>(`!!document.querySelector("base")`),
            `the ${mode} deep shell resolves against the scope (<base>)`,
          );
          // One level deep already resolves: no <base>, so a "#section" link
          // stays on the page instead of jumping to the root.
          await c.call("Page.navigate", { url: `${origin}${prefix}/about` });
          await waitFor(
            `the ${mode} shell at ${prefix}/about`,
            () =>
              js$<boolean>(
                `location.pathname === ${
                  JSON.stringify(prefix + "/about")
                } && document.readyState === "complete" && !!document.querySelector("main")`,
              ),
          );
          assert(
            !(await js$<boolean>(`!!document.querySelector("base")`)),
            `a ${mode} one-level route gets no <base>`,
          );
        }
      };

      // Sub-path first.
      const sub = serveSite(site, "/repo");
      servers.push(sub.server);
      const subOrigin = `http://127.0.0.1:${sub.port}`;
      await c.call("Page.navigate", { url: `${subOrigin}/repo/` });
      await waitFor(
        "<Route path='/'> to render at /repo/",
        () => js$<boolean>(`!!document.getElementById("home")`),
      );
      assertEquals(
        await js$<string>(`document.querySelector("main a").pathname`),
        "/repo/about",
        "<Link> points under the site",
      );
      assertEquals(
        await js$<number>(`fetch("media/hello.txt").then((r) => r.status)`),
        200,
        "the scaffold's relative asset URL reaches the packaged mount",
      );
      await js$(`document.querySelector("main a").click()`);
      await waitFor(
        "<Route path='/about'> after the Link",
        () => js$<boolean>(`!!document.getElementById("about")`),
      );
      assertEquals(await js$<string>(`location.pathname`), "/repo/about");
      // Back: the URL moves AND the route follows (popstate reaches it).
      await js$(`history.back()`);
      await waitFor(
        "<Route path='/'> after Back",
        () => js$<boolean>(`!!document.getElementById("home")`),
      );
      await deepReload(subOrigin, "/repo");

      // Then the origin's root.
      const top = serveSite(site, "");
      servers.push(top.server);
      const topOrigin = `http://127.0.0.1:${top.port}`;
      await c.call("Page.navigate", { url: `${topOrigin}/` });
      await waitFor(
        "<Route path='/'> to render at /",
        () => js$<boolean>(`!!document.getElementById("home")`),
      );
      await deepReload(topOrigin, "");
    } finally {
      await cdp?.close();
      if (browser) await stopChild(browser, { quiet: true });
      for (const s of servers) {
        await s.shutdown();
      }
      await Deno.remove(dir, { recursive: true });
      await dropTempDir(foreign);
      await dropTempDir(profile);
    }
  },
});

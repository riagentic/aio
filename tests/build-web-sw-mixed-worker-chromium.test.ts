// After a deploy, an open tab of the `web` target keeps getting ITS build's
// files (src/build/build-web.ts), run by a REAL Chromium. The new build's
// worker takes over every open tab (skipWaiting + claim); a tab still running
// build A that starts its browser worker later used to get build B's — the
// worker's name hashed its PATH, and A's cache was dropped on B's activate:
// two builds in one page. Now workers are named by content
// (`nameWorkersByContent`), and the activate keeps the build it replaces, which
// the fetch handler answers a miss from. The build after that drops it: two
// builds kept, never three.
//
// Runs when a chromium/chrome binary is on the box; skipped (visibly)
// otherwise. Opt out with AIO_E2E=0.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { nameWorkersByContent, serviceWorker } from "../src/build/build-web.ts";
import { workerBundlesIn } from "../src/server/app-files.ts";
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

/** The worker's name as the bundler writes it: by path, the same every build. */
const W = "worker-w-0123abcd.js";

/** Build `v` into `site`, as the web build lays it out: the bundle names its
 *  worker, which is renamed by content. Returns the worker's file name. */
async function deploy(site: string, v: string): Promise<string> {
  for (const e of Deno.readDirSync(site)) await Deno.remove(join(site, e.name));
  await Deno.writeTextFile(
    join(site, "index.html"),
    SHELL + `<script src="./app.js"></script>`,
  );
  await Deno.writeTextFile(
    join(site, "app.js"),
    `globalThis.BUILD = ${JSON.stringify(v)}; globalThis.W = "./${W}";`,
  );
  await Deno.writeTextFile(join(site, W), `postMessage(${JSON.stringify(v)})`);
  await nameWorkersByContent(site, [W]);
  const files = [...Deno.readDirSync(site)].map((e) => e.name).sort();
  await Deno.writeTextFile(
    join(site, "sw.js"),
    serviceWorker("t", v, [...files, "sw.js"].sort()),
  );
  return workerBundlesIn(await Deno.readTextFile(join(site, "app.js")))[0]!;
}

Deno.test({
  name:
    "web sw (chromium): a tab still running build A after B takes over starts A's worker; the build after drops A",
  ignore: BROWSER === null,
  sanitizeOps: false, // aio-ok(sanitizers): external browser + a static server, both stopped in `finally`
  sanitizeResources: false, // aio-ok(sanitizers): same — the browser child outlives the check
  async fn() {
    const site = await tempDir("aio-web-sw-mix-site-");
    const profile = await tempDir("aio-web-sw-mix-profile-");
    const port = freePort();
    const scope = `http://127.0.0.1:${port}/`;
    const V = (v: string) => `aio-t-${v}@${scope}`;
    const wa = await deploy(site, "A");
    const server = Deno.serve(
      { hostname: "127.0.0.1", port, onListen: () => {} },
      async (req) => {
        let path = new URL(req.url).pathname;
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
      await c.call("Page.navigate", { url: scope });
      await waitFor(
        "build A to control the page",
        () => js<boolean>(`!!navigator.serviceWorker.controller`),
      );
      await c.call("Page.reload", {});
      await waitFor(
        "build A's page, controlled",
        () =>
          js<boolean>(
            `globalThis.BUILD === "A" && !!navigator.serviceWorker.controller`,
          ),
      );
      const update = () =>
        js(`navigator.serviceWorker.getRegistration().then((r) => r.update())`);
      const keys = () => js<string[]>(`caches.keys()`);
      const settled = () =>
        js<boolean>(
          `navigator.serviceWorker.getRegistration().then((r) => !r.installing && !r.waiting && !!r.active && r.active.state === "activated")`,
        );

      const wb = await deploy(site, "B");
      assert(wa !== wb, "a changed worker is another file");
      await update();
      await waitFor(
        "build B to take over",
        async () =>
          (await settled()) &&
          (await js<string>(`navigator.serviceWorker.controller.scriptURL`)) &&
          (await keys()).includes(V("B")),
      );
      const started = await js<string>(
        `new Promise((ok) => { const w = new Worker(globalThis.W); ` +
          `w.onmessage = (e) => ok(globalThis.BUILD + "/" + e.data); ` +
          `w.onerror = () => ok(globalThis.BUILD + "/no worker"); })`,
      );
      assertEquals(started, "A/A", "build A's page starts build A's worker");
      assertEquals(await keys(), [V("A"), V("B")], "the build B replaced kept");

      // C: B is the build it replaces — kept; A is dropped.
      await deploy(site, "C");
      await update();
      await waitFor(
        "build C to take over, A dropped",
        async () =>
          (await settled()) &&
          JSON.stringify(await keys()) === JSON.stringify([V("B"), V("C")]),
      );
    } finally {
      await cdp?.close();
      await stopChild(browser, { quiet: true });
      await server.shutdown();
      await dropTempDir(site);
      await dropBrowserProfile(profile);
    }
  },
});

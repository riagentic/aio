// The `web` target's service worker reuses unchanged asset-mount files across
// deploys (src/build/build-web.ts `reuse`), run by a REAL Chromium. Build B's
// install copies a file from build A's cache only when the STORED bytes hash
// to B's digest; everything else is fetched as before:
//   - unchanged packs: 0 downloads; the changed one: 1;
//   - a host that rewrites an image (stored bytes ≠ build digest): fetched
//     again, never reused, still offline;
//   - a file over the reuse cap (16 MiB): fetched;
//   - a cache made AFTER this build's (a newer build installing while this one
//     activates) survives the activate; the older build's is dropped;
//   - storage too small for the next build's copies: its install fails, the
//     current build keeps serving, whole.
//
// Runs when a chromium/chrome binary is on the box; skipped (visibly)
// otherwise.
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

/** `n` bytes that differ per `seed`, incompressible. */
function bytes(n: number, seed: number): Uint8Array {
  let x = seed | 1;
  return new Uint8Array(n).map(() => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return x & 255;
  });
}

async function b64sha(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(
    await crypto.subtle.digest("SHA-256", b as Uint8Array<ArrayBuffer>),
  );
  return btoa(String.fromCharCode(...d));
}

/** Replace the site with build `version`: the shell + app.js, and the asset
 *  files `assets`, digested as `buildWeb` digests them. */
async function deploy(
  site: string,
  version: string,
  app: string,
  assets: Record<string, Uint8Array>,
): Promise<void> {
  await Deno.remove(site, { recursive: true });
  await Deno.mkdir(join(site, "packs"), { recursive: true });
  await Deno.writeTextFile(join(site, "index.html"), SHELL);
  await Deno.writeTextFile(join(site, "app.js"), app);
  const digests: Record<string, string> = {};
  for (const [f, b] of Object.entries(assets)) {
    await Deno.writeFile(join(site, f), b);
    digests[f] = await b64sha(b);
  }
  const names = Object.keys(assets).sort();
  await Deno.writeTextFile(
    join(site, "sw.js"),
    serviceWorker(
      "t",
      version,
      ["app.js", "index.html", ...names],
      {},
      names,
      digests,
    ),
  );
}

Deno.test({
  name:
    "web sw (chromium): a deploy downloads only the asset files whose bytes changed; a newer build's cache survives the activate",
  ignore: BROWSER === null,
  sanitizeOps: false, // aio-ok(sanitizers): external browser + a static server, both stopped in `finally`
  sanitizeResources: false, // aio-ok(sanitizers): same — the browser child outlives the check
  async fn() {
    const site = await tempDir("aio-web-reuse-site-");
    const profile = await tempDir("aio-web-reuse-profile-");
    const port = freePort();
    const gets = new Map<string, number>();
    /** Held until released: a slow file keeps an install open. */
    let hold: { path: string; until: Promise<void> } | null = null;
    let server: Deno.HttpServer | undefined = Deno.serve(
      { hostname: "127.0.0.1", port, onListen: () => {} },
      async (req) => {
        let path = decodeURIComponent(new URL(req.url).pathname);
        if (path.endsWith("/")) path += "index.html";
        gets.set(path, (gets.get(path) ?? 0) + 1);
        if (hold?.path === path) await hold.until;
        try {
          const raw = await Deno.readFile(join(site, path));
          // An image optimizer: the host serves other bytes than the build's.
          const body = path.endsWith(".png")
            ? new Uint8Array([...raw, 33])
            : raw;
          return new Response(body, {
            headers: {
              "content-type": path.endsWith(".html")
                ? "text/html"
                : path.endsWith(".js")
                ? "text/javascript"
                : "application/octet-stream",
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
      const scope = `http://127.0.0.1:${port}/`;
      const V = (v: string) => `aio-t-${v}@${scope}`;
      /** The SHA-256 of what build `v`'s cache holds for `f`, or null. */
      const held = (v: string, f: string) =>
        js<string | null>(
          `caches.open(${JSON.stringify(V(v))}).then((c) => c.match(${
            JSON.stringify(f)
          })).then((r) => r ? r.arrayBuffer().then((b) => crypto.subtle.digest("SHA-256", b)).then((d) => btoa(String.fromCharCode(...new Uint8Array(d)))) : null)`,
        );
      const settled = () =>
        js<boolean>(
          `navigator.serviceWorker.getRegistration().then((r) => !r.installing && !r.waiting)`,
        );
      const update = () =>
        js(`navigator.serviceWorker.getRegistration().then((r) => r.update())`)
          .catch(() => {}); // a refused install may reject — asserted below

      const p1 = bytes(300_000, 1), p2 = bytes(300_000, 2);
      const big = bytes(17 * 1024 * 1024, 3); // over the 16 MiB reuse cap
      const img = bytes(1000, 4);
      await deploy(site, "a", "A", {
        "packs/p1.bin": p1,
        "packs/p2.bin": p2,
        "packs/big.bin": big,
        "packs/img.png": img,
      });
      await c.call("Page.navigate", { url: scope });
      await waitFor(
        "build A to control the page",
        () => js<boolean>(`!!navigator.serviceWorker.controller`),
      );

      // ── B: p2 changed, the rest as it was ─────────────────────────────
      const p2b = bytes(300_000, 22);
      await deploy(site, "b", "B", {
        "packs/p1.bin": p1,
        "packs/p2.bin": p2b,
        "packs/big.bin": big,
        "packs/img.png": img,
      });
      gets.clear();
      await update();
      await waitFor(
        "build B's cache to be the only one",
        async () =>
          JSON.stringify(await js<string[]>(`caches.keys()`)) ===
            JSON.stringify([V("b")]),
      );
      assertEquals(gets.get("/packs/p1.bin") ?? 0, 0, "unchanged: copied");
      assertEquals(gets.get("/packs/p2.bin"), 1, "changed: downloaded");
      assertEquals(gets.get("/packs/big.bin"), 1, "over the cap: downloaded");
      assertEquals(
        gets.get("/packs/img.png"),
        1,
        "the host's bytes are not the build's: downloaded, never reused",
      );
      assertEquals(await held("b", "./packs/p1.bin"), await b64sha(p1));
      assertEquals(await held("b", "./packs/p2.bin"), await b64sha(p2b));
      assert(await held("b", "./packs/img.png"), "the rewritten image cached");

      // ── C, with a slow file: a cache made after C's own, while C installs,
      //    is a NEWER build's — C's activate leaves it; B's goes ───────────
      let release = () => {};
      hold = {
        path: "/packs/p2.bin",
        until: new Promise<void>((r) => release = r),
      };
      await deploy(site, "c", "C", {
        "packs/p1.bin": p1,
        "packs/p2.bin": bytes(300_000, 23),
        "packs/big.bin": big,
        "packs/img.png": img,
      });
      void update();
      await waitFor(
        "build C's install to hold its cache",
        async () => (await js<string[]>(`caches.keys()`)).includes(V("c")),
      );
      await js(`caches.open(${JSON.stringify(V("newer"))}).then(() => 1)`);
      release();
      hold = null;
      await waitFor("C to activate", async () => {
        const ks = await js<string[]>(`caches.keys()`);
        return !ks.includes(V("b")) && (await settled());
      });
      assertEquals(
        await js<string[]>(`caches.keys()`),
        [V("c"), V("newer")],
        "the older build dropped, the newer cache kept",
      );
      await js(`caches.delete(${JSON.stringify(V("newer"))})`);

      // ── D, with storage too small for its copies: not installed, loudly;
      //    C keeps serving, whole ─────────────────────────────────────────
      await c.call("Storage.overrideQuotaForOrigin", {
        origin: `http://127.0.0.1:${port}`,
        quotaSize: 1_000_000,
      });
      await deploy(site, "d", "D", {
        "packs/p1.bin": p1,
        "packs/p2.bin": bytes(300_000, 24),
        "packs/big.bin": big,
        "packs/img.png": img,
      });
      await update();
      await waitFor("D's install to end", settled);
      assertEquals(
        await js<string>(`fetch("./app.js").then((r) => r.text())`),
        "C",
        "build C keeps serving",
      );
      assertEquals(await held("c", "./packs/p1.bin"), await b64sha(p1));
      await c.call("Storage.overrideQuotaForOrigin", {
        origin: `http://127.0.0.1:${port}`,
      });

      // Offline, C's files are served from its cache.
      await server.shutdown();
      server = undefined;
      assertEquals(
        await js<number>(
          `fetch("./packs/p1.bin").then((r) => r.arrayBuffer()).then((b) => b.byteLength)`,
        ),
        p1.length,
      );
    } finally {
      await cdp?.close();
      await stopChild(browser, { quiet: true });
      await server?.shutdown();
      await dropTempDir(site);
      await dropBrowserProfile(profile);
    }
  },
});

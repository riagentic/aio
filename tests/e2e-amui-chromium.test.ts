// Tier-3 e2e — the visual app manager (`amui`) in a REAL browser.
//
// amui is the one app in this repo that reaches into the framework's own
// source through relative `*.server.ts` re-exports, and that made it the first
// app to hit a validator that read the framework's HTML template as browser
// code: `await import('/app.js')` inside a template literal in
// `server-html-gen.ts` was reported as a missing import-map entry, the dev
// server served the diagnostic page, and every gate stayed green — no test
// ever opened amui in a browser. This one does: boot it exactly as
// `deno task amui --client=browser` would, open the page in headless chromium,
// and require the manager's own sidebar (its Rescan button) on the live
// surface — the diagnostic page has no such element. Then click it, through the
// same trojan route `am trigger` uses, and require the click to land.
//
// Runs automatically when a chromium/chrome binary is on the box; skipped
// (visibly) otherwise. Opt out with AIO_E2E=0.
import { assert } from "@std/assert";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { stopChild } from "./stop-child.ts";
import {
  childCoverageDir,
  dropTempDir,
  tempDir,
} from "../src/testing/temp-dir.ts";
const _childCovDir = childCoverageDir();

const ROOT = new URL("..", import.meta.url).pathname;

function findBrowser(): string | null {
  if (Deno.env.get("AIO_E2E") === "0") return null;
  const fromEnv = Deno.env.get("AIO_E2E_BROWSER");
  const candidates = fromEnv ? [fromEnv] : [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  for (const c of candidates) {
    try {
      Deno.statSync(c);
      return c;
    } catch { /* not this one */ }
  }
  return null;
}

const BROWSER = findBrowser();

function freePort(): number {
  const l = Deno.listen({ port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

async function waitFor<T>(
  what: string,
  fn: () => Promise<T | null>,
  timeoutMs = 45_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout waiting for ${what}`);
}

type SurfaceEl = { name: string; path: string; text?: string };
type SurfaceNode = {
  component: string;
  elements: SurfaceEl[];
  children: SurfaceNode[];
};

function findEl(
  roots: SurfaceNode[],
  pred: (e: SurfaceEl) => boolean,
): SurfaceEl | null {
  const stack = [...roots];
  while (stack.length) {
    const n = stack.pop()!;
    for (const e of n.elements) if (pred(e)) return e;
    stack.push(...n.children);
  }
  return null;
}

Deno.test({
  name: "e2e: amui in real chromium — the manager UI mounts, and Rescan lands",
  ignore: BROWSER === null,
  // The browser and app are external processes — Deno's sanitizers can't see
  // their lifecycles; both are killed in finally blocks below.
  async fn() {
    const port = freePort();
    const base = `http://localhost:${port}`;
    // amui's own data dir (and singleton lock), kept out of the developer's
    // real ~/.amui — a manager they may have open.
    const home = await tempDir("aio-e2e-amui-home-");
    const app = new Deno.Command(Deno.execPath(), {
      env: {
        DENO_COVERAGE_DIR: _childCovDir,
        AIO_APPS_DIR: home,
        ...testDisplayEnv(),
      },
      args: [
        "run",
        "-A",
        "src/app.ts",
        "--client=browser",
        `--port=${port}`,
      ],
      cwd: `${ROOT}amui`,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();

    const profile = await tempDir("aio-e2e-amui-");
    let browser: Deno.ChildProcess | null = null;
    try {
      await waitFor("amui server", async () => {
        const res = await fetch(`${base}/`);
        await res.body?.cancel();
        return res.ok ? true : null;
      });
      // The verdict, not a guess from HTML. Boot validation is async and `/`
      // is the app until it lands — a browser opened too early would pass this
      // test against the very bug it exists for.
      const graph = await waitFor("graph verdict", async () => {
        const res = await fetch(`${base}/__aio/trojan/graph`);
        const g = await res.json() as {
          pending: boolean;
          valid: boolean | null;
          errors: { file: string; message: string; deferred: boolean }[];
        };
        return g.pending ? null : g;
      });
      assert(
        graph.valid === true,
        "the dev server must serve amui, not the diagnostic page:\n" +
          graph.errors.filter((e) => !e.deferred).map((e) =>
            `  ${e.file} — ${e.message}`
          ).join("\n"),
      );

      browser = new Deno.Command(BROWSER!, {
        args: [
          "--headless=new",
          "--no-sandbox",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          `--password-store=basic`,
          `--use-mock-keychain`,
          `--user-data-dir=${profile}`,
          `${base}/`,
        ],
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn();

      const clientIdx = await waitFor("browser app client", async () => {
        const res = await fetch(`${base}/__aio/trojan/clients`);
        const clients = await res.json() as { index: number; type: string }[];
        return clients.find((c) => c.type === "browser")?.index ?? null;
      });

      // The manager's sidebar on the LIVE surface. The diagnostic page — what
      // amui was served for two releases — mounts nothing the surface can see.
      const roots = await waitFor("amui sidebar on the surface", async () => {
        const res = await fetch(`${base}/__aio/trojan/surface/${clientIdx}`);
        if (!res.ok) {
          await res.body?.cancel();
          return null;
        }
        const data = await res.json() as SurfaceNode[];
        return Array.isArray(data) &&
            findEl(data, (e) => (e.text ?? "").includes("Rescan"))
          ? data
          : null;
      });
      const rescan = findEl(roots, (e) => (e.text ?? "").includes("Rescan"))!;
      const res = await fetch(`${base}/__aio/trojan/trigger/${clientIdx}`, {
        method: "POST",
        headers: { "x-aio": "1", "content-type": "application/json" },
        body: JSON.stringify({ path: rescan.path, action: "click" }),
      });
      const reply = await res.json() as {
        ok: boolean;
        error?: string;
        surface?: SurfaceNode[];
      };
      assert(reply.ok, `Rescan click failed: ${reply.error}`);
      assert(
        reply.surface && reply.surface.length > 0,
        "the reply carries the fresh post-action surface",
      );
    } finally {
      if (browser) await stopChild(browser, { quiet: true });
      await stopChild(app, { quiet: true });
      await dropTempDir(profile);
      await dropTempDir(home);
    }
  },
});

// Tier-3 e2e — the semantic UI-testing stack against a REAL browser.
// Boots examples/counter, opens it in headless chromium, then drives the live
// UI purely through the framework's own protocol (trojan surface/trigger —
// exactly what `am surface`/`am trigger` and AI agents use): observe the
// surface, click Reset and "+" with faithful event sequences inside the real
// page, and verify the server's cell state converged. No webdriver, no CDP.
//
// Runs automatically when a chromium/chrome binary is on the box; skipped
// (visibly) otherwise. Opt out with AIO_E2E=0.
import { assert, assertEquals } from "@std/assert";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { stopChild } from "./stop-child.ts";

// Coverage profiles from spawned deno processes go to a throwaway temp dir —
// never into the repo (an empty DENO_COVERAGE_DIR means "cwd"), never into
// the parent's coverage profile.
const _childCovDir = Deno.env.get("DENO_COVERAGE_DIR") ??
  Deno.makeTempDirSync({ prefix: "aio-child-cov-" });

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
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout waiting for ${what}`);
}

async function kill(proc: Deno.ChildProcess): Promise<void> {
  await stopChild(proc, { quiet: true });
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
  name: "e2e: real chromium — surface → trigger → server state converges",
  ignore: BROWSER === null,
  // The browser and app are external processes — Deno's sanitizers can't see
  // their lifecycles; both are killed in finally blocks below.
  async fn() {
    const port = freePort();
    const base = `http://localhost:${port}`;
    const app = new Deno.Command(Deno.execPath(), {
      env: { DENO_COVERAGE_DIR: _childCovDir, ...testDisplayEnv() },
      args: [
        "run",
        "-A",
        "--unstable-kv",
        "app.ts",
        "--client=server-only",
        `--port=${port}`,
      ],
      cwd: `${ROOT}examples/counter`,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();

    const profile = await Deno.makeTempDir({ prefix: "aio-e2e-chromium-" });
    let browser: Deno.ChildProcess | null = null;
    try {
      await waitFor("counter server", async () => {
        const res = await fetch(`${base}/`);
        await res.body?.cancel();
        return res.ok ? true : null;
      });

      browser = new Deno.Command(BROWSER!, {
        args: [
          "--headless=new",
          "--no-sandbox",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          `--user-data-dir=${profile}`,
          `${base}/`,
        ],
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn();

      // The dev-reload socket also connects — find the tab's APP client
      // (type "browser") instead of assuming index 0.
      const clientIdx = await waitFor("browser app client", async () => {
        const res = await fetch(`${base}/__aio/trojan/clients`);
        const clients = await res.json() as { index: number; type: string }[];
        return clients.find((c) => c.type === "browser")?.index ?? null;
      });

      // Observe: poll the semantic surface until the page mounted and shows
      // the counter UI.
      const roots = await waitFor("mounted UI surface", async () => {
        const res = await fetch(`${base}/__aio/trojan/surface/${clientIdx}`);
        if (!res.ok) {
          await res.body?.cancel();
          return null;
        }
        const data = await res.json() as SurfaceNode[];
        return Array.isArray(data) && findEl(data, (e) => e.text === "+")
          ? data
          : null;
      });

      const trigger = async (path: string) => {
        const res = await fetch(`${base}/__aio/trojan/trigger/${clientIdx}`, {
          method: "POST",
          headers: { "x-aio": "1", "content-type": "application/json" },
          body: JSON.stringify({ path, action: "click" }),
        });
        return await res.json() as {
          ok: boolean;
          error?: string;
          surface?: SurfaceNode[];
        };
      };
      const serverCount = async (): Promise<number> => {
        const res = await fetch(`${base}/__aio/trojan/state`);
        const state = await res.json() as { counter?: { count?: number } };
        return state.counter?.count ?? NaN;
      };

      // Act: reset to a known state, then increment — real events inside the
      // real page, addressed by semantic name, no selectors anywhere.
      const reset = findEl(roots, (e) => e.name === "ResetButton");
      const plus = findEl(roots, (e) => e.text === "+");
      assert(reset && plus, "ResetButton and + must be on the surface");

      const r1 = await trigger(reset.path);
      assert(r1.ok, `reset click failed: ${r1.error}`);
      await waitFor(
        "count 0 on server",
        async () => (await serverCount()) === 0 ? true : null,
      );

      const r2 = await trigger(plus.path);
      assert(r2.ok, `+ click failed: ${r2.error}`);
      // The trigger reply carries the fresh post-action surface (the AI loop) —
      // and the server cell must have converged through the real WS round-trip.
      assert(r2.surface && r2.surface.length > 0, "fresh surface in reply");
      await waitFor(
        "count 1 on server",
        async () => (await serverCount()) === 1 ? true : null,
      );
      assertEquals(await serverCount(), 1);
    } finally {
      if (browser) await kill(browser);
      await kill(app);
      await Deno.remove(profile, { recursive: true }).catch(() => {});
    }
  },
});

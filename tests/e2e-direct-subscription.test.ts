// a field report — CRITICAL regression: a server-initiated state change to a
// cell read via DIRECT cell access must reach the viewing client.
//
// The bug: direct cell access (`data.n`) registered an AIR re-render dependency
// but NOT a server subscription (trackPath). So the moment a component narrowed
// the client's subscription to a partial set (e.g. `useCell(nav)` for another
// cell), a directly-read cell silently stopped receiving server deltas — its
// signal never changed, freezing the UI at the connect-time value. The
// in-process harness (testUI/testCell) cannot catch this: the harness client IS
// the server, so there is no subscription-filtering boundary. This is a
// transport-faithful e2e — real server + real Chromium + a server scheduler.
import { assert } from "@std/assert";

const _childCovDir = Deno.env.get("DENO_COVERAGE_DIR") ??
  Deno.makeTempDirSync({ prefix: "aio-child-cov-" });
const ROOT = new URL("..", import.meta.url).pathname;

function findBrowser(): string | null {
  if (Deno.env.get("AIO_E2E") === "0") return null;
  for (
    const c of [
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
    ]
  ) {
    try {
      Deno.statSync(c);
      return c;
    } catch { /* next */ }
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
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout: ${what}`);
}

// deno-lint-ignore no-explicit-any
function findText(nodes: any[], t: string): string | null {
  for (const n of nodes ?? []) {
    for (const el of n.elements ?? []) if (el.name === t) return el.text;
    const c = findText(n.children ?? [], t);
    if (c !== null) return c;
  }
  return null;
}

Deno.test({
  name:
    "e2e: server-initiated change to a directly-read cell reaches a partially-subscribed client",
  ignore: BROWSER === null,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "aio-directsub-" });
    await Deno.mkdir(`${dir}/src`);
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({
        title: "DirectSub Probe",
        nodeModulesDir: "auto",
        unstable: ["kv"],
        compilerOptions: {
          jsx: "react-jsx",
          jsxImportSource: "aio",
          lib: ["deno.ns", "deno.unstable", "dom", "dom.iterable"],
        },
        imports: {
          "aio": `${ROOT}mod.ts`,
          "aio/air": `${ROOT}src/air.ts`,
          "aio/jsx-runtime": `${ROOT}src/jsx-runtime.ts`,
          "immer": "npm:immer@10.2.0",
          "@std/path": "jsr:@std/path@^1",
        },
      }),
    );
    await Deno.writeTextFile(
      `${dir}/src/cells.ts`,
      `import { cell } from "aio";
export const data = cell("data", { state: { n: 0 }, methods: { adjust(s, by) { s.n += by; } } });
export const nav = cell("nav", { state: { panel: "home" }, methods: { go(s, p) { s.panel = p; } } });`,
    );
    await Deno.writeTextFile(
      `${dir}/src/App.tsx`,
      `import { data, nav } from "./cells.ts";
// Direct reads narrow this client's server subscription to exactly the cells
// the page reads (alpha52: useCell was removed — direct access is the idiom).
// data.n is server-driven — it must keep receiving live deltas.
export default function App() {
  return (<div><span t="panel">{nav.panel}</span><span t="nval">{String(data.n)}</span></div>);
}`,
    );
    await Deno.writeTextFile(
      `${dir}/src/app.ts`,
      `import { data } from "./cells.ts";
import "./cells.ts";
import { aio } from "aio";
// SERVER-INITIATED change — nothing the client dispatched.
await aio.run({ persist: false, schedules: [{ id: "tick", every: 600, action: data.adjust.action(1) }] });`,
    );

    const port = freePort();
    const base = `http://localhost:${port}`;
    const proc = new Deno.Command(Deno.execPath(), {
      env: { DENO_COVERAGE_DIR: _childCovDir },
      args: [
        "run",
        "-A",
        "--unstable-kv",
        "src/app.ts",
        "--client=server-only",
        `--port=${port}`,
      ],
      cwd: dir,
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();

    const profile = await Deno.makeTempDir({ prefix: "aio-directsub-prof-" });
    let browser: Deno.ChildProcess | null = null;
    try {
      await waitFor("server up", async () => {
        const r = await fetch(`${base}/`);
        await r.body?.cancel();
        return r.ok ? true : null;
      }, 120_000);

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

      const idx = await waitFor("browser client", async () => {
        const cs = await (await fetch(`${base}/__aio/trojan/clients`))
          .json() as { index: number; type: string }[];
        return cs.find((c) => c.type === "browser")?.index ?? null;
      });
      const clientN = async () => {
        const res = await fetch(`${base}/__aio/trojan/surface/${idx}`);
        if (!res.ok) {
          await res.body?.cancel();
          return null;
        }
        return findText(await res.json(), "nval");
      };
      const serverN = async () => {
        const s = await (await fetch(`${base}/__aio/trojan/state`)).json() as {
          data?: { n?: number };
        };
        return s.data?.n ?? NaN;
      };

      await waitFor("mounted", async () => (await clientN()) !== null);

      // The server scheduler increments data.n independently. The client reads
      // it via direct access with a subscription narrowed to the cells it reads.
      // The client DOM must climb with the server — not freeze at 0.
      await waitFor(
        "client tracks server-initiated data change",
        async () => {
          const cn = await clientN();
          const sn = await serverN();
          return sn >= 3 && cn === String(sn) ? true : null;
        },
        15_000,
      );

      const cn = await clientN();
      const sn = await serverN();
      assert(
        Number(cn) >= 3 && cn === String(sn),
        `directly-read cell must receive server deltas: server=${sn}, client=${cn}`,
      );
    } finally {
      try {
        browser?.kill();
      } catch { /* exited */ }
      if (browser) await browser.status;
      try {
        proc.kill();
      } catch { /* exited */ }
      await proc.status;
      await Deno.remove(profile, { recursive: true }).catch(() => {});
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

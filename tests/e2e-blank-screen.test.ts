// Blank-screen guard e2e — the #1 historical failure class. A broken app
// must NEVER be a silent white page in dev: the boot script catches every
// failure stage (import error, missing default export, empty render, state
// timeout), renders an in-page diagnostic, and reports to the server so the
// terminal says why. Proven against real chromium.
import { assert, assertStringIncludes } from "@std/assert";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { stopChild } from "./stop-child.ts";

// Coverage profiles from spawned deno processes go to a throwaway temp dir.
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
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout: ${what}`);
}

/** Scaffold a minimal probe app and boot its server; caller owns cleanup. */
async function bootProbe(appTsx: string): Promise<{
  dir: string;
  port: number;
  proc: Deno.ChildProcess;
  logRef: { buf: string };
}> {
  const dir = await Deno.makeTempDir({ prefix: "aio-blank-" });
  await Deno.mkdir(`${dir}/src`);
  await Deno.writeTextFile(
    `${dir}/deno.json`,
    JSON.stringify({
      title: "Blank Probe",
      nodeModulesDir: "auto",
      unstable: ["kv"],
      compilerOptions: {
        jsx: "react-jsx",
        jsxImportSource: "aio",
        lib: ["deno.ns", "deno.unstable", "dom", "dom.iterable"],
      },
      imports: {
        "aio": `${ROOT}mod.ts`,
        "aio/jsx-runtime": `${ROOT}src/jsx-runtime.ts`,
        "immer": "npm:immer@10.2.0",
        "@std/path": "jsr:@std/path@^1",
      },
    }),
  );
  await Deno.writeTextFile(
    `${dir}/src/cell.ts`,
    `import { cell } from "aio";
export const c = cell("probe", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });`,
  );
  await Deno.writeTextFile(`${dir}/src/App.tsx`, appTsx);
  await Deno.writeTextFile(
    `${dir}/src/app.ts`,
    `import "./cell.ts";\nimport { aio } from "aio";\nawait aio.run();`,
  );

  const port = freePort();
  const proc = new Deno.Command(Deno.execPath(), {
    env: { DENO_COVERAGE_DIR: _childCovDir, ...testDisplayEnv() },
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
    stdout: "piped",
    // BOTH streams. The blank-screen guard warns, and a warning goes to
    // STDERR now (the level picks the stream) — a probe that reads stdout
    // alone sees an app that said nothing and calls that a pass.
    stderr: "piped",
  }).spawn();

  const logRef = { buf: "" };
  const dec = new TextDecoder();
  (async () => {
    for await (const chunk of proc.stdout) logRef.buf += dec.decode(chunk);
  })();
  (async () => {
    for await (const chunk of proc.stderr) logRef.buf += dec.decode(chunk);
  })();
  await waitFor("server up", async () => {
    const res = await fetch(`http://localhost:${port}/__aio/health`);
    await res.body?.cancel();
    return res.ok ? true : null;
  });
  return { dir, port, proc, logRef };
}

/** Boot a probe app, load it in dump-dom chromium (failure path), return
 *  the rendered DOM + server log; cleans up everything. */
async function renderBroken(appTsx: string): Promise<{
  dom: string;
  log: string;
}> {
  const { dir, port, proc, logRef } = await bootProbe(appTsx);
  try {
    const profile = await Deno.makeTempDir({ prefix: "aio-blank-prof-" });
    const chrome = await new Deno.Command(BROWSER!, {
      args: [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        `--user-data-dir=${profile}`,
        // fast-forwards timers so the sync overlay is present at dump time;
        // WS state round-trips do NOT complete under virtual time, so this
        // path is for FAILURE cases only (see the live healthy test).
        "--virtual-time-budget=8000",
        "--dump-dom",
        `http://localhost:${port}/`,
      ],
      stdout: "piped",
      stderr: "null",
    }).output();
    await Deno.remove(profile, { recursive: true }).catch(() => {});
    // give the client-error POST a beat to land in the server log
    await new Promise((r) => setTimeout(r, 500));
    return { dom: new TextDecoder().decode(chrome.stdout), log: logRef.buf };
  } finally {
    await stopChild(proc, { quiet: true });
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test({
  name:
    "blank-screen guard: broken import → in-page diagnostic + terminal warning",
  ignore: BROWSER === null,
  async fn() {
    const { dom, log } = await renderBroken(
      `import { nope } from "./does-not-exist.ts";
export default function App() { return <div>{String(nope)}</div>; }`,
    );
    // Layered capture: broken imports are caught even EARLIER than the boot
    // guard — the dev server's graph validator serves a diagnostic page
    // instead of the app. Either layer means: never a silent white page.
    assert(
      dom.includes("Module Errors") || dom.includes("data-aio-blank-screen"),
      `expected the graph-validator page or the boot overlay, got:\n${
        dom.slice(0, 400)
      }`,
    );
  },
});

Deno.test({
  name: "blank-screen guard: missing default export → named, actionable error",
  ignore: BROWSER === null,
  async fn() {
    const { dom, log } = await renderBroken(
      `export function App() { return <div>hi</div>; } // note: NOT default`,
    );
    // Either the in-page overlay, or (alpha70+) the diagnostic page the
    // prod-graph gate serves before anything renders.
    assert(
      dom.includes("data-aio-blank-screen") || dom.includes("Module Errors"),
      "the page names the failure",
    );
    // The prod-graph gate (alpha70+) refuses this at boot, before any
    // render: the diagnostic page and the log both name the missing export.
    const all = log + dom;
    assert(
      /no default export/i.test(all) || all.includes('for import "default"'),
      "the missing default export is named",
    );
    // …and, since alpha74, the EDIT is named too. esbuild reports this against
    // its own generated entry — a file the user never wrote — and the generic
    // fix line explained the mechanism rather than what to type.
    assert(
      all.includes("export default function App()") ||
        all.includes("export default App;"),
      `the fix must be an edit that can be typed, got:\n${all.slice(0, 600)}`,
    );
  },
});

Deno.test({
  name: "blank-screen guard: App renders nothing → empty-render diagnostic",
  ignore: BROWSER === null,
  async fn() {
    // Needs the real WS state round-trip (dump-dom can't await it) — live
    // chromium; the guard's report to the server is the assertion.
    const { dir, port, proc, logRef } = await bootProbe(
      "export default function App() { return null; }",
    );
    const profile = await Deno.makeTempDir({ prefix: "aio-blank-prof-" });
    const chrome = new Deno.Command(BROWSER!, {
      args: [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        `--user-data-dir=${profile}`,
        `http://localhost:${port}/`,
      ],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      await waitFor(
        "empty-render warning in the terminal",
        // deno-lint-ignore require-await
        async () =>
          logRef.buf.includes("BLANK SCREEN (empty render)") ? true : null,
      );
    } finally {
      await stopChild(chrome, { quiet: true });
      await Deno.remove(profile, { recursive: true }).catch(() => {});
      await stopChild(proc, { quiet: true });
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "blank-screen guard: a HEALTHY app mounts with no overlay, no warning",
  ignore: BROWSER === null,
  async fn() {
    // Live chromium (dump-dom can't await WS state) — the semantic surface
    // proves the app mounted; the server log proves no false positive.
    const { dir, port, proc, logRef } = await bootProbe(
      `export default function App() {
  return <button onClick={() => {}}>alive</button>;
}`,
    );
    const profile = await Deno.makeTempDir({ prefix: "aio-blank-prof-" });
    const chrome = new Deno.Command(BROWSER!, {
      args: [
        "--headless=new",
        "--no-sandbox",
        "--disable-gpu",
        "--disable-dev-shm-usage",
        `--user-data-dir=${profile}`,
        `http://localhost:${port}/`,
      ],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      // app client connects + surface shows the mounted button
      await waitFor("mounted surface", async () => {
        const cs = await (await fetch(
          `http://localhost:${port}/__aio/trojan/clients`,
        )).json() as { index: number; type: string }[];
        const app = cs.find((c) => c.type === "browser");
        if (!app) return null;
        const res = await fetch(
          `http://localhost:${port}/__aio/trojan/surface/${app.index}`,
        );
        if (!res.ok) {
          await res.body?.cancel();
          return null;
        }
        const surf = JSON.stringify(await res.json());
        return surf.includes("AliveButton") ? true : null;
      });
      assert(!logRef.buf.includes("BLANK SCREEN"), "no warning when healthy");
    } finally {
      await stopChild(chrome, { quiet: true });
      await Deno.remove(profile, { recursive: true }).catch(() => {});
      await stopChild(proc, { quiet: true });
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

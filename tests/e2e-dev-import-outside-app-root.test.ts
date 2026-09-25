// Real chromium, real dev server: an app whose entry is one level down
// (`src/pro/app.ts`) and whose App.tsx imports shared UI beside it
// (`../ui/Shell.tsx`) MOUNTS in dev — as its production bundle always did.
// Field report: the page died with "blank screen (boot): TypeError: Failed to
// fetch dynamically imported module", because the browser clamps
// `../ui/Shell.tsx` from `/App.tsx` to `/ui/Shell.tsx` (= `src/pro/ui/…`).
import { assert } from "@std/assert";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { stopChild } from "./stop-child.ts";
import { childCoverageDir, tempDir } from "../src/testing/temp-dir.ts";
import { freePort } from "../src/testing/server-test.ts";
const _childCovDir = childCoverageDir();

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

Deno.test({
  name:
    "e2e dev: entry src/pro/app.ts importing ../ui/Shell.tsx mounts in a real browser (no blank screen)",
  ignore: BROWSER === null,
  async fn() {
    const dir = await tempDir("aio-outside-root-e2e-");
    await Deno.mkdir(`${dir}/src/pro`, { recursive: true });
    await Deno.mkdir(`${dir}/src/ui`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({
        title: "Notes",
        entry: "src/pro/app.ts",
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
      `${dir}/src/pro/cell.ts`,
      `import { cell } from "aio";
export const c = cell("probe", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });`,
    );
    await Deno.writeTextFile(
      `${dir}/src/pro/App.tsx`,
      `import { Shell } from "../ui/Shell.tsx";
export default function App() { return <Shell />; }`,
    );
    await Deno.writeTextFile(
      `${dir}/src/ui/Shell.tsx`,
      `export function Shell() { return <button onClick={() => {}}>shared</button>; }`,
    );
    await Deno.writeTextFile(
      `${dir}/src/pro/app.ts`,
      `import "./cell.ts";\nimport { aio } from "aio";\nawait aio.run();`,
    );

    const port = freePort();
    const proc = new Deno.Command(Deno.execPath(), {
      env: { DENO_COVERAGE_DIR: _childCovDir, ...testDisplayEnv() },
      args: [
        "run",
        "-A",
        "--unstable-kv",
        "src/pro/app.ts",
        "--client=server-only",
        `--port=${port}`,
      ],
      cwd: dir,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let log = "";
    const dec = new TextDecoder();
    (async () => {
      for await (const c of proc.stdout) log += dec.decode(c);
    })();
    (async () => {
      for await (const c of proc.stderr) log += dec.decode(c);
    })();

    const until = async (what: string, fn: () => Promise<boolean>) => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (log.includes("BLANK SCREEN")) {
          throw new Error(`the page blank-screened:\n${log.slice(-2000)}`);
        }
        if (await fn().catch(() => false)) return;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error(`timeout: ${what}\n${log.slice(-2000)}`);
    };

    let chrome: Deno.ChildProcess | null = null;
    const profile = await tempDir("aio-outside-root-prof-");
    try {
      await until("server up", async () => {
        const r = await fetch(`http://localhost:${port}/__aio/health`);
        await r.body?.cancel();
        return r.ok;
      });
      chrome = new Deno.Command(BROWSER!, {
        args: [
          "--headless=new",
          "--no-sandbox",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          `--password-store=basic`,
          `--use-mock-keychain`,
          `--user-data-dir=${profile}`,
          `http://localhost:${port}/`,
        ],
        stdin: "null",
        stdout: "null",
        stderr: "null",
      }).spawn();
      await until("the shared Shell mounted", async () => {
        const cs = await (await fetch(
          `http://localhost:${port}/__aio/trojan/clients`,
        )).json() as { index: number; type: string }[];
        const app = cs.find((c) => c.type === "browser");
        if (!app) return false;
        const res = await fetch(
          `http://localhost:${port}/__aio/trojan/surface/${app.index}`,
        );
        if (!res.ok) {
          await res.body?.cancel();
          return false;
        }
        return JSON.stringify(await res.json()).includes("SharedButton");
      });
      assert(!log.includes("BLANK SCREEN"), "no blank screen");
    } finally {
      if (chrome) await stopChild(chrome, { quiet: true });
      await Deno.remove(profile, { recursive: true }).catch(() => {});
      await stopChild(proc, { quiet: true });
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

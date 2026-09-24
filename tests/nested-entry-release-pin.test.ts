// remote-desktop field report §1 (v1.0.9-beta): an entry two folders deep —
// `src/agent/app.ts`, the layout docs/build/targets.md recommends for two apps
// of one kind — made the dev server serve the DIAGNOSTIC PAGE for the whole
// app. The prod-bundle check looked for deno.json in the UI folder and ONE
// folder up only, so it bundled from `src/agent/` with no imports and no
// node_modules; against a RELEASE pin (a framework copy that has no
// node_modules of its own) esbuild could not resolve `immer`, and the message
// claimed `deno task build` would fail — which it did not.
//
// It hid because a `path:` pin to a checkout HAS node_modules, and esbuild
// found `immer` walking up from the framework's own files. So this fixture is
// the shape that exposed it, not the repo: the framework is COPIED to a
// directory with no node_modules, the app pins it by relative imports (as an
// installed release is pinned), and `immer` exists only in the APP's
// node_modules — where the real build finds it.

import { assert, assertEquals } from "@std/assert";
import { dirname, join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { childCoverageDir, tempDir } from "../src/testing/temp-dir.ts";
import { stopChild } from "./stop-child.ts";

const ROOT = join(import.meta.dirname ?? ".", "..");

/** Copy a tree, following symlinks (node_modules entries may be links). */
async function copyTree(from: string, to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const e of Deno.readDir(from)) {
    const src = join(from, e.name);
    const dst = join(to, e.name);
    if ((await Deno.stat(src)).isDirectory) await copyTree(src, dst);
    else await Deno.copyFile(src, dst);
  }
}

async function waitFor<T>(
  what: string,
  fn: () => Promise<T | null>,
  log: () => string,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn().catch(() => null);
    if (v !== null) return v;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout: ${what}\n--- app output ---\n${log()}`);
}

Deno.test({
  name:
    "nested entry (src/agent/app.ts) pinned to a framework copy with no node_modules: dev serves the app, not the diagnostic page",
  sanitizeOps: true,
  sanitizeResources: true,
}, async () => {
  const base = await tempDir("aio-nested-entry-");
  const fw = join(base, "fw");
  const app = join(base, "app");
  const home = join(base, "home");
  // The release-style framework: its sources, no node_modules.
  await copyTree(join(ROOT, "src"), join(fw, "src"));
  for (const f of ["mod.ts", "deno.json", "deno.lock"]) {
    await Deno.copyFile(join(ROOT, f), join(fw, f));
  }
  // `immer` lives in the APP's node_modules only (nodeModulesDir: "auto"
  // would put it there; copied, so the test runs offline).
  await copyTree(
    await Deno.realPath(join(ROOT, "node_modules", "immer")),
    join(app, "node_modules", "immer"),
  );
  const ui = join(app, "src", "agent");
  await Deno.mkdir(ui, { recursive: true });
  await Deno.mkdir(home);
  await Deno.writeTextFile(
    join(app, "deno.json"),
    JSON.stringify({
      title: "Nested Entry",
      version: "0.1.0",
      compilerOptions: {
        jsx: "react-jsx",
        jsxImportSource: "aio",
        lib: ["deno.ns", "deno.unstable", "dom", "dom.iterable"],
      },
      imports: {
        "aio": "../fw/mod.ts",
        "aio/jsx-runtime": "../fw/src/jsx-runtime.ts",
        "immer": "npm:immer@10.2.0",
        "esbuild": "npm:esbuild@0.24.2",
        "@std/path": "jsr:@std/path@1.1.3",
        "@std/jsonc": "jsr:@std/jsonc@1.0.2",
      },
      build: { entry: "src/agent/app.ts", targets: ["browser"] },
    }),
  );
  await Deno.writeTextFile(
    join(ui, "cell.ts"),
    `import { cell } from "aio";\n` +
      `export const c = cell("probe", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });\n`,
  );
  await Deno.writeTextFile(
    join(ui, "App.tsx"),
    `import { c } from "./cell.ts";\n` +
      `export default function App() { return <main>n = {c.n}</main>; }\n`,
  );
  await Deno.writeTextFile(
    join(ui, "app.ts"),
    `import "./cell.ts";\nimport { aio } from "aio";\nawait aio.run();\n`,
  );
  // The fixture really is the failing shape: no node_modules anywhere on the
  // framework copy's walk up to `/` (esbuild's own fallback lookup).
  for (let d = fw; d !== dirname(d); d = dirname(d)) {
    assert(
      !(await Deno.stat(join(d, "node_modules")).catch(() => null)),
      `fixture broken: ${d}/node_modules exists`,
    );
  }

  const port = freePort();
  const proc = new Deno.Command(Deno.execPath(), {
    env: {
      DENO_COVERAGE_DIR: childCoverageDir(),
      AIO_APPS_DIR: home,
    },
    args: [
      "run",
      "-A",
      "--unstable-kv",
      "src/agent/app.ts",
      "--client=server-only",
      `--port=${port}`,
    ],
    cwd: app,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let out = "";
  const dec = new TextDecoder();
  const drains = [proc.stdout, proc.stderr].map(async (s) => {
    // aio-ok: a stream drain — it asserts nothing; the checks follow it
    for await (const chunk of s) out += dec.decode(chunk);
  });
  try {
    const url = `http://127.0.0.1:${port}`;
    // The verdict from the server itself, not guessed from HTML: `pending`
    // until the async prod-bundle check lands.
    const graph = await waitFor("graph verdict", async () => {
      const r = await fetch(`${url}/__aio/trojan/graph`);
      const g = await r.json() as {
        pending: boolean;
        valid: boolean | null;
        errors: { message: string }[];
      };
      return g.pending ? null : g;
    }, () => out);
    assertEquals(
      graph.errors.map((e) => e.message),
      [],
      `graph validation must be clean\n--- app output ---\n${out}`,
    );
    assertEquals(graph.valid, true);
    const res = await fetch(`${url}/`);
    const html = await res.text();
    assertEquals(res.status, 200);
    assert(
      !html.includes("Module Errors"),
      `dev served the diagnostic page:\n${html.slice(0, 400)}`,
    );
    assert(html.includes("<title>Nested Entry</title>"), html.slice(0, 400));
  } finally {
    await stopChild(proc, { label: "nested-entry app", log: () => out });
    await Promise.all(drains);
  }
});

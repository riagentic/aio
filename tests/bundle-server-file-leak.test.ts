// Server-only code in the browser bundle — four ways past one filter.
//
// The refusal was `/\.server\.ts$/` matched on the RAW SPECIFIER, in the
// esbuild plugin and again in build-bundle.ts. A specifier is one hop short of
// the truth, and an audit walked through the gap four ways. Every one of these
// built clean and printed `✓ dist/app.js`:
//
//   ① `vault.server.tsx` — the `.tsx` twin was never intercepted. Measured:
//      its contents grepped straight out of dist/app.js. Meanwhile the DEV
//      server refused to serve the same file (graph-validator and
//      server-static both accepted `.server.tsx?`), so prod was strictly more
//      PERMISSIVE than dev — the one direction this project never allows.
//   ② `"vault": "./x.server.ts"` in the import map — esbuild's `alias`
//      substitutes AFTER a plugin's filter runs, so the plugin only ever saw
//      the bare specifier `vault`. Measured: leaked.
//   ③ a computed `` import(`./${n}.server.ts`) `` — esbuild resolves the
//      pattern and inlines the file; the filter never saw that spelling.
//   ④ `await import("aio/server")` — the DOCUMENTED lazy pattern — returned
//      external without recording anything, so the standalone-Android reach
//      gate (an APK is a WebView with no Deno runtime) could not see the one
//      server import a real app is most likely to write. Measured: an
//      `--android` build of a cell that does exactly that exited 0.
//
// ①–③ are closed by ONE check: esbuild's `metafile.inputs` is the RESOLVED
// graph, so the build asks what it actually READ instead of what was written.
// ④ is closed by recording that specifier like every other server-only door.
// And the five regexes that disagreed about what `.server.*` means are now one
// exported constant.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { isServerOnlyFile, SERVER_FILE_RE } from "../src/entries.ts";

const ROOT = new URL("..", import.meta.url).pathname;
const _childCovDir = Deno.env.get("DENO_COVERAGE_DIR") ??
  Deno.makeTempDirSync({ prefix: "aio-child-cov-" });

/** A minimal real app: deno.json + cell + App.tsx, bundled by the real
 *  `runBundle`. `imports` lets a test add an import-map ALIAS, which is the
 *  whole point of defeat ②. */
async function makeApp(
  imports: Record<string, string> = {},
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "aio-leak-" });
  await Deno.mkdir(`${dir}/src`);
  await Deno.writeTextFile(
    `${dir}/deno.json`,
    JSON.stringify({
      title: "Leak Probe",
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
        "aio/server": `${ROOT}src/server.ts`,
        "immer": "npm:immer@10.2.0",
        "@std/path": "jsr:@std/path@^1",
        ...imports,
      },
    }),
  );
  await Deno.symlink(`${ROOT}node_modules`, `${dir}/node_modules`);
  await Deno.writeTextFile(
    `${dir}/src/cell.ts`,
    `import { cell } from "aio";
export const c = cell("probe", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });`,
  );
  await Deno.writeTextFile(
    `${dir}/src/App.tsx`,
    `import { c } from "./cell.ts";
export default function App() { return <button onClick={() => c.inc()}>{c.n}</button>; }`,
  );
  return dir;
}

/** The real bundle step, in a subprocess (it exits the process on refusal). */
async function bundle(
  dir: string,
  android = false,
): Promise<{ code: number; stdout: string; stderr: string; js: string }> {
  const runner = `${dir}/.aio-build/runner.ts`;
  await Deno.mkdir(`${dir}/.aio-build`, { recursive: true });
  await Deno.writeTextFile(
    runner,
    `import { runBundle } from "${ROOT}src/build/build-bundle.ts";
import { resolveAppDir } from "${ROOT}src/build/build-config.ts";
const root = ${JSON.stringify(dir)};
const mainConfig = JSON.parse(await Deno.readTextFile(root + "/deno.json"));
const configEntry = mainConfig.entry ?? "src/app.ts";
await runBundle({
  root, dist: root + "/dist", out: root + "/dist/app.js",
  frameworkSrcDir: ${JSON.stringify(ROOT + "src")},
  isRemote: false, doAndroid: ${android}, doForce: true,
  configEntry, appDir: resolveAppDir(root, configEntry), uiEntry: "App.tsx",
  // deno-lint-ignore no-explicit-any
} as any, mainConfig);
`,
  );
  const out = await new Deno.Command(Deno.execPath(), {
    env: { DENO_COVERAGE_DIR: _childCovDir },
    args: ["run", "-A", "--unstable-kv", runner],
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const d = new TextDecoder();
  return {
    code: out.code,
    stdout: d.decode(out.stdout),
    stderr: d.decode(out.stderr),
    js: await Deno.readTextFile(`${dir}/dist/app.js`).catch(() => ""),
  };
}

/** The assertion that matters: the build refused, and the secret is not on
 *  disk anywhere a browser could fetch it. */
function assertRefused(
  r: { code: number; stderr: string; js: string },
  token: string,
  what: string,
) {
  assert(
    !r.js.includes(token),
    `${what}: the token was IN dist/app.js — a browser can read it`,
  );
  assertEquals(r.code, 1, `${what}: the build must refuse\n${r.stderr}`);
  assertStringIncludes(r.stderr, "server-only");
}

Deno.test({
  name: "leak ①: a .server.TSX module never reaches the browser bundle",
  async fn() {
    const dir = await makeApp();
    try {
      await Deno.writeTextFile(
        `${dir}/src/vault.server.tsx`,
        `export const SECRET = "TOKEN-TSX-8f3a";\n`,
      );
      await Deno.writeTextFile(
        `${dir}/src/App.tsx`,
        `import { SECRET } from "./vault.server.tsx";
export default function App() { return <b>{SECRET}</b>; }`,
      );
      const r = await bundle(dir);
      assertRefused(r, "TOKEN-TSX-8f3a", "a .server.tsx twin");
      assertStringIncludes(
        r.stderr,
        "vault.server.tsx",
        "the refusal must name THIS file, not merely refuse for some reason",
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "leak ②: an import-map ALIAS that resolves to a server file is refused",
  async fn() {
    // The plugin's filter runs on the specifier `vault`; esbuild substitutes
    // the alias afterwards. Nothing a specifier check can do — only the
    // resolved graph knows.
    const dir = await makeApp({ "vault": "./src/aliased.server.ts" });
    try {
      await Deno.writeTextFile(
        `${dir}/src/aliased.server.ts`,
        `export const SECRET = "TOKEN-ALIAS-2b71";\n`,
      );
      await Deno.writeTextFile(
        `${dir}/src/App.tsx`,
        `import { SECRET } from "vault";
export default function App() { return <b>{SECRET}</b>; }`,
      );
      const r = await bundle(dir);
      assertRefused(r, "TOKEN-ALIAS-2b71", "an import-map alias");
      assertStringIncludes(
        r.stderr,
        "aliased.server.ts",
        "the refusal must name the FILE, since the specifier does not",
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "leak ③: a computed import() of a server file is refused",
  async fn() {
    const dir = await makeApp();
    try {
      await Deno.writeTextFile(
        `${dir}/src/vault.server.ts`,
        `export const SECRET = "TOKEN-TEMPLATE-9c22";\n`,
      );
      await Deno.writeTextFile(
        `${dir}/src/App.tsx`,
        'const n = "vault";\n' +
          "const p = import(`./${n}.server.ts`);\n" +
          "export default function App() { return <b>{String(p)}</b>; }",
      );
      const r = await bundle(dir);
      assertRefused(r, "TOKEN-TEMPLATE-9c22", "a computed import()");
      assertStringIncludes(r.stderr, "vault.server.ts");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: 'leak ④: `await import("aio/server")` is on the standalone-APK ledger',
  async fn() {
    // Not a browser leak — it stays external, correctly. The bug is that it
    // was invisible to the ANDROID gate: an APK has no Deno runtime, so this
    // import is not dead code there, it is the half of the app that does the
    // work, silently not shipping. Measured before the fix: exit 0.
    const dir = await makeApp();
    try {
      await Deno.writeTextFile(
        `${dir}/src/cell.ts`,
        `import { cell } from "aio";
export const c = cell("probe", {
  state: { n: 0 },
  methods: {
    async srv(s) { const m = await import("aio/server"); s.n = Object.keys(m).length; },
  },
});`,
      );
      const r = await bundle(dir, /* android */ true);
      assertEquals(
        r.code,
        1,
        `a standalone APK cannot run aio/server\n${r.stdout}${r.stderr}`,
      );
      assertStringIncludes(r.stderr, "reaches server-only code");
      assertStringIncludes(r.stderr, "aio/server");
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name: "the sanctioned dynamic pattern still builds, and still ships nothing",
  async fn() {
    // The gate is only correct if it leaves the documented escape hatch alone:
    // `await import("./io.server.ts")` inside a method is server-side, so the
    // module is external and its contents are absent — on every target that
    // HAS a Deno runtime.
    const dir = await makeApp();
    try {
      await Deno.writeTextFile(
        `${dir}/src/io.server.ts`,
        `export const SECRET = "TOKEN-SANCTIONED-1111";\nexport const read = () => SECRET;`,
      );
      await Deno.writeTextFile(
        `${dir}/src/cell.ts`,
        `import { cell } from "aio";
export const c = cell("probe", {
  state: { n: 0 },
  methods: {
    async load(s) { const { read } = await import("./io.server.ts"); s.n = read().length; },
  },
});`,
      );
      const r = await bundle(dir);
      assertEquals(r.code, 0, `the escape hatch must still build\n${r.stderr}`);
      assert(r.js.length > 50_000, "a real bundle");
      assert(
        !r.js.includes("TOKEN-SANCTIONED-1111"),
        "the server module must stay OUT of the bundle",
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// ── one regex, five sites ────────────────────────────────────

Deno.test("SERVER_FILE_RE: the extension set has no hole", () => {
  for (
    const yes of [
      "x.server.ts",
      "x.server.tsx",
      "x.server.js",
      "x.server.jsx",
      "x.server.mjs",
      "x.server.cjs",
      "x.server.mts",
      "x.server.cts",
      "./a/b/vault.server.tsx",
      "/abs/vault.server.ts",
      "src/io.server.ts?v=2", // esbuild metafile keys carry these
      "src/io.server.ts#frag",
    ]
  ) {
    assert(isServerOnlyFile(yes), `${yes} is a server-only file`);
  }
  for (
    const no of [
      "server.ts",
      "x.serverts",
      "xserver.ts",
      "x.server.css",
      "x.server.json",
      "x.server.ts.map",
      "myserver.tsx",
      "x.server.tsxx",
    ]
  ) {
    assert(!isServerOnlyFile(no), `${no} is NOT a server-only file`);
  }
});

Deno.test("the .server.* convention is decided in exactly ONE place", async () => {
  // Five sites carried their own regex and two of them disagreed, which is how
  // dev came to REFUSE TO SERVE a file prod happily SHIPPED. A sixth copy is
  // the same bug waiting, so a copy is the failure.
  const sites = [
    "src/build/esbuild-plugin.ts",
    "src/build/graph-audit.ts",
    "src/server/graph-validator.ts",
    "src/server/server-static.ts",
    "src/testing/smoke-test.ts",
    "aiol/checks.ts",
  ];
  for (const rel of sites) {
    const raw = await Deno.readTextFile(ROOT + rel);
    // Comments may QUOTE the old regex — that is documentation, not a decider.
    // Line comments FIRST: a `//` line may contain `@std/*`, whose `/*` would
    // otherwise open a block comment that swallows real code.
    const src = raw.replace(/^\s*\/\/.*$/gm, "").replace(
      /\/\*[\s\S]*?\*\//g,
      "",
    );

    assert(
      /SERVER_FILE_RE|isServerOnlyFile/.test(src),
      `${rel} must use the shared decider from src/entries.ts`,
    );
    const own = src.match(/\/\\?\.server\\?\.[^/\n]*\//g) ?? [];
    assertEquals(
      own,
      [],
      `${rel} declares its OWN .server.* regex (${own.join(", ")}) — that is ` +
        `the second decider this constant exists to remove`,
    );
    assert(
      !/endsWith\(["']\.server\./.test(src),
      `${rel} matches .server.* with endsWith() — same second decider, ` +
        `spelled differently (and it silently excludes .tsx)`,
    );
  }
  // …and the one place it IS decided.
  assert(SERVER_FILE_RE.source.includes("server"));
});

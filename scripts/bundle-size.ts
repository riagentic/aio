#!/usr/bin/env -S deno run -A
// scripts/bundle-size.ts — THE measurement behind every size number aio prints.
//
// Five docs said "~20 KB gzipped" for the renderer and "a small app bundles to
// ~50 KB gzipped", repeated from each other, and NOTHING measured either. The
// real counter app was 161,905 raw / 58,202 gzipped — above the number the docs
// promised, for the smallest app that can exist. A claim with no test is the
// project's own named trap, and this is the test.
//
// One decider, three consumers:
//   • `deno task bench:bundle`          — print the numbers
//   • `tests/bundle-size.test.ts`      — gate them against a ceiling
//   • `docs/ui/air-setup.md` & co.     — quote them, checked by the same test
//
// Run: deno task bench:bundle [--json]
import { runBundle } from "../src/build/build-bundle.ts";
import { resolveAppDir } from "../src/build/build-config.ts";
import { ESBUILD_JSX, ESBUILD_SPEC } from "../src/build/esbuild-shared.ts";

const ROOT = new URL("..", import.meta.url).pathname;

/** What a size report contains. Bytes, always — KB is a presentation choice. */
export interface BundleSizes {
  /** The whole browser bundle of the smallest real app: renderer, client
   *  runtime, protocol, the app's own cell and component. */
  appRaw: number;
  appGzip: number;
  appBrotli: number;
  /** An app that renders but holds no state — no cell, no socket traffic. The
   *  difference from `app*` is what one cell actually costs. */
  shellRaw: number;
  shellGzip: number;
  shellBrotli: number;
  /** AIR ALONE: `src/air.ts`, bundled and minified with nothing else. This is
   *  the number comparable to "React + ReactDOM, min+gzip" — and the number
   *  five docs quoted as "~20 KB" without ever measuring it. */
  airRaw: number;
  airGzip: number;
  airBrotli: number;
}

async function gzipSize(bytes: Uint8Array<ArrayBuffer>): Promise<number> {
  const cs = new CompressionStream("gzip");
  const w = cs.writable.getWriter();
  void w.write(bytes);
  void w.close();
  return (await new Response(cs.readable).arrayBuffer()).byteLength;
}

async function brotliSize(bytes: Uint8Array<ArrayBuffer>): Promise<number> {
  const z = await import("node:zlib");
  // q11 — the number a static host or a precompressed artifact would achieve,
  // which is what a documented size should quote.
  return z.brotliCompressSync(bytes, {
    params: { [z.constants.BROTLI_PARAM_QUALITY]: 11 },
  }).byteLength;
}

/** Write the smallest app that is still a real app: one cell, one component. */
async function writeCounterApp(dir: string, bare: boolean): Promise<void> {
  await Deno.mkdir(`${dir}/src`, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/deno.json`,
    JSON.stringify({
      title: "Size Probe",
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
  await Deno.symlink(`${ROOT}node_modules`, `${dir}/node_modules`);
  await Deno.writeTextFile(
    `${dir}/src/cell.ts`,
    `import { cell } from "aio";
export const counter = cell("counter", {
  state: { count: 0 },
  methods: { increment(s, by = 1) { s.count += by; } },
});`,
  );
  // `bare` is the renderer floor: a component that renders, with no cell, no
  // socket and no state — everything the DOM needs and nothing else. The
  // difference between the two is what state, sync and transport actually cost.
  await Deno.writeTextFile(
    `${dir}/src/App.tsx`,
    bare
      ? `export default function App() { return <button type="button">hi</button>; }`
      : `import { counter } from "./cell.ts";
export default function App() {
  return <button type="button" onClick={() => counter.increment()}>{counter.count}</button>;
}`,
  );
  await Deno.writeTextFile(
    `${dir}/src/app.ts`,
    bare
      ? `import { aio } from "aio";\nawait aio.run({});`
      : `import "./cell.ts";\nimport { aio } from "aio";\nawait aio.run({});`,
  );
}

/** Bundle one app in a child process (the bundler exits on failure) and return
 *  the bytes that would ship. */
async function bundleBytes(bare: boolean): Promise<Uint8Array<ArrayBuffer>> {
  const dir = await Deno.makeTempDir({ prefix: "aio-size-" });
  try {
    await writeCounterApp(dir, bare);
    const runner = `${dir}/.aio-build/runner.ts`;
    await Deno.mkdir(`${dir}/.aio-build`, { recursive: true });
    await Deno.writeTextFile(
      runner,
      `import { runBundle } from "${ROOT}src/build/build-bundle.ts";
import { resolveAppDir } from "${ROOT}src/build/build-config.ts";
const root = ${JSON.stringify(dir)};
const mainConfig = JSON.parse(await Deno.readTextFile(root + "/deno.json"));
const configEntry = "src/app.ts";
await runBundle({
  root, dist: root + "/dist", out: root + "/dist/app.js",
  frameworkSrcDir: ${JSON.stringify(ROOT + "src")},
  isRemote: false, doAndroid: false, doForce: true,
  configEntry, appDir: resolveAppDir(root, configEntry), uiEntry: "App.tsx",
  // deno-lint-ignore no-explicit-any
} as any, mainConfig);
`,
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--unstable-kv", runner],
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (out.code !== 0) {
      throw new Error(
        `bundle-size: the probe app did not bundle (exit ${out.code}).\n` +
          new TextDecoder().decode(out.stderr).slice(-2000),
      );
    }
    return await Deno.readFile(`${dir}/dist/app.js`) as Uint8Array<ArrayBuffer>;
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** AIR alone — what the RENDERER costs, tree-shaken.
 *
 *  Not `src/air.ts` as an entry point: that is the public `aio/air` surface,
 *  108 exported symbols, and bundling it whole measures the export list rather
 *  than the renderer (it comes out LARGER than a whole app, which is how this
 *  was caught). What a page actually pays for is what `mount` reaches, so the
 *  entry is a page that mounts a component and nothing else, and esbuild's
 *  tree-shaking answers the question. This is the number comparable to
 *  "React + ReactDOM, min+gzip". */
async function bundleAirAlone(): Promise<Uint8Array<ArrayBuffer>> {
  const esbuild = await import(ESBUILD_SPEC);
  const dir = await Deno.makeTempDir({ prefix: "aio-air-size-" });
  try {
    await Deno.writeTextFile(
      `${dir}/entry.tsx`,
      `import { mount } from ${JSON.stringify(ROOT + "src/air.ts")};\n` +
        `function App() { return <div class="x">hi</div>; }\n` +
        `mount(document.body, App);\n`,
    );
    const r = await esbuild.build({
      entryPoints: [`${dir}/entry.tsx`],
      bundle: true,
      minify: true,
      format: "esm",
      platform: "browser",
      write: false,
      ...ESBUILD_JSX,
      // The JSX factory is `aio/jsx-runtime`, a bare specifier esbuild cannot
      // resolve without the app's import map. One alias, pointing at the same
      // file the map does.
      alias: { "aio/jsx-runtime": `${ROOT}src/jsx-runtime.ts` },
    });
    return r.outputFiles![0]!.contents as Uint8Array<ArrayBuffer>;
  } finally {
    await esbuild.stop?.();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** Measure every bundle a size claim could be about. */
export async function measure(): Promise<BundleSizes> {
  const app = await bundleBytes(false);
  const shell = await bundleBytes(true);
  const air = await bundleAirAlone();
  return {
    appRaw: app.byteLength,
    appGzip: await gzipSize(app),
    appBrotli: await brotliSize(app),
    shellRaw: shell.byteLength,
    shellGzip: await gzipSize(shell),
    shellBrotli: await brotliSize(shell),
    airRaw: air.byteLength,
    airGzip: await gzipSize(air),
    airBrotli: await brotliSize(air),
  };
}

/** KB, rounded the way a doc quotes it. */
export const kb = (bytes: number): number => Math.round(bytes / 1024);

// `resolveAppDir` and `runBundle` are imported for the child runner's sake —
// referencing them keeps the import graph honest about what this script needs.
void runBundle;
void resolveAppDir;

if (import.meta.main) {
  const sizes = await measure();
  if (Deno.args.includes("--json")) {
    console.log(JSON.stringify(sizes, null, 2));
  } else {
    const row = (label: string, raw: number, gz: number, br: number) =>
      `${label.padEnd(22)} ${String(kb(raw)).padStart(5)} KB ${
        String(kb(gz)).padStart(5)
      } KB ${String(kb(br)).padStart(5)} KB`;
    console.log("\nbundle                   raw    gzip  brotli");
    console.log("─".repeat(46));
    console.log(row("AIR alone", sizes.airRaw, sizes.airGzip, sizes.airBrotli));
    console.log(
      row(
        "app shell (no cell)",
        sizes.shellRaw,
        sizes.shellGzip,
        sizes.shellBrotli,
      ),
    );
    console.log(
      row("counter app", sizes.appRaw, sizes.appGzip, sizes.appBrotli),
    );
    console.log("");
  }
}

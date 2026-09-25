// The dev-only chunk — the gate that keeps it out of every production page.
//
// MEASURED, on the counter app: 32,878 bytes raw / 12.0 KB gzipped of code
// that a production page cannot run and downloaded anyway. `isDevMode()` reads
// `globalThis.__aioDev`, and only `aioDevHTML` sets it — a shell that serves
// the dev import map, never `dist/app.js`. So no page that loads the bundle
// could switch any of it on, and no bundler can prove a runtime flag false.
//
// It now lives in ONE module, `src/browser/dev-diagnostics.ts`, behind a
// dynamic import that `esbuild-plugin.ts` marks external (see DEV_CHUNK_URL).
//
// WHY THIS TEST AND NOT THE SIZE GATE. A ceiling notices 12 KB coming back all
// at once; it notices nothing when one module returns. And the way it comes
// back is not a decision anybody makes — it is one `import { auditContrast }`
// added to a file the renderer already imports, which type-checks, lints,
// passes every behavioural test, and quietly puts 5 KB on every page load
// again. So the assertion is on the RESOLVED GRAPH: esbuild's metafile for a
// real build of a real app, which is the same evidence
// `bundle-server-file-leak.test.ts` uses for server-only files and for the
// same reason — a specifier is one hop short of the truth.
//
// The list is deliberately explicit rather than "anything dev-*": these seven
// modules each carry an argument for why they may leave (air/dev-hooks.ts has
// it, module by module), and a pattern would silently adopt the next file
// somebody names `dev-something.ts` without anyone making that argument.
import { assert, assertEquals } from "@std/assert";
import { bundleClient } from "../src/build/client-bundle.ts";
import { DEV_CHUNK_URL } from "../src/build/esbuild-plugin.ts";
import {
  ESBUILD_SPEC,
  stopEsbuildService,
} from "../src/build/esbuild-shared.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ROOT = new URL("..", import.meta.url).pathname;

/** The modules a production page must not download, and why each one may go.
 *  Every entry is category (a) of the dev==prod rule — observe-only, or a
 *  control channel whose only sender production never mounts. */
const DEV_ONLY = [
  // observe-only audits, called inside `if (isDevMode())` in renderer-flush
  "src/air/contrast-audit.ts",
  "src/air/selector-audit.ts",
  // observe-only installers: each `return`s on `!isDevMode()`, first line
  "src/browser/dev-overlay.ts",
  "src/air/dev-readonly-hint.ts",
  "src/air/dark-os-light-page.ts",
  // the `am surface` / `am trigger` executor: driven only by the two trojan
  // frames, and the trojan is never mounted in prod (server-static.ts)
  "src/air/ui-remote.ts",
  "src/air/ui-surface.ts",
  "src/air/ui-trigger.ts",
] as const;

/** Modules that must STAY in the bundle. Their absence would make production
 *  less capable than dev — the direction the dev==prod rule forbids — so a
 *  future size pass that swept them into the chunk is a regression, not a win.
 *  Recorded here because "why is this still shipping" is the question the list
 *  above invites, and an answer nobody can find gets re-litigated. */
const MUST_STAY = [
  // forwards the page's console to the server log in production too (`am logs`)
  "src/browser/console-intercept.ts",
  // `am eval '__aioProfile()'` reads these counts off a live production app
  "src/air/component-profile.ts",
  // reachable from the public `useTimeTravel()`
  "src/air/time-travel-panel.ts",
] as const;

/** The smallest real app, bundled the way `deno task build` bundles it. */
async function bundleProbe(): Promise<
  { inputs: string[]; code: string }
> {
  const dir = await tempDir("aio-devchunk-");
  try {
    await Deno.mkdir(`${dir}/src`, { recursive: true });
    const imports = {
      "aio": `${ROOT}mod.ts`,
      "aio/jsx-runtime": `${ROOT}src/jsx-runtime.ts`,
      "immer": "npm:immer@10.2.0",
      "@std/path": "jsr:@std/path@^1",
    };
    await Deno.writeTextFile(
      `${dir}/deno.json`,
      JSON.stringify({
        title: "Dev Chunk Probe",
        nodeModulesDir: "auto",
        compilerOptions: {
          jsx: "react-jsx",
          jsxImportSource: "aio",
          lib: ["deno.ns", "deno.unstable", "dom", "dom.iterable"],
        },
        imports,
      }),
    );
    await Deno.symlink(`${ROOT}node_modules`, `${dir}/node_modules`);
    await Deno.writeTextFile(
      `${dir}/src/cell.ts`,
      `import { cell } from "aio";
export const counter = cell("counter", {
  state: { count: 0 },
  methods: { increment(s) { s.count += 1; } },
});`,
    );
    await Deno.writeTextFile(
      `${dir}/src/App.tsx`,
      `import { counter } from "./cell.ts";
export default function App() {
  return <button type="button" onClick={() => counter.increment()}>{counter.count}</button>;
}`,
    );
    await Deno.writeTextFile(
      `${dir}/src/app.ts`,
      `import "./cell.ts";\nimport { aio } from "aio";\nawait aio.run({});`,
    );
    const esbuild = await import(ESBUILD_SPEC);
    try {
      const r = await bundleClient({
        esbuild,
        root: dir,
        appDir: `${dir}/src`,
        uiEntry: "App.tsx",
        doAndroid: false,
        imports,
        shares: [],
        frameworkSrcDir: `${ROOT}src`,
      });
      assert(r.ok, `the probe app did not bundle:\n${r.errors.join("\n")}`);
      // `bytesInOutput` is what each input CONTRIBUTED after tree-shaking, so
      // a module esbuild kept a record of but emitted nothing for is not in
      // the page. That distinction is the whole measurement: `contrast-audit`
      // survives as a 5-byte module record through a re-export chain and
      // costs the page nothing.
      const inputs = Object.entries(r.bytesInOutput ?? {})
        .filter(([, bytes]) => bytes > 64)
        .map(([path]) => path.split("\\").join("/"));
      return { inputs, code: r.code };
    } finally {
      await stopEsbuildService(() => esbuild.stop?.());
    }
  } finally {
    await dropTempDir(dir);
  }
}

let _probe: { inputs: string[]; code: string } | null = null;
async function probe() {
  if (!_probe) _probe = await bundleProbe();
  return _probe;
}

Deno.test({
  name:
    "dev chunk: the production bundle contains none of the dev-only modules",
  async fn() {
    const { inputs } = await probe();
    const leaked = DEV_ONLY.filter((m) => inputs.some((i) => i.endsWith(m)));
    assertEquals(
      leaked,
      [],
      "a dev-only module is back in the production bundle:\n  " +
        leaked.join("\n  ") +
        "\n  Every page load pays for code that cannot run on it " +
        "(`__aioDev` is set only by the dev shell, which does not load this " +
        "bundle). Reach it through `devHooks` / `loadDevChunk()` " +
        "(src/air/dev-hooks.ts) instead of importing it statically, and put " +
        "the module in src/browser/dev-diagnostics.ts.",
    );
  },
});

Deno.test({
  name: "dev chunk: the bundle asks for it at the dev server's own route",
  async fn() {
    const { code } = await probe();
    // Not merely "it is not here": the page must still be ABLE to ask for it,
    // or an app calling the public `setDevMode(true)` silently loses every
    // check it just asked for. The specifier is the dev server's
    // live-transpile route, which is real in dev and closed in prod — and
    // `loadDevChunk()` says so, once, when the fetch fails.
    //
    // The assertion is on the `import(…)` CALL, not on the URL. The URL alone
    // is in the bundle twice: the import, and the failure message that quotes
    // it. Written the loose way this test passed with the split reverted —
    // the instrument agreeing with itself, which is this project's own named
    // trap. Verified by reverting the split: loose → green, this → red.
    const asks = new RegExp(
      `import\\(\\s*["'\`]${
        DEV_CHUNK_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      }["'\`]\\s*\\)`,
    );
    assert(
      asks.test(code),
      "the bundle never calls import() for the dev chunk — a dev session on " +
        "a bundle would get no diagnostics and no message saying so. " +
        `Looked for ${asks} in dist/app.js.`,
    );
  },
});

Deno.test({
  name: "dev chunk: the modules that must NOT move are still in the bundle",
  async fn() {
    const { inputs } = await probe();
    const missing = MUST_STAY.filter((m) => !inputs.some((i) => i.endsWith(m)));
    assertEquals(
      missing,
      [],
      "a module production NEEDS was swept into the dev chunk:\n  " +
        missing.join("\n  ") +
        "\n  That makes production less capable than dev, which is the one " +
        "direction the dev==prod rule forbids. See the reason beside each " +
        "name in this file.",
    );
  },
});

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
import {
  DEV_CHUNK_URL,
  isFrameworkDevAir,
} from "../src/build/esbuild-plugin.ts";
import {
  ESBUILD_SPEC,
  stopEsbuildService,
} from "../src/build/esbuild-shared.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { fromFileUrl } from "@std/path";
import { spec } from "./module-spec-helper.ts";
import { fixtureNodeModules } from "./symlink-helper.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));

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
  // the renderer's own dev layer: `air/dev-hooks.ts` imports `dev-air.ts`
  // STATICALLY (so every runtime that runs source has it from its first
  // line) and the browser bundler answers that import with an empty record
  // (`DEV_AIR_RE` in esbuild-plugin.ts). Each is observe-only and returns —
  // or is only called — under `isDevMode()`:
  "src/air/dev-air.ts",
  "src/air/dev-a11y.ts", // the accessibility lint and its role tables
  "src/air/control-drift.ts", // a controlled input left showing unstored text
  "src/air/dev-events.ts", // the known-event list and the typo lint over it
  "src/air/dev-keys.ts", // missing / mixed / duplicate keys
  "src/air/dev-align.ts", // the child-alignment walk after every diff
  "src/air/dev-burst.ts", // the render-burst tripwire and its three messages
  // the time-travel panel's DOM — only a non-prod server sends `tt-state`
  "src/air/time-travel-dom.ts",
] as const;

/** What the probe app's own `src/ui/air/dev-air.ts` exports. */
const APP_OWN = "app-owned-dev-air-marker";

/** One sentence from each dev-layer module, as it would appear in the bundle.
 *  The module list above reads esbuild's metafile; this reads the OUTPUT, so a
 *  check that came back by being copied into a bundled file is caught too. */
const DEV_PROSE = [
  'missing "alt" attribute',
  "the handler did not store the typed",
  "the handler will never fire",
  "children without keys",
  "the child reconciler desynced",
  "times in under a second",
  "Ctrl+. to toggle",
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
  // reachable from the public `useTimeTravel()` (its state; the panel's DOM
  // is `time-travel-dom.ts`, above)
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
      "aio": `${spec(ROOT)}mod.ts`,
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
    await fixtureNodeModules(dir);
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
import { OWN } from "./ui/air/dev-air.ts";
export default function App() {
  return <button type="button" title={OWN} onClick={() => counter.increment()}>{counter.count}</button>;
}`,
    );
    // An app's OWN file that happens to be named like the framework's dev
    // layer — the bundler cuts that one by name, and must not cut this.
    await Deno.mkdir(`${dir}/src/ui/air`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/src/ui/air/dev-air.ts`,
      `export const OWN = ${JSON.stringify(APP_OWN)};`,
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
        standalone: false,
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
  name:
    "dev chunk: an app's own …/air/dev-air.ts is bundled — only the framework's is cut",
  async fn() {
    const { code } = await probe();
    assert(
      code.includes(APP_OWN),
      "the app's own air/dev-air.ts was answered with the empty dev-layer " +
        "stub: its export is `undefined` in dist/app.js",
    );
    assert(isFrameworkDevAir(`${ROOT}src/air/dev-air.ts`));
    assert(!isFrameworkDevAir(`${ROOT}src/air/vdom.ts`));
    assert(!isFrameworkDevAir(`${ROOT}no/such/air/dev-air.ts`));
  },
});

Deno.test({
  name: "dev chunk: none of the dev layer's prose is in the production bundle",
  async fn() {
    const { code } = await probe();
    assertEquals(
      DEV_PROSE.filter((line) => code.includes(line)),
      [],
      "a dev-only message is in dist/app.js — the check that says it was " +
        "bundled (or copied into a bundled module). It belongs in the dev " +
        "layer: src/air/dev-air.ts.",
    );
    // …and the seam is what is left: the render path still ASKS, on a slot
    // that is null here. A bundle with no call sites would pass the lines
    // above by having lost the checks in dev too.
    assert(
      /\.checkKeys\?\.\(/.test(code) && /\.renderBurst\?\.\(/.test(code),
      "the bundle no longer calls the dev hooks — the seam is gone",
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
    // `am shot` waits on it before vouching for a frame — on a prod page too.
    assert((await probe()).code.includes("__aioMounted"));
  },
});

Deno.test({
  name: "dev chunk: tooling-only tables stay off the page",
  async fn() {
    const { code } = await probe();
    // The page names ONE execution context (diagnostics/contexts.ts
    // SYNC_METHOD) and looks removals up for their MESSAGES; the full context
    // table and the source-scan patterns (removals.ts CORE_PATTERNS) are read
    // only by tooling and server messages. ~0.6 KB gz together, measured.
    const leaked = [
      ["the context table (CONTEXTS)", "a worker isolate"],
      ["a removal's source pattern", "forUser|publicFields)\\b"],
    ].filter(([, marker]) => code.includes(marker!)).map(([what]) => what);
    assertEquals(leaked, [], "tooling-only data is in dist/app.js again");
  },
});

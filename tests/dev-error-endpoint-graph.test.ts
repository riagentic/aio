// `am errors` reads `/__aio/error` as THE build error — "nothing else runs
// until this is fixed". It held only the transpile failures a browser had
// asked for in the last 30 s, so with App.tsx broken and the import-graph
// validator serving the Module Errors page at `/`, it answered `build: []`:
// the page any reload shows said one thing, the tool another.
import { assertEquals } from "@std/assert";
import {
  createStaticHandler,
  type StaticDeps,
} from "../src/server/server-static.ts";
import type { GraphResult } from "../src/server/graph-validator.ts";

function deps(graph: GraphResult | null): StaticDeps {
  return {
    prod: false,
    debug: () => {},
    title: "T",
    absBaseDir: "/tmp",
    absDistDir: null,
    hasCSS: false,
    importMap: "{}",
    noCache: {},
    getGraphResult: () => graph,
    getVitalsExtra: () => ({ payloadStats: new Map(), clientBackpressure: {} }),
    getTrojanDeps: () => ({}),
  };
}

const graph = (valid: boolean, deferred = false): GraphResult => ({
  valid,
  errors: [{
    file: "/app/src/App.tsx",
    line: 22,
    col: 3,
    lineText: "<h1>x</h2>",
    category: "transpile-error",
    message: 'Unexpected closing "h2" tag does not match opening "h1" tag',
    fix: "fix the tag",
    deferred,
  }],
  modules: new Map(),
  eager: new Set(),
  durationMs: 0,
});

const errorsOf = async (g: GraphResult | null) => {
  const { serveStatic } = createStaticHandler(deps(g));
  const res = await serveStatic("/__aio/error");
  return (await res.json()).errors as { text: string; file?: string }[];
};

Deno.test("/__aio/error reports the import-graph error that blocks the page", async () => {
  const errors = await errorsOf(graph(false));
  assertEquals(errors.length, 1, JSON.stringify(errors));
  assertEquals(errors[0]!.file, "/app/src/App.tsx");
  assertEquals(errors[0]!.text.includes('closing "h2"'), true);
});

Deno.test("/__aio/error stays empty for a valid graph or a deferred-only error", async () => {
  assertEquals(await errorsOf(null), []);
  assertEquals(await errorsOf(graph(true)), []);
  assertEquals(await errorsOf(graph(false, true)), []);
});

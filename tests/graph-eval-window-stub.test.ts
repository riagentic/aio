// The graph evaluator's stub `window` answered "yes" to every question —
// every read a truthy stub, every `in` true — so a library's "was I loaded
// before?" guard fired on FIRST load. three.js does exactly this at module
// scope, and every `am check` / dev boot printed a false "Multiple instances
// of Three.js being imported" (field report (a desktop map app) §3). The stub now
// remembers what a module writes and reads an unwritten `__marker` as absent,
// as a fresh tab does; every other unwritten name stays permissive.
import { assertEquals } from "@std/assert";
import { evaluateBundle } from "../src/build/graph-eval.ts";

/** Run `body` with console.warn recorded; the bundle throws if it warned. */
const silently = (body: string) => `
const warned = [];
const cw = console.warn;
console.warn = (...a) => warned.push(a.join(" "));
try { ${body} } finally { console.warn = cw; }
if (warned.length) throw new Error("warned: " + warned.join(" | "));
`;

// three.js r1xx, module scope, verbatim shape.
const THREE_GUARD = `
const REVISION = "170";
if ( typeof window !== 'undefined' ) {
  if ( window.__THREE__ ) {
    console.warn( 'WARNING: Multiple instances of Three.js being imported.' );
  } else {
    window.__THREE__ = REVISION;
  }
}
`;

Deno.test("graph-eval stub: the three.js loaded-before guard evaluates silently on first load", async () => {
  const r = await evaluateBundle(silently(THREE_GUARD), "esm");
  assertEquals(r, { ok: true, ms: r.ms }, JSON.stringify(r));
});

Deno.test("graph-eval stub: a guard that runs TWICE does see its own marker", async () => {
  // The other half of the contract: remembering, not blindness.
  const r = await evaluateBundle(
    THREE_GUARD + `
if (window.__THREE__ !== "170") throw new Error("lost: " + String(window.__THREE__));
if (!("__THREE__" in window)) throw new Error("in: false after a write");`,
    "esm",
  );
  assertEquals(r.ok, true, JSON.stringify(r));
});

Deno.test("graph-eval stub: a set global reads back its value, on window and on nested stubs", async () => {
  const r = await evaluateBundle(
    `window.appConfig = { n: 7 };
     if (window.appConfig.n !== 7) throw new Error("window write lost");
     document.body.dataset.k = "v";
     if (document.body.dataset.k !== "v") throw new Error("nested write lost");
     if (document.body !== document.body) throw new Error("unstable identity");
     delete window.appConfig;
     if (typeof window.appConfig !== "function") throw new Error("delete kept it");`,
    "esm",
  );
  assertEquals(r.ok, true, JSON.stringify(r));
});

Deno.test("graph-eval stub: an unwritten __marker is absent, every other unwritten name stays permissive", async () => {
  const r = await evaluateBundle(
    `if (window.__VUE__ !== undefined) throw new Error("marker present");
     if ("__SENTRY__" in window) throw new Error("marker in");
     if (!("addEventListener" in window)) throw new Error("not permissive");
     window.addEventListener("load", () => {});
     document.createElement("div").style.color = "red";
     localStorage.getItem("k");
     if (document.readyState !== "loading") throw new Error("readyState");`,
    "esm",
  );
  assertEquals(r.ok, true, JSON.stringify(r));
});

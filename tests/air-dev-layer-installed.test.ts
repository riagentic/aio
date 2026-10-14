// The dev layer is INSTALLED wherever source runs — by construction.
//
// The renderer's dev checks (a11y lint, controlled-input drift, known-event
// typo lint, key checks, child-alignment walk, render-burst tripwire) left the
// production bundle: the render path now calls `devHooks.x?.(…)`, and a slot
// that is null makes that call nothing at all. That is right for a production
// page and would be the worst kind of regression anywhere else — a test that
// mounts AIR directly, arms dev mode, and silently runs with NO tripwires is
// a green test that means less than production does.
//
// So the slots are not filled by a harness that somebody has to remember to
// use. `air/dev-hooks.ts` imports the layer statically; only the browser
// bundler answers that import with an empty record. This file is the proof:
// it imports the renderer and nothing else from src/ before the first test.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { h } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  mount,
  setDevMode,
} from "../src/air/aio-renderer.ts";
import { afterRender } from "../src/air/renderer-flush.ts";
import { signal } from "../src/state/signal.ts";
import { _said } from "../src/protocol/said-once.ts";
import { devHooks } from "../src/air/dev-hooks.ts";

const AIR_SLOTS = [
  "a11y",
  "rearm",
  "afterHandler",
  "cancelDriftChecks",
  "unknownEvent",
  "checkKeys",
  "assertAligned",
  "renderAsked",
  "depFired",
  "renderBurst",
] as const;

Deno.test("dev layer: a module that imports only the renderer has every renderer dev hook", () => {
  const missing = AIR_SLOTS.filter((k) => typeof devHooks[k] !== "function");
  assertEquals(
    missing,
    [],
    "dev hooks that are not installed after importing the renderer alone — " +
      "every tripwire behind them is silently OFF in a direct-mount test",
  );
});

Deno.test("dev layer: a direct mount in dev mode fires a tripwire from each moved module", async () => {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  _setDocument(doc);
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  const g = globalThis as Record<string, unknown>;
  const had = g.__aioDev;
  g.__aioDev = true;
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  const said = (text: string) => lines.some((l) => l.includes(text));
  const until = async (text: string) => {
    for (let i = 0; i < 400 && !said(text); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert(said(text), `never said "${text}":\n${lines.join("\n")}`);
  };
  const n = signal(0);
  const loop = signal(0);
  const Loop = () => {
    const v = loop.value;
    // A post-render write of what the render reads; bounded so it ends.
    afterRender(() => {
      if (v > 0 && v < 60) loop.set(v + 1);
    });
    return h("u", null, String(v));
  };
  const handle = mount(
    root,
    () =>
      h(
        "div",
        null,
        h("img", { src: "x.png" }), // dev-a11y
        h("i", { onClik: () => {} }), // dev-events
        h("ul", null, [h("li", { key: "k" }), h("li", null)]), // dev-keys
        h("input", { id: "drift", value: "kept", onInput: () => {} }), // control-drift
        h("p", { id: "aligned" }, String(n.value)), // dev-align
        h(Loop as never, null), // dev-burst
      ) as never,
  );
  try {
    assert(said('missing "alt"'), lines.join("\n"));
    assert(said('unknown event "clik"'), lines.join("\n"));
    // dev-align: a node the renderer did not put there, then a re-render.
    root.querySelector("#aligned")!.appendChild(doc.createElement("b"));
    n.set(1);
    // dev-burst: outside any handler, so it counts as a loop.
    loop.set(1);
    // dev-keys looks at a list when it is DIFFED: the re-render above.
    await until("Mixed keyed and unkeyed children");
    await until("child reconciler desynced");
    await until("Loop re-rendered 50 times");
    // control-drift: a typed key the handler does not store — after the
    // renders above, since a render writes the field back.
    const input = root.querySelector("#drift") as HTMLInputElement;
    input.value += "x";
    input.dispatchEvent(
      // deno-lint-ignore no-explicit-any
      new (win as any).InputEvent("input", { bubbles: true }),
    );
    await until("did not store the typed value");
  } finally {
    _unmount(handle);
    console.warn = orig;
    g.__aioDev = had;
    await closeWindow(win);
  }
});

Deno.test("dev layer: setDevMode(true) without it says which checks are missing — once", () => {
  // What a production bundle is: every slot of the layer empty.
  const kept = { ...devHooks };
  const lines: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    _said.delete("devmode-prod");
    setDevMode(true);
    setDevMode("auto");
    assertEquals(lines, [], "the layer is installed: nothing to say");
    for (const k of AIR_SLOTS) delete devHooks[k];
    setDevMode(false);
    setDevMode("auto");
    assertEquals(lines, [], "only forcing it ON promises the checks");
    setDevMode(true);
    setDevMode(true);
    assertEquals(lines.length, 1, lines.join("\n"));
    for (const check of ["accessibility", "key", "re-render-loop"]) {
      assert(lines[0]!.includes(check), lines[0]);
    }
    assert(lines[0]!.includes("`deno task dev`"), lines[0]);
  } finally {
    Object.assign(devHooks, kept);
    setDevMode("auto");
    _said.delete("devmode-prod");
    console.warn = orig;
  }
});

Deno.test("dev layer: testUI's graph has the fetched chunk's hooks too", async () => {
  // The chunk a dev PAGE fetches (contrast and #id audits, the read-only
  // hint, the `am surface` / `am trigger` engine) needs the browser runtime;
  // the harness imports it statically.
  await import("../src/testing/ui-test.ts");
  const chunk = [
    "auditContrast",
    "auditIdSelectors",
    "uiRemote",
    "readOnlyHint",
  ] as const;
  assertEquals(chunk.filter((k) => devHooks[k] === null), []);
});

Deno.test("dev layer: a dev chunk that cannot load says so once, and names a command that exists", async () => {
  // Its own module instance: the once-only latch has no reset, by design.
  const fresh = await import(
    `../src/air/dev-hooks.ts#${crypto.randomUUID()}`
  ) as typeof import("../src/air/dev-hooks.ts");
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  try {
    fresh._setDevChunkLoader(() => Promise.reject(new Error("404")));
    await fresh.loadDevChunk();
    await fresh.loadDevChunk();
  } finally {
    console.error = orig;
  }
  assertEquals(lines.length, 1, lines.join("\n"));
  assert(lines[0]!.includes("NOT running on this page"), lines[0]);
  assert(lines[0]!.includes("`deno task dev` serves them"), lines[0]);
  // There is no `aio` binary (docs gate: "commands the docs teach").
  assert(!lines[0]!.includes("`aio dev`"), lines[0]);
});

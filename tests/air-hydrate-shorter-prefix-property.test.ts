// Hydrating server markup that the client tree only PARTLY matches — a text
// that became a shorter prefix, a list that lost its tail, a fragment or a
// component that renders less — must never leave the server's surplus on the
// page. The class: random trees A, a client tree B cut from A (texts
// shortened to a prefix, children dropped from the end or the middle), SSR(A)
// hydrated with B. Whatever hydrate decides (adopt, patch, or fall back to a
// full render), the document must equal a fresh mount of B — before and after
// B then re-renders.
//
//     FUZZ_SEED=7 deno test -A tests/air-hydrate-shorter-prefix-property.test.ts
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { Fragment, h, Portal, renderToString } from "../src/air/vdom.ts";
import type { ComponentFn, VNode } from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  mount,
  setDevMode,
} from "../src/air/aio-renderer.ts";
import { hydrate } from "../src/air/renderer-hydrate.ts";
import { signal } from "../src/state/signal.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";

const SEED = fuzzEnvInt("FUZZ_SEED", 0x9f1e) & 0x7fffffff;
const ROUNDS = fuzzEnvInt("FUZZ_ROUNDS", 300, 1);

function rng(seed: number): () => number {
  let s = seed || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

type Spec =
  | { k: "t"; v: string }
  | { k: "s"; v: string } // a signal child
  | { k: "e"; tag: string; kids: Spec[] }
  | { k: "f"; kids: Spec[] }
  | { k: "c"; kids: Spec[] };

const C: ComponentFn = (p) =>
  h(Fragment, null, ...((p.children ?? []) as VNode[]));

/** Signals are per tree position so both worlds read the same values. */
const SIGS: ReturnType<typeof signal<string>>[] = [];
function build(s: Spec, sigs = { i: 0 }): VNode | string {
  switch (s.k) {
    case "t":
      return s.v;
    case "s": {
      const sig = SIGS[sigs.i++] ??= signal("");
      sig.set(s.v);
      return sig as unknown as VNode;
    }
    case "e":
      return h(s.tag, null, ...s.kids.map((k) => build(k, sigs) as VNode));
    case "f":
      return h(Fragment, null, ...s.kids.map((k) => build(k, sigs) as VNode));
    case "c":
      return h(C, null, ...s.kids.map((k) => build(k, sigs) as VNode));
  }
}

Deno.test("hydrate: SSR of a longer tree hydrated with its cut-down client tree equals a fresh mount of the client tree", async () => {
  const rand = rng(SEED);
  const pick = (n: number) => Math.floor(rand() * n);
  const word = () => ["abc", "ab", "a", "xyz", " "][pick(5)]!;
  const gen = (d: number): Spec => {
    const r = pick(10);
    if (d <= 0 || r < 4) {
      return rand() < 0.3 ? { k: "s", v: word() } : { k: "t", v: word() };
    }
    const kids = Array.from({ length: pick(4) }, () => gen(d - 1));
    if (r < 6) return { k: "e", tag: ["p", "i"][pick(2)]!, kids };
    if (r < 8) return { k: "f", kids };
    return { k: "c", kids };
  };
  /** B from A: a prefix of a text, a dropped child — never anything new. */
  const cut = (s: Spec): Spec => {
    if (s.k === "t" || s.k === "s") {
      return rand() < 0.4 ? { ...s, v: s.v.slice(0, pick(s.v.length)) } : s;
    }
    let kids = s.kids.map(cut);
    if (kids.length && rand() < 0.4) {
      kids = rand() < 0.5
        ? kids.slice(0, pick(kids.length))
        : kids.filter((_, i) => i !== pick(kids.length));
    }
    return { ...s, kids };
  };

  const origWarn = console.warn, origErr = console.error;
  console.warn = () => {};
  console.error = () => {};
  setDevMode(true);
  const bad: string[] = [];
  try {
    for (let round = 0; round < ROUNDS && bad.length < 4; round++) {
      const a: Spec = { k: "e", tag: "div", kids: [gen(3), gen(3), gen(2)] };
      const b = cut(a);
      const win = new Window({ url: "http://localhost/" });
      const doc = win.document as unknown as Document;
      _setDocument(doc as never);
      doc.body.innerHTML = `<div id="h"></div><div id="r"></div>`;
      const host = doc.getElementById("h")!, refEl = doc.getElementById("r")!;
      host.innerHTML = renderToString(build(a) as VNode);
      const tick = signal(0);
      const App = () => {
        void tick.value;
        return build(b) as VNode;
      };
      const hh = hydrate(host, App);
      hh._flush();
      const hr = mount(refEl, App);
      hr._flush();
      const repro = (why: string) =>
        `FUZZ_SEED=${SEED} round ${round}: ${why}\n  A=${
          JSON.stringify(a)
        }\n  B=${
          JSON.stringify(b)
        }\n  got=${host.innerHTML}\n  want=${refEl.innerHTML}`;
      if (host.innerHTML !== refEl.innerHTML) bad.push(repro("after hydrate"));
      else {
        tick.set(1);
        hh._flush();
        hr._flush();
        if (host.innerHTML !== refEl.innerHTML) {
          bad.push(repro("after a re-render"));
        }
      }
      _unmount(hh);
      _unmount(hr);
      await closeWindow(win);
    }
  } finally {
    console.warn = origWarn;
    console.error = origErr;
    setDevMode(false);
  }
  assertEquals(bad, []);
});

Deno.test("hydrate: a surplus server ELEMENT inside the app is removed; a node a script/extension appended to the root container is kept", async () => {
  const win = new Window({ url: "http://localhost/" });
  const doc = win.document as unknown as Document;
  _setDocument(doc as never);
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  host.innerHTML =
    `<ul><li>a</li><li>deleted</li>stale<!----></ul><span id="ext"></span>`;
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  setDevMode(true);
  const items = signal(["a"]);
  const hh = hydrate(
    host,
    () => h("ul", null, ...items.value.map((t) => h("li", { key: t }, t))),
  );
  hh._flush();
  try {
    assertEquals(host.innerHTML, `<ul><li>a</li></ul><span id="ext"></span>`);
    assertEquals(warns.some((w) => w.includes("removed")), true);
    items.set(["b", "a"]);
    hh._flush();
    assertEquals(
      host.innerHTML,
      `<ul><li>b</li><li>a</li></ul><span id="ext"></span>`,
    );
  } finally {
    console.warn = origWarn;
    setDevMode(false);
    _unmount(hh);
    await closeWindow(win);
  }
});

Deno.test("hydrate: what an action appends while the element hydrates is not server surplus", async () => {
  const win = new Window({ url: "http://localhost/" });
  const doc = win.document as unknown as Document;
  _setDocument(doc as never);
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  host.innerHTML = `<p>a</p>`;
  const ripple = (el: HTMLElement) => {
    el.appendChild(doc.createElement("s"));
  };
  const hh = hydrate(host, () => h("p", { use: ripple }, "a"));
  hh._flush();
  try {
    assertEquals(host.innerHTML, "<p>a<s></s></p>");
  } finally {
    _unmount(hh);
    await closeWindow(win);
  }
});

Deno.test("hydrate: a portal into a target claimed AFTER it keeps its content — client content is not server surplus", async () => {
  const win = new Window({ url: "http://localhost/" });
  const doc = win.document as unknown as Document;
  _setDocument(doc as never);
  const host = doc.createElement("div");
  doc.body.appendChild(host);
  host.innerHTML = `<main><section></section></main>`;
  const target = host.querySelector("section")!;
  const App = () =>
    h(
      "main",
      null,
      h(Portal as never, { target }, h("b", null, "modal")),
      h("section", null),
    );
  const hh = hydrate(host, App);
  hh._flush();
  try {
    assertEquals(target.querySelector("b")?.textContent, "modal");
  } finally {
    _unmount(hh);
    await closeWindow(win);
  }
});

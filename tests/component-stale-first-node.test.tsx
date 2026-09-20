/** @jsxImportSource aio */
// A component child whose ROOT SWAPS on its own re-render is still where the
// parent thinks it is.
//
// The fragment half of this class is `fragment-stale-region-anchor.test.tsx`;
// this is the same staleness one level in. A component's `_dom` is a COPY of
// its output's first node, refreshed only when THAT vnode is diffed. A
// component NESTED below it re-renders on its own signal and swaps its root
// element — one dialog giving way to the next — so the node changes and no
// ancestor's copy hears about it. The parent's next diff then reads a detached
// node as "where child i is".
//
// A field report caught it from the tripwire side (`<div class="…"> inside
// <WalletPage> holds the wrong node at child 6`, twice, at the moment one
// dialog replaced the next): the render was correct, nothing was damaged, and
// the message told the author to give static siblings keys or file an aio bug.
// A tripwire that fires when nothing is wrong teaches the reader to ignore the
// real one. The same stale copy is the anchor every insert, move and removal in
// the pass is walked from, so a pass that DID move nodes walked from the wrong
// place — which is what the second block drives.
import { assertEquals } from "@std/assert";
import { testUI } from "../src/testing/ui-test.ts";
import { signal } from "../src/state/signal.ts";

const WARNS: string[] = [];
const _origWarn = console.warn;
console.warn = (...a: unknown[]) => {
  WARNS.push(a.map(String).join(" "));
  _origWarn(...a);
};
const reconcilerWarnings = (from: number) =>
  WARNS.slice(from).filter((w) =>
    /desync|diffed against|without its DOM position/.test(w)
  );

const html = (sel: string) =>
  (globalThis as { document?: Document }).document!.querySelector(sel)!
    .innerHTML.replace(/ data-component="[^"]*"/g, "");

// ── the reported shape ────────────────────────────────────────────────

const kind = signal("a");
const bump = signal(0);

// The only reader of `kind`, so it re-renders BY ITSELF — and returns a
// different element per value.
function Dialog() {
  return kind.value === "a"
    ? <p class="dlg-a">A</p>
    : kind.value === "b"
    ? <section class="dlg-b">B</section>
    : null;
}
// One level of indirection: `ActiveDialog` does not read `kind`, so its own
// `_dom` is never refreshed by the swap below it.
function ActiveDialog() {
  return <Dialog />;
}
function WalletPage() {
  return (
    <div class="app">
      <header>h</header>
      <span class="bump">{bump.value}</span>
      <ActiveDialog />
      <footer>f</footer>
    </div>
  );
}

testUI(
  WalletPage as never,
  "a nested component swapping its root leaves the parent aligned",
  async (ui) => {
    const before = WARNS.length;
    await ui.settle();
    const want = (k: string, n: number) =>
      `<header>h</header><span class="bump">${n}</span>` +
      (k === "a"
        ? '<p class="dlg-a">A</p>'
        : k === "b"
        ? '<section class="dlg-b">B</section>'
        : "<!---->") +
      "<footer>f</footer>";

    for (
      const [k, n] of [["b", 1], ["c", 2], ["a", 3], ["c", 4], [
        "b",
        5,
      ]] as const
    ) {
      kind.set(k); // the nested component re-renders on its own…
      await ui.settle();
      bump.set(n); // …and only now does the PARENT diff its children
      await ui.settle();
      assertEquals(html("div.app"), want(k, n), `after ${k}/${n}`);
    }
    assertEquals(
      reconcilerWarnings(before),
      [],
      "the render is correct — the tripwire must stay quiet",
    );
  },
);

// ── the same staleness where nodes actually MOVE ──────────────────────

const rows = signal(["x", "y"]);
const leafKind = signal("p");

function Leaf() {
  return leafKind.value === "p" ? <p class="leaf">L</p> : <b class="leaf">L</b>;
}
function Slot() {
  return <Leaf />;
}
function MovingList() {
  return (
    <ul>
      <Slot />
      {rows.value.map((r) => <li key={r}>{r}</li>)}
    </ul>
  );
}

testUI(
  MovingList as never,
  "the stale copy is not the anchor a moving diff walks from",
  async (ui) => {
    const before = WARNS.length;
    await ui.settle();
    assertEquals(
      html("ul"),
      '<p class="leaf">L</p><li>x</li><li>y</li>',
      "mount",
    );
    leafKind.set("b"); // swaps the node the list's first child sits on
    await ui.settle();
    assertEquals(
      html("ul"),
      '<b class="leaf">L</b><li>x</li><li>y</li>',
      "swap",
    );
    rows.set(["y", "x", "z"]); // a pass that really moves and inserts nodes
    await ui.settle();
    assertEquals(
      html("ul"),
      '<b class="leaf">L</b><li>y</li><li>x</li><li>z</li>',
    );
    assertEquals(reconcilerWarnings(before), []);
  },
);

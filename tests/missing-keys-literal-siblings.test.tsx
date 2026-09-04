// The "missing keys" warning is about LISTS — children that came out of an
// array expression, where keys are how the reconciler follows rows that move.
// Siblings written out by hand never move, and positional reconciliation of
// them is always right; warned for them anyway, the check fired on every boot
// of the visual app manager (a sidebar of four literal `<div>` panes), pointing
// at a "fix" that changes nothing. Same rule as React: warn for array children
// only. `mixed-keys` and `dup-key` are untouched — a literal sibling beside a
// keyed list really does break keyed moves.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h, setDevMode } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

function withDom<T>(fn: (doc: Document, root: HTMLElement) => T): T {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Document;
  const root = doc.createElement("div");
  doc.body.appendChild(root);
  _setDocument(doc);
  try {
    return fn(doc, root);
  } finally {
    win.happyDOM.close();
  }
}

/** Mount `App`, re-render it `rerenders` times (the key checks run in the
 *  child DIFF, which a first mount never reaches — the visual app manager
 *  "warns on every boot" because state arrives right after), collect the
 *  dev warnings, unmount. `setDevMode` is toggled so the once-per-id warning
 *  cache starts empty for every case. */
function warningsOf(App: () => unknown, rerenders = 1): string[] {
  return withDom((_doc, root) => {
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) =>
      void warns.push(a.map(String).join(" "));
    setDevMode(false);
    setDevMode(true);
    try {
      const gen = signal(0);
      const Root = () => {
        void gen.value;
        return App();
      };
      // deno-lint-ignore no-explicit-any
      const handle = mount(root, Root as any);
      for (let i = 0; i < rerenders; i++) {
        gen.set(gen.peek() + 1);
        handle._flush();
      }
      _unmount(handle);
    } finally {
      setDevMode(false);
      console.warn = orig;
    }
    return warns;
  });
}
const missing = (w: string[]) => w.filter((m) => m.includes("without keys"));
const mixed = (w: string[]) => w.filter((m) => m.includes("Mixed keyed"));

Deno.test("(a) four literal <div> siblings do not warn about keys", () => {
  const App = () => (
    <div id="sidebar">
      <div>Files</div>
      <div>Search</div>
      <div>Git</div>
      <div>Debug</div>
    </div>
  );
  const w = warningsOf(App, 2);
  assertEquals(missing(w), [], `literal siblings: ${JSON.stringify(w)}`);
  assertEquals(mixed(w), []);
});

Deno.test("(a') literal siblings handed on through a wrapper's {children} stay literal", () => {
  const Panel = (p: { children?: unknown }) => (
    <section class="panel">{p.children}</section>
  );
  const App = () => (
    <Panel>
      <div>Files</div>
      <div>Search</div>
      <div>Git</div>
    </Panel>
  );
  assertEquals(missing(warningsOf(App, 2)), []);
});

Deno.test("(a'') classic h(): literal rest-argument siblings do not warn", () => {
  const App = () =>
    h("div", null, h("p", null, "a"), h("p", null, "b"), h("p", null, "c"));
  assertEquals(missing(warningsOf(App, 2)), []);
});

Deno.test("(b) an unkeyed .map list warns, and names the parent", () => {
  const items = ["Files", "Search", "Git"];
  const App = () => (
    <ul id="tabs">
      {items.map((i) => <li>{i}</li>)}
    </ul>
  );
  const w = missing(warningsOf(App));
  assertEquals(w.length, 1, JSON.stringify(w));
  assert(w[0]!.includes("3 <li> children without keys"), w[0]);
  assert(w[0]!.includes("inside <ul#tabs>"), `names the parent: ${w[0]}`);
  assert(w[0]!.includes('"Files"'), `samples the rows: ${w[0]}`);
});

Deno.test("(b') a .map list beside a literal sibling still warns (nested array)", () => {
  const items = ["a", "b", "c"];
  const App = () => (
    <ul>
      <li>head</li>
      {items.map((i) => <li>{i}</li>)}
    </ul>
  );
  assertEquals(missing(warningsOf(App)).length, 1);
});

Deno.test("(b'') classic h(): a nested array argument warns", () => {
  const App = () => h("ul", null, ["a", "b", "c"].map((i) => h("li", null, i)));
  assertEquals(missing(warningsOf(App)).length, 1);
});

Deno.test("(c) a literal sibling next to a KEYED .map list is still mixed-keys", () => {
  const items = ["a", "b", "c"];
  const App = () => (
    <ul id="mixed">
      <li>head</li>
      {items.map((i) => <li key={i}>{i}</li>)}
    </ul>
  );
  const w = warningsOf(App);
  assertEquals(mixed(w).length, 1, JSON.stringify(w));
  assert(mixed(w)[0]!.includes("inside <ul#mixed>"));
  assertEquals(missing(w), [], "keyed rows are not 'missing keys'");
});

Deno.test("dup-key is unchanged", () => {
  const App = () => (
    <ul>
      {["a", "a", "b"].map((i) => <li key={i}>{i}</li>)}
    </ul>
  );
  const w = warningsOf(App);
  assertEquals(w.filter((m) => m.includes('Duplicate key "a"')).length, 1);
});

// The dedupe id used to be the KIND ("missing-keys"), so a page with three
// offending parents reported the first and the second surfaced only once the
// first was fixed. The id is the SITE now: every distinct one warns once, and
// all of them on the first boot.
Deno.test("dedupe is per site: two parents both warn, one parent warns once", () => {
  const items = ["a", "b", "c"];
  const Two = () => (
    <div>
      <ul id="one">{items.map((i) => <li>{i}</li>)}</ul>
      <ol id="two">{items.map((i) => <li>{i}</li>)}</ol>
    </div>
  );
  const w = missing(warningsOf(Two, 3)); // three re-renders of the same page
  assertEquals(w.length, 2, JSON.stringify(w));
  assert(w[0]!.includes("inside <ul#one>"), w[0]);
  assert(w[1]!.includes("inside <ol#two>"), w[1]);

  const MixedTwo = () => (
    <div>
      <ul id="m1">
        <li>head</li>
        {items.map((i) => <li key={i}>{i}</li>)}
      </ul>
      <ul id="m2">
        <li>head</li>
        {items.map((i) => <li key={i}>{i}</li>)}
      </ul>
    </div>
  );
  const m = mixed(warningsOf(MixedTwo, 3));
  assertEquals(m.length, 2, JSON.stringify(m));
  assert(m[0]!.includes("inside <ul#m1>") && m[1]!.includes("inside <ul#m2>"));
});

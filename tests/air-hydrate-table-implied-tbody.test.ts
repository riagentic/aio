// A server-rendered `<table><tr>` must hydrate, not be thrown away.
//
// Both SSR writers emit a table exactly as it is written — `<table><tr>…` —
// and mount builds exactly that, because the DOM API keeps a `<tr>` where it is
// put. The HTML PARSER does not: it wraps the rows in a `<tbody>` (and a bare
// `<col>` in a `<colgroup>`) that no vnode describes. Hydration met `TBODY`
// where the vnode said `tr`, reported a mismatch and fell back to a full client
// render: measured before the fix, the server's `<td>` was not the node on
// screen after `hydrate()` — every server-rendered table cost its app the SSR
// of the whole page, with the dev channel blaming Date/random/window.
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import {
  type ComponentFn,
  h,
  renderToString,
  setDevMode,
  type VChild,
} from "../src/air/vdom.ts";
import {
  _setDocument,
  _unmount,
  hydrate,
  mount,
} from "../src/air/aio-renderer.ts";
import { signal } from "../src/state/signal.ts";

const C = (fn: unknown) => fn as ComponentFn;

type Doc = Document;

async function withDoc(body: (doc: Doc) => void | Promise<void>) {
  const win = new Window({ url: "https://localhost" });
  const doc = win.document as unknown as Doc;
  _setDocument(doc);
  try {
    await body(doc);
  } finally {
    await closeWindow(win);
  }
}

/** What mount builds for `App` right now. */
function mounted(doc: Doc, App: ComponentFn): string {
  const host = doc.createElement("main");
  const handle = mount(host, App);
  const html = host.innerHTML;
  _unmount(handle);
  return html;
}

/** Hydrate `App` over its PARSED server markup; the `[aio-dev]` lines it
 *  printed, the host, and the handle. */
function hydrated(doc: Doc, App: ComponentFn) {
  const host = doc.createElement("main");
  doc.body.appendChild(host);
  host.innerHTML = renderToString(h(App, null));
  const warns: string[] = [];
  const orig = console.warn;
  setDevMode(false);
  setDevMode(true);
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  try {
    const serverCells = [...host.querySelectorAll("td,col")];
    const handle = hydrate(host, App);
    const adopted = serverCells.every((n, i) =>
      host.querySelectorAll("td,col")[i] === n
    );
    return { host, handle, warns, adopted, cells: serverCells.length };
  } finally {
    console.warn = orig;
    setDevMode(false);
  }
}

const row = (k: string): VChild => h("tr", { key: k }, h("td", null, k));

Deno.test("hydrate table: rows the parser wrapped in <tbody> are adopted, and later updates match mount", async () => {
  await withDoc((doc) => {
    const rows = signal(["a", "b"]);
    const App = C(() =>
      h(
        "table",
        null,
        h("tr", null, h("td", null, "head")),
        ...rows.value.map(row),
      )
    );
    // The premise: the parser really does invent the wrapper.
    const probe = doc.createElement("div");
    probe.innerHTML = renderToString(h(App, null));
    assertEquals(probe.querySelector("table > tbody > tr") !== null, true);

    const { host, handle, warns, adopted, cells } = hydrated(doc, App);
    assertEquals(cells, 3);
    assertEquals(adopted, true, "the server's cells are the ones on screen");
    assertEquals(warns, []);
    assertEquals(host.innerHTML, mounted(doc, App));

    rows.set(["b", "a", "c"]);
    handle._flush();
    assertEquals(host.innerHTML, mounted(doc, App));
    _unmount(handle);
  });
});

Deno.test("hydrate table: thead + rows + tfoot", async () => {
  await withDoc((doc) => {
    const App = C(() =>
      h(
        "table",
        null,
        h("thead", null, h("tr", null, h("td", null, "h"))),
        h("tr", null, h("td", null, "1")),
        h("tr", null, h("td", null, "2")),
        h("tfoot", null, h("tr", null, h("td", null, "f"))),
      )
    );
    const { host, handle, warns, adopted, cells } = hydrated(doc, App);
    assertEquals(cells, 4);
    assertEquals(adopted, true);
    assertEquals(warns, []);
    assertEquals(host.innerHTML, mounted(doc, App));
    _unmount(handle);
  });
});

Deno.test("hydrate table: a <col> the parser wrapped in <colgroup>", async () => {
  await withDoc((doc) => {
    const App = C(() =>
      h(
        "table",
        null,
        h("col", { span: "2" }),
        h("tr", null, h("td", null, "1")),
      )
    );
    assertEquals(
      renderToString(h(App, null)),
      '<table><col span="2"><tr><td>1</td></tr></table>',
    );
    // happy-dom's parser foster-parents a bare <col> OUT of the table instead
    // of implying the <colgroup> the HTML spec (and every browser) does, so the
    // browser's parse is written out by hand.
    const host = doc.createElement("main");
    doc.body.appendChild(host);
    host.innerHTML =
      '<table><colgroup><col span="2"></colgroup><tbody><tr><td>1</td></tr></tbody></table>';
    const col = host.querySelector("col");
    const td = host.querySelector("td");
    const handle = hydrate(host, App);
    assertEquals(host.querySelector("col") === col, true, "col adopted");
    assertEquals(host.querySelector("td") === td, true, "td adopted");
    assertEquals(host.innerHTML, mounted(doc, App));
    _unmount(handle);
  });
});

Deno.test("hydrate table: an AUTHORED <tbody> is left alone", async () => {
  await withDoc((doc) => {
    const App = C(() =>
      h(
        "table",
        null,
        h("tbody", { class: "rows" }, h("tr", null, h("td", null, "1"))),
        h("tbody", null, h("tr", null, h("td", null, "2"))),
      )
    );
    const { host, handle, warns, adopted } = hydrated(doc, App);
    assertEquals(adopted, true);
    assertEquals(warns, []);
    assertEquals(host.querySelectorAll("tbody").length, 2);
    assertEquals(host.innerHTML, mounted(doc, App));
    _unmount(handle);
  });
});

Deno.test("hydrate table: rows from a component and a null slot between them", async () => {
  await withDoc((doc) => {
    const show = signal(false);
    const Row = C((p: { k: string }) => h("tr", null, h("td", null, p.k)));
    const Maybe = C(() =>
      show.value ? h("tr", null, h("td", null, "m")) : null
    );
    const App = C(() =>
      h(
        "table",
        null,
        h(Maybe, null),
        h(Row, { k: "1" }),
        h(Maybe, null),
        h(Row, { k: "2" }),
      )
    );
    const { host, handle, warns, adopted } = hydrated(doc, App);
    assertEquals(adopted, true);
    assertEquals(warns, []);
    assertEquals(host.innerHTML, mounted(doc, App));
    show.set(true);
    handle._flush();
    assertEquals(host.innerHTML, mounted(doc, App));
    _unmount(handle);
  });
});

// Unmounting the last `useHead` owner hands the title back to the document the
// app is MOUNTED in — the one it took it from.
//
// `useHead` resolves the document from the active root, and there is one only
// while a render runs. The cleanup that restores the title runs at a root
// `_unmount`, where none is active, so it fell back to `globalThis.document`.
// Measured before the fix:
//
//   BYO document, no global   title stays "Page", the meta tag stays
//   app in window B, global A  B keeps "Page" + its meta tag, and A — never
//                              touched by the app — is retitled to B's
//                              saved title "orig"
import { assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { closeWindow } from "../src/testing/close-window.ts";
import { type ComponentFn, h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { _resetHead, useHead } from "../src/air/head.ts";
import { signal } from "../src/state/signal.ts";

const C = (fn: unknown) => fn as ComponentFn;

type Ambient = "none" | "other window";

async function scenario(
  ambient: Ambient,
  body: (app: Document, other: Document) => void,
): Promise<void> {
  _resetHead();
  const win = new Window({ url: "http://localhost/" });
  const other = new Window({ url: "http://localhost/" });
  const doc = win.document as unknown as Document;
  const otherDoc = other.document as unknown as Document;
  doc.title = "orig";
  otherDoc.title = "A";
  const had = Object.getOwnPropertyDescriptor(globalThis, "document");
  if (ambient === "none") {
    delete (globalThis as Record<string, unknown>).document;
  } else {
    Object.defineProperty(globalThis, "document", {
      get: () => otherDoc,
      configurable: true,
    });
  }
  _setDocument(doc);
  try {
    body(doc, otherDoc);
  } finally {
    _setDocument(null as never);
    if (had) Object.defineProperty(globalThis, "document", had);
    else delete (globalThis as Record<string, unknown>).document;
    _resetHead();
    await closeWindow(win);
    await closeWindow(other);
  }
}

const Page = C(() => {
  useHead({ title: "Page", meta: [{ name: "description", content: "d" }] });
  return h("p", null, ["p"]);
});

const owned = (d: Document) =>
  d.head.querySelectorAll("[data-aio-head]").length;

for (const ambient of ["none", "other window"] as const) {
  Deno.test(`useHead: a root unmount restores the MOUNTED document's title and tags — ambient document: ${ambient}`, async () => {
    await scenario(ambient, (doc, otherDoc) => {
      const root = doc.createElement("div");
      doc.body.appendChild(root);
      const hd = mount(root, C(() => h("div", null, [h(Page, null)])));
      assertEquals([doc.title, owned(doc)], ["Page", 1]);
      _unmount(hd);
      assertEquals([doc.title, owned(doc)], ["orig", 0]);
      assertEquals([otherDoc.title, owned(otherDoc)], ["A", 0]);
    });
  });
}

Deno.test("useHead: two documents keep their own owners and their own base titles", async () => {
  await scenario("none", (doc, otherDoc) => {
    const show = signal(true);
    const rootA = doc.createElement("div");
    doc.body.appendChild(rootA);
    const hdA = mount(
      rootA,
      C(() => h("div", null, [show.value ? h(Page, null) : "none"])),
    );
    _setDocument(otherDoc);
    const rootB = otherDoc.createElement("div");
    otherDoc.body.appendChild(rootB);
    const Other = C(() => {
      useHead({ title: "Other" });
      return h("p", null, ["o"]);
    });
    const hdB = mount(rootB, C(() => h("div", null, [h(Other, null)])));
    assertEquals([doc.title, otherDoc.title], ["Page", "Other"]);
    assertEquals([owned(doc), owned(otherDoc)], [1, 0], "B has no meta of A's");

    show.set(false);
    hdA._flush();
    assertEquals([doc.title, otherDoc.title], ["orig", "Other"]);
    _unmount(hdB);
    assertEquals([doc.title, otherDoc.title], ["orig", "A"]);
    _unmount(hdA);
    assertEquals([owned(doc), owned(otherDoc)], [0, 0]);
  });
});

// `useHead()` — per-page <head>, on both sides of the wire.
//
// The gap it closes: `ui.head` was one boot-time string for the whole app,
// and nothing in AIR could say "this page is called X". These tests are the
// contract: the mounted page owns document.title and its tags, the innermost
// owner wins, unmounting hands the title back, SSR collects the same entries
// into markup for the caller's <head> (and never touches a document, never
// warns), and one SSR render's head does not leak into the next.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { collectHead, renderToString, useHead } from "../src/air.ts";
import { renderToStream } from "../src/air/ssr-stream.ts";
import { _resetHead } from "../src/air/head.ts";
import { signal } from "../src/state/signal.ts";
import { testUI } from "../src/cell-test.ts";

const which = signal<"home" | "post" | "none">("home");

function Layout({ children }: { children?: unknown }) {
  useHead({
    title: "Notes",
    meta: [
      { name: "description", content: "all the notes" },
      { property: "og:site_name", content: "Notes" },
    ],
    link: [{ rel: "canonical", href: "https://notes.example/" }],
  });
  return <div class="layout">{children}</div>;
}

function Home() {
  return <p>home</p>;
}

function Post() {
  useHead({
    title: "Milk — Notes",
    meta: [{ name: "description", content: "the milk note" }],
    link: [{ rel: "canonical", href: "https://notes.example/p/milk" }],
  });
  return <article>milk</article>;
}

function App() {
  const w = which.value;
  return (
    <Layout>
      {w === "home" ? <Home /> : w === "post" ? <Post /> : null}
    </Layout>
  );
}

function headTags(doc: Document): string[] {
  return Array.from(doc.head.querySelectorAll("[data-aio-head]")).map((el) =>
    el.outerHTML
  );
}

Deno.test("useHead: the page owns the title; innermost wins; unmount hands it back", async () => {
  _resetHead();
  which.set("home");
  await using ui = await testUI(App);
  const doc = ui.document as Document;
  await ui.settle();
  assertEquals(doc.title, "Notes");
  let tags = headTags(doc);
  assertEquals(tags.length, 3, tags.join("\n"));
  assertStringIncludes(tags[0]!, 'content="all the notes"');

  which.set("post");
  await ui.settle();
  assertEquals(doc.title, "Milk — Notes");
  tags = headTags(doc);
  // Deduplicated by identity: the page's description REPLACES the layout's,
  // in the layout's position; og:site_name is untouched; canonical is one
  // per page and the page's wins.
  assertEquals(tags.length, 3, tags.join("\n"));
  assertStringIncludes(tags[0]!, 'content="the milk note"');
  assert(!tags.join("").includes("all the notes"));
  assertStringIncludes(tags.join(""), 'href="https://notes.example/p/milk"');
  assert(!tags.join("").includes('href="https://notes.example/"'));

  which.set("home");
  await ui.settle();
  assertEquals(
    doc.title,
    "Notes",
    "the layout's title is back when the page unmounts",
  );
  assertStringIncludes(headTags(doc).join(""), "all the notes");
});

Deno.test("useHead: the last owner gone restores the document's own title", async () => {
  _resetHead();
  const on = signal(false);
  function Page() {
    useHead({ title: "Owned" });
    return <p>page</p>;
  }
  function Root() {
    return <div>{on.value ? <Page /> : null}</div>;
  }
  await using ui = await testUI(Root);
  const doc = ui.document as Document;
  await ui.settle();
  const before = doc.title; // whatever the document had before any owner
  on.set(true);
  await ui.settle();
  assertEquals(doc.title, "Owned");
  on.set(false);
  await ui.settle();
  assertEquals(doc.title, before);
  assertEquals(headTags(doc).length, 0);
});

Deno.test("useHead: SSR collects the head as markup, escaped, and never warns", () => {
  _resetHead();
  which.set("post");
  const warned: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => warned.push(a.join(" "));
  try {
    const body = renderToString(<App />);
    assert(
      !body.includes("<title"),
      "the title belongs in <head>, not the body",
    );
    const head = collectHead();
    assertStringIncludes(head, "<title>Milk — Notes</title>");
    assertStringIncludes(
      head,
      '<meta name="description" content="the milk note" data-aio-head>',
    );
    assertStringIncludes(
      head,
      '<link rel="canonical" href="https://notes.example/p/milk" data-aio-head>',
    );
    assert(
      !head.includes("all the notes"),
      "deduplicated on the server exactly as on the client",
    );
  } finally {
    console.warn = orig;
  }
  assertEquals(warned, [], "SSR must not trip the outside-a-render warnings");
});

Deno.test("useHead: SSR escapes, and one render's head does not leak into the next", () => {
  _resetHead();
  function Evil() {
    useHead({
      title: `<script>alert(1)</script> & "quotes"`,
      meta: [{ name: "description", content: `a "b" <c>` }],
    });
    return <p>x</p>;
  }
  renderToString(<Evil />);
  const head = collectHead();
  assert(!head.includes("<script>"), head);
  assertStringIncludes(head, "&lt;script&gt;");
  assert(!head.includes('content="a "b"'), head);

  renderToString(<p>no head at all</p>);
  assertEquals(collectHead(), "", "a fresh top-level render starts empty");
});

Deno.test("useHead: outside a component render it is dropped, loudly in dev", () => {
  _resetHead();
  const warned: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => warned.push(a.join(" "));
  try {
    useHead({ title: "nowhere" });
  } finally {
    console.warn = orig;
  }
  assertEquals(warned.length, 1);
  assertStringIncludes(
    warned[0]!,
    "useHead() called outside a component render",
  );
});

// ── A layout that re-renders must not take the page's head with it ────────
//
// `useHead` registers its cleanup in the component BODY, and a body cleanup
// runs before every re-render as well as on unmount. Entries lived in a Map
// keyed by instance and merged in INSERTION order, so a re-render deleted the
// entry and re-added it — moving that owner to the end, where "later wins"
// handed it the title. A layout re-rendering for a reason of its own (a theme
// signal, an unread count) silently took the title, the description and the
// canonical away from the page inside it, and kept them. SSR, one pass
// outside-in, got it right, so the app disagreed with itself across
// hydration.
const unread = signal(0);

function CountingLayout({ children }: { children?: unknown }) {
  useHead({
    title: "Layout",
    meta: [{ name: "description", content: "layout desc" }],
  });
  return (
    <div class="layout">
      <span class="badge">{String(unread())}</span>
      {children}
    </div>
  );
}

function PageWithHead() {
  useHead({
    title: "Page",
    meta: [{ name: "description", content: "page desc" }],
  });
  return <p>page</p>;
}

function NestedApp() {
  return (
    <CountingLayout>
      <PageWithHead />
    </CountingLayout>
  );
}

Deno.test("useHead: a layout re-render does not steal the page's head", async () => {
  _resetHead();
  unread.set(0);
  await using ui = await testUI(NestedApp);
  const doc = (globalThis as { document?: Document }).document!;
  const desc = () =>
    doc.head.querySelector('meta[name="description"]')?.getAttribute("content");
  assertEquals(doc.title, "Page", "the innermost owner wins on mount");
  assertEquals(desc(), "page desc");

  // Only the LAYOUT re-renders: its own signal changed, the page's did not.
  unread.set(1);
  await ui.settle();
  assertEquals(doc.title, "Page", "and still wins after the layout re-renders");
  assertEquals(desc(), "page desc");

  unread.set(2);
  await ui.settle();
  assertEquals(doc.title, "Page", "however many times it re-renders");
});

// ── The streamed page gets a head too ─────────────────────────────────────
//
// `_isSsrRendering()` was set only by `renderToString`. `renderToStream` is an
// async generator, so it never marked SSR at all and `useHead` took the
// CLIENT branch: a streamed page shipped with no title, no description and no
// canonical — silently in production, and in dev with a warning that told the
// author they had called `useHead` outside a component render when they had
// not.
Deno.test("useHead: renderToStream collects the head, like renderToString", async () => {
  _resetHead();
  let streamed = "";
  const { renderToStream } = await import("../src/air/ssr-stream.ts");
  const warn = console.warn;
  const warnings: string[] = [];
  console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
  try {
    for await (const chunk of renderToStream(<Post />)) streamed += chunk;
  } finally {
    console.warn = warn;
  }
  const head = collectHead();
  assertStringIncludes(streamed, "<article>milk</article>");
  assertStringIncludes(head, "<title>Milk — Notes</title>");
  assertStringIncludes(head, 'content="the milk note"');
  assertStringIncludes(head, 'href="https://notes.example/p/milk"');
  assertEquals(warnings, [], "and it does not accuse the author of anything");

  // The two renderers agree, which is the actual contract.
  _resetHead();
  renderToString(<Post />);
  assertEquals(collectHead(), head);
});

Deno.test("useHead: a stream leaves SSR mode when it ends", async () => {
  _resetHead();
  for await (const _ of renderToStream(<Post />)) { /* drain */ }
  // If the depth counter leaked, the next CLIENT render would take the SSR
  // branch and write nothing to the document.
  const { _isSsrRendering } = await import("../src/air/vdom-ssr.ts");
  assert(!_isSsrRendering(), "SSR depth must be back to zero after a stream");
});

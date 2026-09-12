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

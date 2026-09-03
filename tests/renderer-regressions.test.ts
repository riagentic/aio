// Named regressions in the AIR renderer — one test per defect that shipped.
//
// The differential fuzzer (renderer-differential.test.ts) pins these as CLASSES
// and is the reason they cannot come back. This file pins them as SHAPES: each
// test is the smallest program that reproduced the defect, so a failure names
// the bug instead of printing a random model. Both matter — the fuzzer finds
// what nobody thought of, these say what went wrong when it does.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { Window } from "happy-dom";
import {
  _diff,
  _render,
  ErrorBoundary,
  Fragment,
  h,
  Portal,
  renderToString,
  setDevMode,
  type VNode,
} from "../src/air/vdom.ts";
import { _hydrateNode } from "../src/air/renderer-hydrate.ts";
import { renderToStream } from "../src/air/ssr-stream.ts";
import { signal } from "../src/state/signal.ts";

function withDoc<T>(fn: (doc: Document, win: Window) => T): T {
  const win = new Window({ url: "https://localhost" });
  try {
    return fn(win.document as unknown as Document, win);
  } finally {
    win.happyDOM.close();
  }
}

/** Capture `console.warn` for the duration of `fn`. */
function withWarnings<T>(fn: (warns: string[]) => T): T {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  setDevMode(false);
  setDevMode(true);
  try {
    return fn(warns);
  } finally {
    setDevMode(false);
    console.warn = orig;
  }
}

// ── 1. a signal child is a signal child wherever it sits ──────────────────
//
// `h()` turns a signal child into a `_SignalText` vnode on ANY tag, but only
// the ELEMENT branch of `createDom` used to bind it. Under a Fragment, a
// Portal, a boundary, or a component that returns a Fragment, the text showed
// the signal's value at mount and never moved again — no error, no warning, a
// number frozen on screen.
Deno.test("a signal child updates under a Fragment, a Portal, a boundary and a component", () => {
  withDoc((doc) => {
    const n = signal(1);
    const CFrag = () => h(Fragment, null, "n=", n as unknown as VNode);
    const target = doc.createElement("aside");
    const shapes: Array<[string, () => VNode, () => string]> = [
      ["element", () => h("div", null, "n=", n as unknown as VNode), () => ""],
      [
        "fragment",
        () => h("div", null, h(Fragment, null, "n=", n as unknown as VNode)),
        () => "",
      ],
      [
        "boundary",
        () =>
          h(
            "div",
            null,
            h(
              ErrorBoundary as never,
              { fallback: () => "!" },
              "n=",
              n as unknown as VNode,
            ),
          ),
        () => "",
      ],
      ["component→fragment", () => h("div", null, h(CFrag, null)), () => ""],
    ];
    for (const [name, tree] of shapes) {
      n.set(1);
      const host = doc.createElement("main");
      const v = tree();
      _render(host, v, null, { doc });
      assertEquals(host.textContent, "n=1", `${name}: initial render`);
      n.set(2);
      assertEquals(
        host.textContent,
        "n=2",
        `${name}: a signal child did not follow its signal — it is bound only ` +
          `where the element branch happens to look`,
      );
      _diff(host, null, v, { doc });
    }

    // …and inside a Portal, where the text does not live under the host at all.
    n.set(1);
    const host = doc.createElement("main");
    const v = h(
      "div",
      null,
      h(Portal as never, { target }, "n=", n as unknown as VNode),
    );
    _render(host, v, null, { doc });
    assertEquals(target.textContent, "n=1");
    n.set(2);
    assertEquals(
      target.textContent,
      "n=2",
      "a signal child inside a Portal never bound",
    );
    _diff(host, null, v, { doc });
    assertEquals(target.innerHTML, "", "portal content leaked after unmount");
  });
});

// ── 2. hydration binds a signal child by DOM POSITION ─────────────────────
//
// The binding used to be looked up by ARRAY index into the parent's
// `childNodes`, which is not the child's DOM index whenever a sibling spans
// several nodes or none. A signal after a multi-node sibling bound the WRONG
// text node: the page updated a neighbour's text and left its own frozen.
Deno.test("hydration binds a signal child to its own node, after a multi-node sibling", () => {
  withDoc((doc) => {
    const s = signal(0);
    const tree = () =>
      h(
        "div",
        null,
        h(Fragment, null, h("i", null, "a"), h("i", null, "b")), // 2 nodes
        "S",
        s as unknown as VNode,
      );

    const host = doc.createElement("main");
    const v = tree();
    host.innerHTML = renderToString(v);
    assert(_hydrateNode(host, v, { doc }, false, 0) >= 0, "hydration mismatch");
    assertEquals(host.textContent, "abS0");
    s.set(1);
    assertEquals(
      host.textContent,
      "abS1",
      "the hydrated signal child is bound to the wrong text node — it was " +
        "located by array index, which is not its DOM position",
    );
    _diff(host, null, v, { doc });
  });
});

// ── 3. a Portal on a HYDRATED page ────────────────────────────────────────
//
// SSR emits nothing for a portal (its content belongs to a node the server
// document does not contain here), so hydration must CREATE it. It did not:
// the target stayed empty forever, and the next re-render tried to diff vnodes
// with no `_dom` and printed the reconciler's own "this is an aio bug" warning
// at a perfectly ordinary modal.
Deno.test("hydrate mounts a Portal's content, and the next update patches it", () => {
  withDoc((doc) => {
    withWarnings((warns) => {
      const label = signal("modal");
      const target = doc.createElement("aside");
      const tree = () =>
        h(
          "div",
          null,
          "page",
          h(
            Portal as never,
            { target },
            h("p", null, label as unknown as VNode),
          ),
          "end",
        );

      const host = doc.createElement("main");
      const v = tree();
      host.innerHTML = renderToString(v);
      assertEquals(target.innerHTML, "", "SSR must not write portal content");
      assert(
        _hydrateNode(host, v, { doc }, false, 0) >= 0,
        "hydration mismatch",
      );
      assertEquals(
        target.textContent,
        "modal",
        "a hydrated page's Portal is empty — SSR wrote nothing and hydration " +
          "created nothing",
      );
      label.set("modal2");
      assertEquals(target.textContent, "modal2");

      const v2 = tree();
      _diff(host, v2, v, { doc });
      assertEquals(target.textContent, "modal2");
      assertEquals(
        warns.filter((w) => /aio bug|no DOM node/.test(w)),
        [],
        "the reconciler reported its own corruption on a hydrated Portal",
      );
      _diff(host, null, v2, { doc });
    });
  });
});

// ── 4. portal content goes when its ANCESTOR goes ─────────────────────────
//
// `_removeDomCleanup` — the teardown for a subtree whose DOM is removed in one
// stroke (an ancestor element replaced, or removed by its parent) — had no
// Portal branch, so the modal stayed in `document.body` forever and reopening
// it stacked a second copy beside the first.
Deno.test("removing a Portal's ancestor empties the target, and reopening does not stack", () => {
  withDoc((doc) => {
    const target = doc.createElement("aside");
    const open = signal(true);
    const tree = () =>
      h(
        "div",
        null,
        open.peek()
          ? h(
            "div",
            { class: "wrap" },
            h(Portal as never, { target }, h("p", null, "modal")),
          )
          : null,
      );

    const host = doc.createElement("main");
    let v = tree();
    _render(host, v, null, { doc });
    assertEquals(target.textContent, "modal");

    open.set(false);
    let next = tree();
    _diff(host, next, v, { doc });
    v = next;
    assertEquals(
      target.textContent,
      "",
      "the portal's content outlived the element that contained the portal",
    );

    open.set(true);
    next = tree();
    _diff(host, next, v, { doc });
    v = next;
    assertEquals(
      target.querySelectorAll("p").length,
      1,
      "reopening stacked a second copy beside the first",
    );
    _diff(host, null, v, { doc });
    assertEquals(target.innerHTML, "");
  });
});

// ── 5. raw html owns the element's content ────────────────────────────────
//
// `dangerouslySetInnerHTML` decides whether an element HAS a vnode subtree at
// all, and every path has to agree. It did not: `applyProps` wrote the html and
// the child diff then walked the FRESHLY INJECTED nodes as if they were the old
// children and deleted them out of it (`<u>a</u><u>b</u><u>c</u>` came out as
// `<u>c</u>`); and a teardown walked children that were never realized, warning
// that a text child "will stay on the page forever. This is an aio bug".
Deno.test("dangerouslySetInnerHTML owns the element on every path", () => {
  withDoc((doc) => {
    withWarnings((warns) => {
      const RAW = "<u>a</u><u>b</u><u>c</u>";
      // BARE TEXT children as well as elements: a text child carries no `_dom`,
      // so it is located by POSITION — and the position it was located by, once
      // the html was written, was a node INSIDE the injected html.
      const kids = (n: number) =>
        Array.from(
          { length: n },
          (_, i) => (i % 2 === 0 ? String(i) : h("i", null, String(i))),
        );
      const tree = (raw: boolean, n: number) =>
        h(
          "div",
          null,
          raw
            ? h("div", { dangerouslySetInnerHTML: { __html: RAW } })
            : h("div", null, ...kids(n)),
          h("b", null, "tail"),
        );

      // children → raw html, for several old-child counts.
      for (const n of [1, 2, 3]) {
        const host = doc.createElement("main");
        const v = tree(false, n);
        _render(host, v, null, { doc });
        const v2 = tree(true, n);
        _diff(host, v2, v, { doc });
        const ref = doc.createElement("main");
        _render(ref, tree(true, n), null, { doc });
        assertEquals(
          host.innerHTML,
          ref.innerHTML,
          `children(${n}) → dangerouslySetInnerHTML deleted nodes out of the ` +
            `injected html`,
        );
        _diff(host, null, v2, { doc });
      }

      // raw html → children, and back.
      const host = doc.createElement("main");
      const v = tree(true, 0);
      _render(host, v, null, { doc });
      const v2 = tree(false, 2);
      _diff(host, v2, v, { doc });
      const ref = doc.createElement("main");
      _render(ref, tree(false, 2), null, { doc });
      assertEquals(host.innerHTML, ref.innerHTML, "raw html → children");

      // SSR agrees: the html, never the children.
      const both = h("div", {
        dangerouslySetInnerHTML: { __html: "<b>raw</b>" },
      }, h("i", null, "kid"));
      assertEquals(renderToString(both), `<div><b>raw</b></div>`);
      const mounted = doc.createElement("main");
      _render(mounted, both, null, { doc });
      assertEquals(mounted.innerHTML, `<div><b>raw</b></div>`);
      assertStringIncludes(
        warns.join(" | "),
        "dangerouslySetInnerHTML and children",
        "giving an element both must WARN — silently dropping the children " +
          "is the shape that makes people debug the wrong half",
      );
      _diff(host, null, v2, { doc });
    });
  });
});

Deno.test("a Portal under a raw-html element is never mounted — and never torn down", () => {
  withDoc((doc) => {
    withWarnings((warns) => {
      const target = doc.createElement("aside");
      // The element's content is raw html, so its vnode children — the portal
      // and its bare text — are NOT its subtree. Nothing may realize them, and
      // nothing may ask them to give up DOM they never had.
      const v = h(
        "div",
        null,
        h(
          "div",
          { dangerouslySetInnerHTML: { __html: "<u>raw</u>" } },
          h(Portal as never, { target }, h("p", null, "modal"), "tail"),
        ),
      );
      const host = doc.createElement("main");
      _render(host, v, null, { doc });
      assertEquals(
        target.innerHTML,
        "",
        "raw html must not mount its children",
      );
      _diff(host, null, v, { doc });
      assertEquals(
        warns.filter((w) => /stay on the page|aio bug/.test(w)),
        [],
        "tearing down a raw-html element walked children it never realized",
      );
    });
  });
});

// ── 6. a ref that MOVES ends up holding its element ───────────────────────
//
// Refs used to attach the moment `createDom` built the element. A commit that
// both builds and tears down elements sharing one ref then ended in whichever
// order it happened to visit them — `<p ref={r}/>` retagged to `<i ref={r}/>`
// set `r` to the `<i>` and then NULLED it when the `<p>` left, leaving `r`
// empty while its element was on screen. Refs now attach at the END of the
// commit and detach at once, so the order of the DOM work cannot decide it.
Deno.test("a ref survives a retag, a reorder, a re-key and a fragment wrap", () => {
  withDoc((doc) => {
    const shapes: Array<[string, (b: boolean) => VNode]> = [
      ["retag", (b) => h("div", null, h(b ? "i" : "p", { ref: R }, "x"))],
      [
        "reorder",
        (b) =>
          b
            ? h("div", null, h("b", null, "s"), h("p", { ref: R }, "x"))
            : h("div", null, h("p", { ref: R }, "x"), h("b", null, "s")),
      ],
      ["re-key", (b) =>
        h(
          "div",
          null,
          h("p", b ? { ref: R, key: "k" } : { ref: R }, "x"),
          h("b", b ? { key: "j" } : {}, "s"),
        )],
      ["fragment wrap", (b) =>
        h(
          "div",
          null,
          b
            ? h(Fragment, null, h("p", { ref: R }, "x"))
            : h("p", { ref: R }, "x"),
        )],
    ];
    let held: Node | null = null;
    const R = (n: Node | null) => {
      held = n;
    };
    for (const [name, tree] of shapes) {
      const host = doc.createElement("main");
      const v1 = tree(false);
      _render(host, v1, null, { doc });
      assert(held, `${name}: the ref never received the element`);
      const v2 = tree(true);
      _diff(host, v2, v1, { doc });
      assert(
        held,
        `${name}: the ref is null while its element is on screen — the new ` +
          `node attached before the old one detached`,
      );
      assert(
        host.contains(held),
        `${name}: the ref holds a node that is not in the tree`,
      );
      _diff(host, null, v2, { doc });
      assertEquals(held, null, `${name}: the ref outlived its element`);
    }
  });
});

// ── 7. "empty" means NO REALIZED NODE, on both sides ──────────────────────
//
// A container whose only content is an empty string is not empty: `""` is a
// text node on the client. SSR wrote the empty-container comment anchor for it
// while mount wrote the text node, so hydration met markup the model does not
// describe — a stray `<!---->`, or a full fallback with a warning that blamed
// `Date`/`random`/`window` in a render that has none.
Deno.test("a container holding only an empty string renders the same through SSR, mount and hydrate", () => {
  withDoc((doc) => {
    withWarnings((warns) => {
      const CEmpty = (() => "") as unknown as () => VNode;
      const CFragEmpty = () => h(Fragment, null, "");
      const shapes: Array<[string, () => VNode]> = [
        ["fragment with ''", () => h("div", null, h(Fragment, null, ""))],
        [
          "fragment with '' + tail",
          () => h("div", null, h(Fragment, null, ""), "tail"),
        ],
        ["boundary with a component returning ''", () =>
          h(
            "div",
            null,
            h(ErrorBoundary as never, { fallback: () => "!" }, h(CEmpty, null)),
          )],
        [
          "component returning a fragment of ''",
          () => h("div", null, h(CFragEmpty, null)),
        ],
      ];
      for (const [name, tree] of shapes) {
        const mounted = doc.createElement("main");
        _render(mounted, tree(), null, { doc });
        const ssr = renderToString(tree());
        assertEquals(
          ssr,
          mounted.innerHTML,
          `${name}: the server and the client disagree about what an empty ` +
            `container is`,
        );
        const hydrated = doc.createElement("main");
        hydrated.innerHTML = ssr;
        const v = tree();
        assert(
          _hydrateNode(hydrated, v, { doc }, false, 0) >= 0,
          `${name}: hydration fell back on markup the server itself wrote`,
        );
        assertEquals(
          hydrated.innerHTML,
          mounted.innerHTML,
          `${name}: hydrated`,
        );
        _diff(hydrated, null, v, { doc });
      }
      assertEquals(
        warns.filter((w) => /Date|random|window/.test(w)),
        [],
        "hydration blamed the app for a divergence the renderer produced",
      );
    });
  });
});

// ── 8. a static short-circuit that compares KEY NAMES ─────────────────────
//
// `_staticEqual` compared the prop COUNT and then looked up only `a`'s keys in
// `b`, so `{style:"color:red"}` and `{"data-n":undefined}` compared EQUAL (one
// key each, `undefined === undefined`) and the static short-circuit kept the
// old element's attributes on screen for a model that no longer has them.
Deno.test("a static element with the same number of DIFFERENT props is not equal", () => {
  withDoc((doc) => {
    const pairs: Array<[Record<string, unknown>, Record<string, unknown>]> = [
      [{ style: "color:red" }, { "data-n": undefined }],
      [{ className: "x" }, { title: undefined }],
      [{ id: "a", title: "t" }, { id: undefined, hidden: undefined }],
      [{ "data-n": "1" }, { "data-m": "1" }],
    ];
    for (const [before, after] of pairs) {
      // No TEXT children anywhere: a bare string disqualifies `_static`
      // (`_isStaticChildren`), and an element that is not static never reaches
      // the short-circuit this is about.
      const tree = (props: Record<string, unknown>) =>
        h("div", null, h("div", { ...props }, h("i", null)));
      const host = doc.createElement("main");
      const v1 = tree(before);
      _render(host, v1, null, { doc });
      const v2 = tree(after);
      _diff(host, v2, v1, { doc });
      const ref = doc.createElement("main");
      _render(ref, tree(after), null, { doc });
      assertEquals(
        host.innerHTML,
        ref.innerHTML,
        `${JSON.stringify(before)} → ${
          JSON.stringify(after)
        }: the static short-circuit read the two prop sets as equal because ` +
          `they have the same COUNT, and kept the old attributes`,
      );
    }
  });
});

// ── P1. one message for "a component returned something that is not a node" ─
//
// The client threw a written explanation and `renderToString` threw
// `TypeError: Cannot convert undefined or null to object` eleven frames deeper.
// Same mistake, same author, two experiences — and the SSR one names nothing.
Deno.test("a component returning a non-node says the same thing on the server as on the client", () => {
  withDoc((doc) => {
    const cases: Array<[string, () => unknown, string]> = [
      ["boolean", () => false, "Return null to render nothing"],
      [
        "array",
        () => [h("i", null), h("b", null)],
        "Wrap the list in a fragment",
      ],
      ["signal", () => signal(1), "Render its value instead"],
    ];
    for (const [name, ret, hint] of cases) {
      const C = ret as () => VNode;
      const client = (() => {
        try {
          _render(doc.createElement("main"), h(C, null), null, { doc });
        } catch (e) {
          return (e as Error).message;
        }
        return "";
      })();
      const server = (() => {
        try {
          renderToString(h(C, null));
        } catch (e) {
          return (e as Error).message;
        }
        return "";
      })();
      assert(client, `${name}: the client accepted a non-node`);
      assertEquals(
        server,
        client,
        `${name}: SSR and mount describe the same mistake differently`,
      );
      assertStringIncludes(
        client,
        hint,
        `${name}: the hint does not match what was actually returned`,
      );
    }
    // `0` and `""` ARE nodes — neither side may refuse them.
    for (const [name, C] of [["0", () => 0], ["''", () => ""]] as const) {
      const host = doc.createElement("main");
      const v = h("div", null, h(C as unknown as () => VNode, null));
      _render(host, v, null, { doc });
      assertEquals(host.textContent, String(C()), `${name}: mounted`);
      assertEquals(
        renderToString(h("div", null, h(C as unknown as () => VNode, null))),
        host.innerHTML,
        `${name}: SSR and mount disagree`,
      );
      _diff(host, null, v, { doc });
    }
  });
});

// ── P2. a signal child renders as TEXT, and says so ───────────────────────
Deno.test("a signal child holding an object or an array warns once, naming the fix", () => {
  withDoc((doc) => {
    withWarnings((warns) => {
      for (const value of [{ a: 1 }, [1, 2], h("b", null, "x")]) {
        const s = signal<unknown>("ok");
        const host = doc.createElement("main");
        const v = h("div", null, s as unknown as VNode);
        _render(host, v, null, { doc });
        s.set(value);
        assert(
          warns.some((w) => /signal used as a child/i.test(w)),
          `a signal child holding ${
            JSON.stringify(value)
          } rendered "[object Object]"/"1,2" with nothing said`,
        );
        warns.length = 0;
        _diff(host, null, v, { doc });
      }
    });
  });
});

// ── the two SSR writers agree about all of the above ──────────────────────
Deno.test("renderToStream writes what renderToString writes for signal children and raw html", async () => {
  const s = signal("v");
  const trees: Array<[string, () => VNode]> = [
    ["signal child", () => h("div", null, "n=", s as unknown as VNode)],
    [
      "signal under a fragment",
      () => h("div", null, h(Fragment, null, s as unknown as VNode)),
    ],
    [
      "raw html",
      () =>
        h(
          "div",
          null,
          h("i", { dangerouslySetInnerHTML: { __html: "<b>r</b>" } }),
        ),
    ],
    ["empty string child", () => h("div", null, h(Fragment, null, ""))],
    ["portal", () => h("div", null, h(Portal as never, { target: null }, "x"))],
  ];
  for (const [name, tree] of trees) {
    const chunks: string[] = [];
    for await (const c of renderToStream(tree())) chunks.push(c);
    assertEquals(chunks.join(""), renderToString(tree()), name);
  }
});

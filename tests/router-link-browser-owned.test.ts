// `<Link>` must not take over a click the BROWSER owns.
//
// It preventDefault()ed every primary click and routed in-page. That is right
// for an in-app path and wrong for everything else, and the two wrong cases
// were both measured:
//
//   <Link to="/x" target="_blank">   → navigated IN PLACE; `target` ignored,
//                                      the user's new tab never opened.
//   <Link to="https://other/x">      → preventDefault(), then
//                                      `history.pushState` threw a
//                                      SecurityError (a cross-origin URL
//                                      cannot be a history entry). Net effect:
//                                      the link did NOTHING, with a framework
//                                      "event handler error" as the only trace.
//
// The rule is one rule — if the anchor's own `href` would do the right thing,
// do not intercept — so it is tested as a table rather than case by case.
import { assert, assertEquals } from "@std/assert";
import { Window } from "happy-dom";
import { h } from "../src/air/vdom.ts";
import { _setDocument, _unmount, mount } from "../src/air/aio-renderer.ts";
import { Link } from "../src/browser/browser-air-router.ts";
import { navigate, routePath } from "../src/browser/browser-protocol.ts";

type Env = {
  win: Window;
  doc: Document;
  restore: () => void;
};

const HOME = "https://app.test/home";

function env(url = HOME): Env {
  const win = new Window({ url });
  const doc = win.document as unknown as Document;
  const g = globalThis as Record<string, unknown>;
  const prevLoc = g.location, prevHist = g.history;
  g.location = win.location;
  g.history = win.history;
  _setDocument(doc);
  return {
    win,
    doc,
    restore: () => {
      g.location = prevLoc;
      g.history = prevHist;
      win.happyDOM.close();
    },
  };
}

/** Click the single <a> that `props` renders; report whether Link claimed it. */
function clickLink(
  e: Env,
  props: Record<string, unknown>,
  mods: Record<string, unknown> = {},
): { claimed: boolean; threw: string } {
  // happy-dom FOLLOWS an anchor whose click was not prevented, so a
  // browser-owned case moves `location` and would change the origin the next
  // case is judged against. Put the page back first.
  e.win.location.href = HOME;
  const host = e.doc.createElement("main");
  e.doc.body.appendChild(host);
  const handle = mount(host, () => h(Link, { ...props }, "go"));
  const a = host.querySelector("a") as unknown as HTMLElement;
  assert(a, "Link renders an anchor");
  const ev = new e.win.MouseEvent("click", {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...mods,
  });
  let threw = "";
  try {
    a.dispatchEvent(ev as unknown as Event);
  } catch (err) {
    threw = (err as Error).message;
  }
  const claimed = (ev as unknown as Event).defaultPrevented;
  _unmount(handle);
  host.remove();
  return { claimed, threw };
}

Deno.test("Link claims an in-app click and nothing else", () => {
  const e = env();
  try {
    // [description, props, click modifiers, Link should claim it]
    const cases: Array<
      [string, Record<string, unknown>, Record<string, unknown>, boolean]
    > = [
      ["a plain in-app path", { to: "/inner" }, {}, true],
      [
        "a same-origin absolute URL",
        { to: "https://app.test/inner" },
        {},
        true,
      ],
      [
        "target=_self (the default, spelled out)",
        { to: "/inner", target: "_self" },
        {},
        true,
      ],
      ["target=_blank", { to: "/inner", target: "_blank" }, {}, false],
      ["a named target", { to: "/inner", target: "preview" }, {}, false],
      ["download", { to: "/file.csv", download: "" }, {}, false],
      ["another origin", { to: "https://other.test/x" }, {}, false],
      ["a protocol-relative other origin", { to: "//other.test/x" }, {}, false],
      ["mailto:", { to: "mailto:a@b.test" }, {}, false],
      ["tel:", { to: "tel:+1234" }, {}, false],
      ["ctrl+click", { to: "/inner" }, { ctrlKey: true }, false],
      ["meta+click", { to: "/inner" }, { metaKey: true }, false],
      ["shift+click", { to: "/inner" }, { shiftKey: true }, false],
      ["middle click", { to: "/inner" }, { button: 1 }, false],
    ];
    for (const [what, props, mods, shouldClaim] of cases) {
      const { claimed, threw } = clickLink(e, props, mods);
      assertEquals(
        threw,
        "",
        `${what} threw out of the click handler: ${threw}`,
      );
      assertEquals(
        claimed,
        shouldClaim,
        shouldClaim
          ? `${what} is an in-app navigation — Link must handle it`
          : `${what} is the BROWSER's click — Link must not preventDefault it, ` +
            `or the anchor's own href never runs`,
      );
    }
  } finally {
    e.restore();
  }
});

Deno.test("Link still routes in-app: the path signal moves", () => {
  const e = env();
  try {
    const before = routePath.peek();
    clickLink(e, { to: "/deep/inner" });
    assert(
      routePath.peek() !== before && routePath.peek() === "/deep/inner",
      `an in-app Link must update the route signal — was ${before}, now ${routePath.peek()}`,
    );
  } finally {
    e.restore();
  }
});

Deno.test("navigate() to another origin leaves the app instead of throwing", () => {
  const e = env();
  try {
    // `history.pushState` REFUSES a cross-origin URL by spec, so this used to
    // throw a SecurityError out of navigate() — from inside a click handler,
    // after preventDefault() had already run.
    navigate("https://other.test/x");
    assertEquals(
      String(e.win.location.href),
      "https://other.test/x",
      "an absolute cross-origin destination is a real navigation, not a " +
        "history entry the browser will refuse",
    );
  } finally {
    e.restore();
  }
});

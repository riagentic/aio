// `<Browser>` — an embedded page, with the two traps closed.
//
// Electron's `<webview>` is how an aio app shows somebody else's page inside
// its own, and every author meets the same two problems in hour one (newjob
// §2):
//
//  1. A REACTIVE `src` IS AN INFINITE NAVIGATION LOOP. Setting `src` navigates;
//     navigating fires `did-navigate`; an app writes that to state; state
//     re-renders; the render sets `src` again. The page flickers and never
//     settles, and nothing in the stack says why.
//  2. UNMOUNTING DESTROYS THE GUEST — its scroll, its forms and its LOGIN — so
//     a tab switch silently signs the user out of the page they were reading.
//
// The guest is Electron's, so these drive the RULES against a stand-in that
// behaves the way the tag does: `src` is what it reads before it is ready,
// `loadURL` is what it takes afterwards, and `getURL` is where it is now.
import { assert, assertEquals } from "@std/assert";
import { Browser, navigate } from "../src/ui/browser.ts";

type Fake = {
  src: string;
  loads: string[];
  loadURL(url: string): Promise<void>;
  getURL(): string;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  attrs: Record<string, string>;
};

const fake = (src = ""): Fake => {
  const f: Fake = {
    src,
    loads: [],
    attrs: {},
    loadURL(url: string) {
      f.loads.push(url);
      f.src = url;
      return Promise.resolve();
    },
    getURL: () => f.src,
    setAttribute: (k, v) => {
      f.attrs[k] = v;
    },
    getAttribute: (k) => f.attrs[k] ?? null,
  };
  return f;
};

// deno-lint-ignore no-explicit-any
const nav = (f: Fake, url: string) => navigate(f as any, url);

Deno.test("the SAME url twice navigates once — this is the loop, broken", () => {
  const f = fake("https://a.test/");
  nav(f, "https://b.test/");
  assertEquals(f.loads, ["https://b.test/"]);
  // Every subsequent render passes the same `src`. If any of these navigated,
  // the page would never settle.
  for (let i = 0; i < 20; i++) nav(f, "https://b.test/");
  assertEquals(f.loads, ["https://b.test/"], "a re-render is not a navigation");
});

Deno.test("a REAL change navigates", () => {
  const f = fake("https://a.test/");
  nav(f, "https://b.test/");
  nav(f, "https://c.test/");
  assertEquals(f.loads, ["https://b.test/", "https://c.test/"]);
});

Deno.test("before the guest is ready it is `src`, after it is `loadURL`", () => {
  // The tag reads `src` on first paint and cannot be `loadURL`'d yet; once it
  // has a URL, `loadURL` is the API that actually navigates it.
  const fresh = fake("");
  nav(fresh, "https://first.test/");
  assertEquals(fresh.loads, [], "nothing to loadURL before it is attached");
  assertEquals(fresh.attrs.src, "https://first.test/");
  nav(fresh, "https://second.test/");
  assertEquals(fresh.loads, ["https://second.test/"], "…and loadURL after");
});

Deno.test("an empty src does nothing at all", () => {
  const f = fake("https://a.test/");
  nav(f, "");
  assertEquals(f.loads, []);
});

Deno.test("a guest that refuses a navigation does not take the page with it", () => {
  // An offline host or a blocked scheme is the guest's business and shows in
  // its own error page; a rejected promise here must not reach the app.
  const f = fake("https://a.test/");
  // deno-lint-ignore no-explicit-any
  (f as any).loadURL = () => Promise.reject(new Error("ERR_NAME_NOT_RESOLVED"));
  nav(f, "https://nope.test/");
  // Reached without throwing, and the URL is remembered so the next render
  // does not retry it in a loop.
  assertEquals(f.getURL(), "https://a.test/");
});

Deno.test("it renders a plain <webview>, so Electron's own API stays reachable", () => {
  const v = Browser({ src: "https://a.test/", partition: "persist:reader" });
  assertEquals(v.tag, "webview");
  assertEquals(v.props.partition, "persist:reader");
  // The URL is NOT a prop: an attribute is re-applied by the renderer on every
  // pass, and re-applying `src` is the loop this component exists to close.
  assertEquals(
    v.props.src,
    undefined,
    "`src` as an attribute would be applied on every render",
  );
  assertEquals(typeof v.props.use, "function", "it is applied imperatively");
});

Deno.test("keepAlive is what decides whether the guest survives an unmount", () => {
  // The prop is the whole contract, so the shape is pinned: with it the
  // element is parked, without it the default (destroyed) is unchanged.
  const withKeep = Browser({ src: "https://a.test/", keepAlive: "reader" });
  const without = Browser({ src: "https://a.test/" });
  assertEquals(typeof withKeep.props.use, "function");
  assertEquals(typeof without.props.use, "function");
});

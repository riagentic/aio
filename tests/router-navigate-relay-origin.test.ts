// The Electron shell relays an in-app link click to the page as
// `aio:navigate` with the link's WHOLE url. The router rebuilt the route from
// its path alone, so a same-app `http://host//evil.example/x` became
// `navigate("//evil.example/x")` — scheme-relative, another site — and the
// window handed evil.example to the system browser (measured on real Electron:
// tests/electron-navigate-scheme-relative-e2e.test.ts). A relayed url that is
// not this origin's is not a route at all.
import { assertEquals } from "@std/assert";
import { _installRouterListeners } from "../src/air/router-core.ts";

Deno.test("router: an aio:navigate relay routes the whole url in-app, and refuses another origin", () => {
  const g = globalThis as Record<string, unknown>;
  const saved = ["window", "location", "history"].map((k) =>
    [k, Object.getOwnPropertyDescriptor(g, k)] as const
  );
  const assigned: string[] = [];
  const pushed: string[] = [];
  const loc = {
    href: "http://localhost:8000/",
    origin: "http://localhost:8000",
    pathname: "/",
    search: "",
    hash: "",
    assign: (u: string) => void assigned.push(u),
  };
  const move = (_s: unknown, _t: string, u: string | URL) => {
    const x = new URL(u, loc.href);
    pushed.push(x.href);
    Object.assign(loc, {
      href: x.href,
      pathname: x.pathname,
      search: x.search,
    });
  };
  const win = new EventTarget();
  const set = (k: string, value: unknown) =>
    Object.defineProperty(g, k, { configurable: true, writable: true, value });
  set("window", win);
  set("location", loc);
  set("history", { pushState: move, replaceState: move });
  try {
    _installRouterListeners();
    const relay = (url: string) =>
      win.dispatchEvent(new CustomEvent("aio:navigate", { detail: { url } }));
    relay("http://localhost:8000//evil.example/x");
    assertEquals(assigned, [], "a same-app link must never leave the app");
    assertEquals(pushed, ["http://localhost:8000//evil.example/x"]);
    relay("http://localhost:8000/settings?tab=2#top");
    assertEquals(pushed[1], "http://localhost:8000/settings?tab=2#top");
    relay("https://other.example/y");
    assertEquals([assigned, pushed.length], [[], 2]);
  } finally {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(g, k, d);
      else delete g[k];
    }
  }
});

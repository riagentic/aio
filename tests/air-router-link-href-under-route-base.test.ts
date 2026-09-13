// `<Link href>` lives under the route base, exactly where a click navigates.
//
// A packaged android app is served from `/assets/`, so the router reads paths
// relative to that base and `navigate("/about")` writes `/assets/about`. The
// Link's `href` was `to` raw — measured before the fix, `<Link to="/about">`
// under base `/assets` rendered `<a href="/about">`. A plain click went through
// `navigate` and worked; every gesture the router deliberately leaves to the
// anchor (open in new tab, copy link, a modified click, a long-press "open")
// went to the origin's `/about`, which the asset loader does not serve.
import { assertEquals } from "@std/assert";
import { type ComponentFn, h, renderToString } from "../src/air/vdom.ts";
import { _appHref, _setRouteBase } from "../src/air/router-core.ts";
import { Link } from "../src/air/router.ts";

const link = (to: string) =>
  renderToString(h(Link as unknown as ComponentFn, { to }, "x"));

Deno.test("Link href: an app-absolute `to` is written under the route base", () => {
  _setRouteBase("/assets");
  try {
    assertEquals(link("/about"), '<a href="/assets/about">x</a>');
    assertEquals(link("/"), '<a href="/assets/">x</a>');
    assertEquals(link("/p?tab=1#top"), '<a href="/assets/p?tab=1#top">x</a>');
    // Not app paths: relative, scheme-relative, absolute, other schemes.
    assertEquals(link("details"), '<a href="details">x</a>');
    assertEquals(link("//cdn.example/x"), '<a href="//cdn.example/x">x</a>');
    assertEquals(
      link("https://example.com/"),
      '<a href="https://example.com/">x</a>',
    );
    assertEquals(link("mailto:a@b.c"), '<a href="mailto:a@b.c">x</a>');
  } finally {
    _setRouteBase("");
  }
});

Deno.test("Link href: the href and navigate() resolve a `to` through the one rule", () => {
  _setRouteBase("/assets");
  try {
    for (const to of ["/about", "rel", "//cdn.example/x", "/a/b?c=1"]) {
      const href = link(to).match(/href="([^"]*)"/)![1];
      assertEquals(href, _appHref(to), to);
    }
  } finally {
    _setRouteBase("");
  }
});

Deno.test("Link href: without a route base `to` is written as-is", () => {
  _setRouteBase("");
  assertEquals(link("/about"), '<a href="/about">x</a>');
});

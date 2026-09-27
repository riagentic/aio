// Bug hunt r10 (ui): `RouteParams` types a `*` INSIDE a segment as a wildcard.
//
// docs/ui/air-routing.md: "`*` is a wildcard only as a whole segment; inside
// one (`/a*b`) it is a literal", and `matchPath` does exactly that (it
// escapes it). But the type `useRoute(pattern)` infers params from
// (src/air/router.ts `RouteParams`) matches ANY `*` in the pattern text
// (`S extends \`${string}*${string}\``), so `useRoute("/a*b").params["*"]`
// type-checks as `string` and is `undefined` at runtime — the exact
// confident-wrong-key the type exists to rule out.
//
// This file FAILS TO TYPE-CHECK on the current code (the `Eq` line below);
// the runtime half pins what the type must describe.
import { assertEquals } from "@std/assert";
import type { RouteParams } from "../src/air/router.ts";
import { matchPath } from "../src/air/router-core.ts";

type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;

Deno.test("RouteParams: a literal `*` inside a segment declares no `*` param", () => {
  const params = matchPath("/a*b", "/a*b");
  assertEquals(params, {}, "runtime: `/a*b` matches itself with no params");
  assertEquals(params !== null && "*" in params, false);

  // The type must agree with the runtime: no keys at all.
  const typeAgrees: Eq<keyof RouteParams<"/a*b">, never> = true;
  assertEquals(typeAgrees, true);
});

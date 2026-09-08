// The route pattern types its own params.
//
// Two field reports asked for this independently, and one checked the
// implementation with `deno check` including a `@ts-expect-error` case. The
// value is not the type of a param — every URL segment is a string — it is the
// KEY SET: `params.postId` exists and `params.postld` is a compile error
// instead of `undefined` at runtime, which is what a router user checks first.
//
// COMPATIBILITY, asserted rather than argued. The previous signature is kept
// verbatim as overload #1, so every existing call compiles unchanged — the
// hand-spelled `useRoute<{ id: string }>(…)` included. `check:api` classifies
// this as additive by a provable rule (an overload set whose first signature is
// byte-identical to the previous single one cannot break a caller, because
// overload resolution tries declarations in order), pinned in
// tests/api-break-classification.test.ts in both directions.
import { assertEquals } from "@std/assert";
import { matchPath, type RouteParams } from "../src/air/router.ts";

/** The keys the RUNTIME extracts, sorted.
 *
 *  Every case below asserts this as well as the type, and that pairing is the
 *  point: a type that promises `postId` while `matchPath` produces `postid`
 *  would type-check perfectly and be wrong at run time — the exact divergence a
 *  type-only test cannot see. (It also stops these being vacuous: a body whose
 *  only runtime assertion is `assertEquals(true, true)` holds for any
 *  implementation, which `check:vacuous` correctly refuses.) */
function runtimeKeys(pattern: string, path: string): string[] {
  return Object.keys(matchPath(pattern, path) ?? {}).sort();
}

/** Compile-time equality: `Expect<Eq<A, B>>` fails to type-check when A ≠ B. */
type Eq<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

Deno.test("route params: one segment", () => {
  type P = RouteParams<"/users/:id">;
  type _ = Expect<Eq<P, { id: string }>>;
  assertEquals(runtimeKeys("/users/:id", "/users/7"), ["id"]);
});

Deno.test("route params: several segments", () => {
  type P = RouteParams<"/users/:id/posts/:postId">;
  // The keys are what matter — both, and only both.
  type _has = Expect<Eq<P["id"], string>>;
  type _has2 = Expect<Eq<P["postId"], string>>;
  // @ts-expect-error — a param the pattern does not declare is a compile error,
  // which is the entire point: it used to be `string` and `undefined` at run.
  type _no = P["postld"];
  assertEquals(
    runtimeKeys("/users/:id/posts/:postId", "/users/7/posts/9"),
    ["id", "postId"],
    "the type's key set and the runtime's must be the same set",
  );
});

Deno.test("route params: a pattern with none", () => {
  type P = RouteParams<"/about">;
  // @ts-expect-error — nothing to read.
  type _no = P["id"];
  assertEquals(runtimeKeys("/about", "/about"), []);
});

Deno.test("route params: a wildcard contributes '*'", () => {
  type P = RouteParams<"/files/*">;
  type _ = Expect<Eq<P["*"], string>>;
  assertEquals(runtimeKeys("/files/*", "/files/a/b.txt"), ["*"]);
});

Deno.test("route params: a NON-literal pattern keeps the open map", () => {
  // A `string` pattern promises nothing about its keys. Narrowing it to `{}`
  // would be a confident wrong answer about a pattern nobody typed — and it
  // would break every call that passes a computed path.
  type P = RouteParams<string>;
  type _ = Expect<Eq<P, Record<string, string>>>;
  // And the runtime still extracts whatever the computed pattern declares —
  // the open type is not a claim that there are no params, it is the absence
  // of a claim.
  const pattern: string = "/users/:id";
  assertEquals(runtimeKeys(pattern, "/users/7"), ["id"]);
});

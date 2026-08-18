// `JSX.Element` must be reachable from the entry every app already imports.
//
// It is the first thing anyone annotates, and it was `TS2503: Cannot find
// namespace 'JSX'` — 23 errors on one reporter's first `deno task check`, from
// an error naming no remedy and no scaffold template demonstrating the import
// that fixes it.
//
// aio does NOT declare it globally, and that is a packaging constraint rather
// than a preference: JSR's fast-check refuses `declare global` in a published
// module ("global augmentations are not supported"), so shipping the ambient
// version would break `deno publish` — a release gate — for a convenience. The
// fix is the import, made short and discoverable: `JSX` now comes off `aio`
// itself, and every scaffold template annotates its component, so a new app
// carries the line from the first minute.
//
// This file IS that annotation. If the re-export regresses it stops
// type-checking, which is the only assertion that can catch it — a runtime
// test cannot see types.
import { assertEquals } from "@std/assert";
import type { JSX } from "aio";
import type { JSX as FromRuntime } from "aio/jsx-runtime";
import { testUI } from "aio/testing";

function Typed(): JSX.Element {
  const kids: JSX.Node = "from-aio";
  const also: JSX.Children = kids;
  return <div t="typed">{also}</div>;
}

// The long spelling must name the SAME types — one namespace, two paths.
function Explicit(): FromRuntime.Element {
  const same: FromRuntime.Element = Typed();
  void same;
  return <span t="explicit">both</span>;
}

testUI(Typed, "JSX.Element from `aio` compiles and renders", (ui) => {
  assertEquals(ui.typed.text, "from-aio");
});

testUI(Explicit, "aio/jsx-runtime names the same types", (ui) => {
  assertEquals(ui.explicit.text, "both");
});

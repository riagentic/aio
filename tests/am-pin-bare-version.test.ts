// `am pin 1.0.20-beta` — the version without its `v`.
//
// The upgrade guides wrote it that way, and every user types it that way; the
// tags are `v1.0.20-beta`, so the ref was refused with a list that named the
// right tag itself (two field reports). A bare name that maps to EXACTLY
// one known tag is that tag; anything else stays itself, so a tag literally
// named without `v` keeps winning and an unknown name still fails loudly.

import "./store-sandbox.ts";
import { assertEquals } from "@std/assert";
import { tagForRef } from "../src/am/am-cmd-pin.ts";

const known = ["v1.0.20-beta", "v1.0.19-beta"];

Deno.test("am pin: a bare version is the one tag it names", () => {
  assertEquals(tagForRef("1.0.20-beta", known), "v1.0.20-beta");
  assertEquals(tagForRef("v1.0.20-beta", known), "v1.0.20-beta");
});

Deno.test("am pin: anything else is still itself", () => {
  assertEquals(tagForRef("1.0.21-beta", known), "1.0.21-beta"); // unknown → loud later
  assertEquals(tagForRef("main", known), "main");
  // A real tag spelled without `v` is exact, never rewritten.
  assertEquals(
    tagForRef("1.0.20-beta", [...known, "1.0.20-beta"]),
    "1.0.20-beta",
  );
});

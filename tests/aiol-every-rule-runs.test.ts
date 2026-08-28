// aiol is this project's own linter, and a rule that is written but never
// added to `ALL_CHECKS` is a check that silently does not run — the exact
// "declared and never connected" class `check:dead-wiring` was built for in
// alpha69, where it found four such features (a DevTools hook that
// misattributed every frame for the feature's life, a tree that returned `[]`
// forever, fifty lines of overlay injected nowhere).
//
// That gate walks `src/` only, so `aiol/` sits outside it. All 28 rules are
// wired today; this is what keeps that true, and it is cheaper than widening
// a gate across a whole new root.
import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const REPO_ROOT = dirname(fromFileUrl(import.meta.url)).replace(/\/tests$/, "");

Deno.test("aiol: every rule that exists is in ALL_CHECKS", async () => {
  const src = await Deno.readTextFile(join(REPO_ROOT, "aiol", "checks.ts"));
  const defined = [
    ...src.matchAll(/^export const (check[A-Za-z0-9]+): Checker/gm),
  ]
    .map((m) => m[1]!);
  assertEquals(
    defined.length > 20,
    true,
    `only ${defined.length} rules found — the matcher broke, not the linter`,
  );
  const start = src.indexOf("export const ALL_CHECKS");
  assertEquals(start >= 0, true, "ALL_CHECKS is gone");
  const registry = src.slice(start, src.indexOf("];", start));
  const missing = defined.filter((n) =>
    !new RegExp(`\\b${n}\\b`).test(registry)
  );
  assertEquals(
    missing,
    [],
    "written, exported, and never run — a rule outside ALL_CHECKS reports " +
      `nothing, forever: ${missing.join(", ")}`,
  );
});

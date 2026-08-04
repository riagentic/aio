// The leak detector behind tests/diag-sink.test.ts's fixture contract.
//
// `deno test tests/` runs every file in ONE process, and four places in
// `src/` branch on `typeof window !== "undefined"` to decide "browser" — a
// `window` global leaked by any earlier test file sends later, unrelated
// files down the browser path in a runtime with no `document`, and the suite
// fails somewhere far from the culprit (it did: diag-sink's first version
// installed a window and left it on the global, and the failures were
// intermittent and elsewhere). A fixture more permissive than production
// manufactures exactly that, so the absence of a leak is ASSERTED here, in a
// file whose name sorts after every `diag-*` fixture (Deno collects test
// files in sorted order).
//
// Files that legitimately install a window (happy-dom in testUI) tear it
// down in the same test; a failure here names the class instantly instead of
// costing a bisection.
import { assert } from "@std/assert";

Deno.test("no test file leaked a `window` global onto globalThis", () => {
  assert(
    !("window" in globalThis),
    "a previous test file left `window` on globalThis — its fixture must " +
      "restore the global in a finally (see tests/diag-sink.test.ts)",
  );
});

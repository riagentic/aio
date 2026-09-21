// `onInit` is server origin — the claim, made into a mechanism.
//
// `access` documents four things as server origin: effects, schedules,
// `onInit`, and one cell's method body calling another. Three of those were
// marked by the call path. `onInit` was wrapped in `inServerOrigin` too — but
// the harness installed the SCOPE inside the access gate, and the gate is
// installed AFTER the boot, because it wraps the bound methods the boot
// creates. So at the moment `onInit` ran there was no scope, and
// `isServerOrigin()` read FALSE inside it.
//
// Nothing was refused, because no gate existed yet either — the claim was
// true by accident, for a reason nobody had written down, and one line of
// reordering anywhere near the boot would have silently turned it false. Three
// places asserted it in prose (`cell-types.ts`, docs/auth/auth.md, and the
// commit that added the marker) and nothing asserted it in code.
//
// Found by the verify round that attacked the marker, and routed rather than
// fixed there. The scope is installed before the boot now — it is separable
// from the gate, being only an AsyncLocalStorage holder — and this is the test
// that keeps the claim honest.

import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { isServerOrigin } from "../src/state/call-origin.ts";

Deno.test("onInit runs as SERVER origin, not as a client", async () => {
  // Read inside the hook, kept outside it: asserting in there would be
  // swallowed by the lifecycle's own error guard (hooks are observe-only and
  // never break dispatch), so a failure would look like a pass.
  let sawOrigin: boolean | null = null;

  const boot = cell("originAtBoot", {
    state: { ready: false },
    methods: { go: (s: { ready: boolean }) => void (s.ready = true) },
    onInit: () => {
      sawOrigin = isServerOrigin();
    },
  });

  const App = () => <div class="label">{boot.ready ? "yes" : "no"}</div>;

  await using ui = await testUI(App as never);
  await ui.settle();

  assert(
    sawOrigin !== null,
    "onInit never ran — the probe proves nothing, so fix the harness before " +
      "reading the assertion below",
  );
  assertEquals(
    sawOrigin,
    true,
    "onInit ran as CLIENT origin. `access` documents onInit as server " +
      "origin in three places; if that is no longer the mechanism, change " +
      "the documentation rather than this test.",
  );
});

Deno.test("outside any method or hook, origin is NOT server", async () => {
  // The other half, and the one that makes the test above mean something: if
  // `isServerOrigin()` answered true everywhere, the assertion would pass for
  // a scope that marks nothing. A test body is ordinary client-side code.
  const c = cell("originOutside", {
    state: { n: 0 },
    methods: { inc: (s: { n: number }) => void s.n++ },
  });
  const App = () => <div class="label">{String(c.n)}</div>;

  await using ui = await testUI(App as never);
  await ui.settle();

  assertEquals(
    isServerOrigin(),
    false,
    "the test body itself reads as server origin — the scope is leaking, " +
      "and every `access` rule is bypassed for client code",
  );
});

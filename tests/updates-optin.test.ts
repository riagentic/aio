// updates-optin.test.ts — the built-in `updates` and `feedback` cells must not
// exist in an app that never asked for them.
//
// Its own file on purpose: `cell()` self-registers on import, so this can only
// be observed from a module that does NOT pull the cell in itself. Anything
// importing updates-runtime.ts (which legitimately value-imports the cell)
// would register it and make the assertion vacuous.
import { assert, assertEquals } from "@std/assert";

Deno.test("updates: the cell registers ONLY for an app that configured it", async () => {
  // A regression with teeth. A static value-import of the cell anywhere in the
  // server put `updates` into EVERY aio app — its cell list, its state, and
  // its --expose visibility report. Importing it is meant to BE the opt-in,
  // and that only holds while every path from the server stays dynamic.
  const boot = await import("../src/server/updates-boot.ts");
  const apply = await import("../src/server/updates-apply.ts");
  const core = await import("../src/server/updates-core.ts");
  const check = await import("../src/server/updates-check.ts");
  assert(boot && apply && core && check, "the machinery imports cleanly");

  const { getRegisteredCells } = await import("../src/state/cell-reactive.ts");
  assertEquals(
    [...getRegisteredCells().keys()].includes("updates"),
    false,
    "importing the update machinery must not register the cell — only an app " +
      "that sets `updates` in its config, or imports `aio/updates` for its UI, " +
      "should ever see it",
  );

  // And the opt-in itself still works.
  await import("../src/updates.ts");
  assert(
    [...getRegisteredCells().keys()].includes("updates"),
    "importing aio/updates must register the cell — that IS the opt-in",
  );
});

Deno.test("feedback: the cell registers ONLY for an app that configured it", async () => {
  const boot = await import("../src/server/feedback-boot.ts");
  const report = await import("../src/server/report.ts");
  assert(boot && report, "the machinery imports cleanly");

  const { getRegisteredCells } = await import("../src/state/cell-reactive.ts");
  assertEquals(
    [...getRegisteredCells().keys()].includes("feedback"),
    false,
    "importing the report machinery must not register the cell — an app that " +
      "never reports problems should carry no feedback state",
  );

  await import("../src/feedback.ts");
  assert(
    [...getRegisteredCells().keys()].includes("feedback"),
    "importing aio/feedback must register the cell — that IS the opt-in",
  );
});

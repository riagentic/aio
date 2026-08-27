// feedback-cell-enabled.test.ts — `feedback.enabled` is a fact about config.
//
// The field was declared, documented ("feedback was configured") and never
// written — a UI gated on it rendered nothing forever, in a correctly
// configured app, with every test green. The same class as `updates.enabled`
// (a field report found both). Now: `false` until a runtime is installed and
// `refresh()` runs; `true` after.
import { assertEquals } from "@std/assert";
import { testCell } from "../src/cell-test.ts";
import {
  createFeedbackCell,
  type FeedbackState,
  installFeedbackRuntime,
} from "../src/state/feedback-cell.ts";

// `FeedbackCell` is the bound facade, not the `CellDef` the harness is typed
// over — same cast the updates test uses.
const feedback = createFeedbackCell() as unknown as Parameters<
  typeof testCell
>[0];
type T = Parameters<Parameters<typeof testCell>[2]>[0];
const state = (t: T) => t.getState() as unknown as FeedbackState;

testCell(feedback, "enabled stays false with no runtime", async (t) => {
  installFeedbackRuntime(null);
  await t.send.refresh!();
  assertEquals(state(t).enabled, false);
});

testCell(
  feedback,
  "enabled becomes true once a runtime is installed",
  async (t) => {
    installFeedbackRuntime({
      capture: () =>
        Promise.resolve({
          id: "r1",
          path: "/dev/null",
          createdAt: new Date(0).toISOString(),
          delivered: false,
        }),
      count: () => Promise.resolve(0),
    });
    try {
      await t.send.refresh!();
      assertEquals(state(t).enabled, true);
      assertEquals(state(t).pending, 0);
    } finally {
      installFeedbackRuntime(null);
    }
  },
);

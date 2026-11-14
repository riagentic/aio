// feedback-dismiss-clears-error.test.ts — `feedback.dismiss()` puts the error
// away with the report it was about.
//
// dismiss() set "idle" and left `error` set; refresh() clears it only from
// status "error", so nothing but the next SUCCESSFUL report ever cleared it — a
// UI bound to `feedback.error` showed a stale failure beside "idle".
// `updates.dismiss()` clears its error for exactly this reason.
import { assertEquals } from "@std/assert";
import { testCell } from "../src/cell-test.ts";
import {
  createFeedbackCell,
  type FeedbackState,
  installFeedbackRuntime,
} from "../src/state/feedback-cell.ts";

const feedback = createFeedbackCell() as unknown as Parameters<
  typeof testCell
>[0];
type T = Parameters<Parameters<typeof testCell>[2]>[0];
const state = (t: T) => t.getState() as unknown as FeedbackState;

testCell(
  feedback,
  "dismiss after a failed report clears the error",
  async (t) => {
    installFeedbackRuntime({
      capture: () => Promise.reject(new Error("disk full")),
      count: () => Promise.resolve(0),
    });
    try {
      await t.send.report!("it broke");
      assertEquals(state(t).status, "error");
      assertEquals(state(t).error, "disk full");
      t.send.dismiss!();
      await t.send.refresh!();
      assertEquals(state(t).status, "idle");
      assertEquals(
        state(t).error,
        null,
        "stale error survives dismiss + refresh",
      );
    } finally {
      installFeedbackRuntime(null);
    }
  },
);

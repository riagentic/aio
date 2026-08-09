// feedback.ts — public entry for the built-in `feedback` cell (`aio/feedback`).
//
// A separate entry for the same reason `aio/updates` is one: `cell()`
// self-registers, so re-exporting it from `mod.ts` would put a feedback cell in
// every aio app ever written. Importing `aio/feedback` is the act of opting in.
//
//   import { feedback } from "aio/feedback";
//   …
//   <button onClick={() => feedback.report(title, details)}>Report a problem</button>
import { createFeedbackCell } from "./state/feedback-cell.ts";

export {
  type FeedbackCell,
  type FeedbackState,
  type FeedbackStatus,
  type SubmittedReport,
} from "./state/feedback-cell.ts";

/** The built-in `feedback` cell — created at the import of this entry, which is
 *  the opt-in act. See `createFeedbackCell` for why it is a factory. */
export const feedback = createFeedbackCell();

export type { Report, ReportKind, ReportSources } from "./server/report.ts";

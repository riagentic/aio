// feedback-cell.ts — the built-in `feedback` cell.
//
// "Report a problem" is a button, and a button needs state: is it sending, did
// it work, where did the report go. That is a cell, for the same reasons the
// updates cell is one — reactive binding, sync to every client, testCell
// coverage, `am state` visibility — and for one more that matters here: an app
// author writing a report dialog should not have to learn a second API to do
// it.
//
// The capture itself is injected by the server (`installFeedbackRuntime`), so
// this module stays in the isomorphic core and knows nothing about files,
// timelines or logs.
import { cell } from "./cell.ts";
import type { CellEntry } from "./cell-types.ts";

/** What a submitted report left behind. */
export type SubmittedReport = {
  id: string;
  /** Where it was written. Shown so a user can attach it, or a maintainer can
   *  find it — a report nobody can locate is a report nobody reads. */
  path: string;
  createdAt: string;
  /** True when a configured sink accepted it. False means it is only on disk,
   *  which is still a success — the app has no idea when someone will collect
   *  it, and losing it because a server was down would be worse. */
  delivered: boolean;
};

/** Where a report is in its life: idle, being captured, written, or failed. */
export type FeedbackStatus = "idle" | "capturing" | "saved" | "error";

/** The platform half, installed by the server when `feedback` is configured. */
export type FeedbackRuntime = {
  capture(input: {
    kind: "user" | "crash" | "error";
    title: string;
    body?: string;
    contact?: string;
  }): Promise<SubmittedReport>;
  /** How many reports are waiting on disk. */
  count(): Promise<number>;
};

let runtime: FeedbackRuntime | null = null;

/** Install the platform half. Called once by the server at boot. */
export function installFeedbackRuntime(r: FeedbackRuntime | null): void {
  runtime = r;
  _reportTimes.length = 0;
}

// ── Rate limit ───────────────────────────────────────────────────────────────
//
// `report()` is deliberately ANONYMOUS (`access` is not declared: refusing
// anonymous reports on an exposed app silences the people most likely to hit
// something). Every call serializes the app's state, writes it to disk and
// POSTs it to the configured sink — so "anonymous" plus "unlimited" was a
// remote disk-fill and an outbound-traffic amplifier reachable by anyone who
// could load the page, and there was nothing an author could set to stop it.
//
// A BUDGET, not an auth rule: a human pressing a Report button hits this
// never, and a script hits it immediately. Process-wide rather than per
// client, because the abuse is the WRITES, and the caller identity on an
// anonymous endpoint is worth nothing anyway.
const REPORT_MAX = 5;
const REPORT_WINDOW_MS = 60_000;
const _reportTimes: number[] = [];

/** Test isolation — forget the window. @internal */
export function _resetFeedbackRate(): void {
  _reportTimes.length = 0;
}

/** Record this attempt; false when the budget for the window is spent. */
function _reportBudgetOk(now = Date.now()): boolean {
  while (
    _reportTimes.length > 0 && now - _reportTimes[0]! >= REPORT_WINDOW_MS
  ) {
    _reportTimes.shift();
  }
  if (_reportTimes.length >= REPORT_MAX) return false;
  _reportTimes.push(now);
  return true;
}

/** The `feedback` cell's state — whether reporting is enabled, the last
 *  report's status, and the reports captured this session. */
export type FeedbackState = {
  /** False when the app did not configure `feedback`. */
  enabled: boolean;
  status: FeedbackStatus;
  /** The most recent report this session — what a "thanks, saved to …" line
   *  reads from. */
  last: SubmittedReport | null;
  /** Reports on disk, including ones captured automatically. */
  pending: number;
  error: string | null;
};

/** The public surface, written out rather than inferred — this is a published
 *  API and an app author should see exactly what they can call and read. */
export type FeedbackCell = Readonly<FeedbackState> & CellEntry & {
  /** Capture a report. `title` is required; everything else is optional and
   *  everything factual is collected for you. */
  report(
    title: string,
    body?: string,
    contact?: string,
  ): Promise<void>;
  /** Refresh `pending` from disk. */
  refresh(): Promise<void>;
  /** Clear the last-report banner. */
  dismiss(): void;
};

let _feedback: FeedbackCell | null = null;

/** Create (once) the built-in `feedback` cell.
 *
 *  A FACTORY, not a module-level `cell(…)`, and that distinction is
 *  load-bearing. `cell()` self-registers on evaluation, so a module that builds
 *  it at import time can only be pulled in for its SIDE EFFECT — which is what
 *  `aio.run()` used to do, with `await import(…)` from inside the call an app
 *  top-level-awaits. A dynamic import of a module whose graph is still
 *  evaluating cannot complete, and Deno reports it as
 *  "module evaluation is still pending … This is a bug in Deno": the app hangs
 *  at boot with no banner and nothing to search for.
 *
 *  Registering on CALL instead keeps the property the dynamic import existed
 *  for — an app that never asked for feedback never gets the cell — and lets
 *  every caller use a plain static import. Memoised because the cell binds to
 *  exactly one app (D2): `aio/feedback` and the boot path must get the same
 *  object, not two. */
export function createFeedbackCell(): FeedbackCell {
  if (_feedback) return _feedback;
  _feedback = cell("feedback", {
    state: {
      enabled: false,
      status: "idle" as FeedbackStatus,
      last: null as SubmittedReport | null,
      pending: 0,
      error: null as string | null,
    },

    // Nothing here is worth surviving a restart: the reports themselves are the
    // durable artifact, and `pending` is re-derived from disk at boot. Persisting
    // a stale "saved" banner would outlive the thing it described.
    persist: "none",

    // Report contents are the app's own state, already redacted by the same rule
    // the journal uses — but the FACT that a report exists, and its path, are
    // fine to show. Nothing secret is broadcast: the report body lives on disk,
    // never in this cell.
    visible: "all",

    // Anyone using the app may report a problem — that is the point of a feedback
    // button, and refusing anonymous reports on an exposed app would silence the
    // people most likely to hit something. What it CANNOT do is read anything
    // back: a report is written to disk, and only the local maintainer reads it.
    transaction: true,

    methods: {
      async report(s, title: string, body?: string, contact?: string) {
        s.enabled = runtime !== null;
        if (!runtime) {
          s.error = "feedback is not configured for this app";
          s.status = "error";
          return;
        }
        if (!title.trim()) {
          // A report with no title is a row nobody triages.
          s.error = "a report needs a one-line description of the problem";
          s.status = "error";
          return;
        }
        if (!_reportBudgetOk()) {
          // Refused OUT LOUD — the caller is told, and told when to retry.
          // A silently dropped report is worse than a refused one: the person
          // filing it believes the maintainer has it.
          s.error = `too many reports — this app accepts ${REPORT_MAX} per ` +
            `minute and that budget is spent. Wait a minute and send it again ` +
            `(each report writes a copy of app state to disk and to the ` +
            `configured sink, so the cap is what keeps that from being a ` +
            `remote disk-fill).`;
          s.status = "error";
          return;
        }
        s.status = "capturing";
        s.error = null;
        try {
          const saved = await runtime.capture({
            kind: "user",
            title,
            body,
            contact,
          });
          s.last = saved;
          s.pending = await runtime.count();
          s.status = "saved";
        } catch (e) {
          s.status = "error";
          s.error = e instanceof Error ? e.message : String(e);
        }
      },

      async refresh(s) {
        // `enabled` is a fact about CONFIG, not the network: true exactly when
        // the server installed a runtime at boot (boot fires one refresh once
        // cells are bound — see beginFeedback). Never written anywhere else,
        // so an app gating its UI on it sees the truth, not `false` forever.
        s.enabled = runtime !== null;
        if (!runtime) return;
        try {
          s.pending = await runtime.count();
          // A previous failure must not outlive its cause.
          if (s.status === "error") {
            s.status = "idle";
            s.error = null;
          }
        } catch (e) {
          // `refresh()` is a public method, not an observe-only hook: swallowing
          // this left `pending` silently stale with nothing in state to see. Its
          // sibling `report()` already records failures the same way.
          s.status = "error";
          s.error = e instanceof Error ? e.message : String(e);
        }
      },

      dismiss(s) {
        s.last = null;
        s.status = "idle";
      },
    },
  }) as unknown as FeedbackCell;
  return _feedback;
}

// feedback-boot.ts — wiring the `feedback` cell to the machinery that captures
// a report, and capturing the ones nobody is around to ask for.
//
// The reports that matter most are the ones a user never files. So this also
// listens to the diagnostic bus and writes a report when the app breaks — with
// the same contents, the same redaction and the same caps as one somebody
// typed, because a maintainer should not have two formats to read.
import type { Log } from "../diagnostics/logger-api.ts";
import { diagSubscribe } from "../diagnostics/diagnostic-bus.ts";
import type { Redactor } from "../diagnostics/redact.ts";
// Type-only: the cell module self-registers on import, so the VALUE import
// happens dynamically in startFeedback — an app that never configured feedback
// must not carry a feedback cell.
import type {
  FeedbackRuntime,
  SubmittedReport,
} from "../state/feedback-cell.ts";
import { installFeedbackRuntime } from "../state/feedback-cell.ts";
import {
  buildReport,
  listReports,
  type Report,
  type ReportKind,
  reportsDir,
  type ReportSources,
  writeReport,
} from "./report.ts";
import { join } from "@std/path";

/** What an app writes in `aio.run({ feedback })`. `true` is the whole
 *  configuration for most apps. */
export type FeedbackInput = boolean | FeedbackConfig;

export type FeedbackConfig = {
  /** Capture a report automatically when the app breaks. Default `true` — the
   *  reports worth having are the ones nobody was there to file. */
  auto?: boolean;
  /** POST each report as JSON here. Optional: with no destination, reports
   *  simply accumulate in the data dir, which is a complete feature on its own
   *  (a maintainer reads them; `am report` lists them). */
  url?: string;
  /** Anything else — a queue, a file drop, an issue tracker's API. Runs after
   *  the report is safely on disk, never instead of it. */
  sink?: (report: Report) => Promise<void>;
  /** How many reports to keep on disk. Default 50. */
  keep?: number;
};

export type ResolvedFeedback = {
  auto: boolean;
  url?: string;
  keep: number;
  hasSink: boolean;
};

export function resolveFeedback(input: FeedbackInput): ResolvedFeedback {
  const cfg: FeedbackConfig = input === true
    ? {}
    : input === false
    ? {}
    : input;
  return {
    auto: cfg.auto ?? true,
    url: cfg.url,
    keep: cfg.keep ?? 50,
    hasSink: typeof cfg.sink === "function",
  };
}

/** Delete all but the newest `keep` reports. Bounded storage in somebody's home
 *  directory is not optional — an app that fills a disk with its own bug
 *  reports has become the bug. */
async function prune(dataDir: string, keep: number): Promise<void> {
  try {
    const files: { name: string; path: string }[] = [];
    const dir = reportsDir(dataDir);
    for await (const e of Deno.readDir(dir)) {
      if (e.isFile && e.name.endsWith(".json")) {
        files.push({ name: e.name, path: join(dir, e.name) });
      }
    }
    // Ids lead with an ISO timestamp, so lexical order IS chronological.
    files.sort((a, b) => (a.name < b.name ? 1 : -1));
    for (const f of files.slice(keep)) {
      await Deno.remove(f.path).catch(() => {});
    }
  } catch { /* nothing to prune */ }
}

export type StartFeedbackDeps = {
  feedback: FeedbackInput;
  sources: ReportSources;
  log: Log;
  redact?: Redactor;
};

export type StartedFeedback = ResolvedFeedback & { stop: () => void };

/** How many automatic reports one session may write.
 *
 *  A failing effect can fire thousands of times a minute. Without a ceiling the
 *  first real problem would bury itself under its own reports and take the disk
 *  with it — so the cap is low, and hitting it is said out loud once. */
const MAX_AUTO_PER_SESSION = 10;

/** How many distinct error keys the auto-capture dedup remembers. */
export const _SEEN_LIMIT = 4096;

/** A bounded insertion-ordered key memory: remembers the last `limit` keys and
 *  forgets the oldest beyond that.
 *
 *  A plain `Set` here grew for the life of the process. Error messages
 *  routinely embed a varying id ("request 4f3a failed", a path, a timestamp),
 *  so nearly every one was a fresh key — and the per-session capture cap
 *  bounds REPORTS, never this. Long-running servers are exactly the ones that
 *  produce a long tail of unique errors.
 *  @internal */
export function _createSeenKeys(limit: number = _SEEN_LIMIT): {
  has: (k: string) => boolean;
  add: (k: string) => void;
  size: () => number;
} {
  const keys = new Set<string>();
  return {
    has: (k) => keys.has(k),
    add: (k) => {
      if (keys.has(k)) return;
      // Set iteration is insertion-ordered, so the first value IS the oldest.
      while (keys.size >= limit) {
        const oldest = keys.values().next().value;
        if (oldest === undefined) break;
        keys.delete(oldest);
      }
      keys.add(k);
    },
    size: () => keys.size,
  };
}

// Synchronous, and says so. It was `async` while it reached for a dynamic
// import; that import became static (an app top-level-awaiting `aio.run()`
// could not finish module evaluation otherwise) and the `async` stayed behind,
// leaving a function that promised to be awaited for no reason. Callers already
// `await` it, which is unchanged either way.
export function startFeedback(deps: StartFeedbackDeps): StartedFeedback {
  const cfg = resolveFeedback(deps.feedback);
  const userCfg: FeedbackConfig = deps.feedback === true
    ? {}
    : deps.feedback === false
    ? {}
    : deps.feedback;
  const sources: ReportSources = { ...deps.sources, redact: deps.redact };
  const { log } = deps;

  const capture = async (input: {
    kind: ReportKind;
    title: string;
    body?: string;
    contact?: string;
  }): Promise<SubmittedReport> => {
    const report = await buildReport(input, sources);
    const path = await writeReport(sources.dataDir, report);
    await prune(sources.dataDir, cfg.keep);

    // Delivery is attempted AFTER the report is on disk, and never replaces
    // it. An app has no idea whether a destination is reachable, and losing a
    // report because a server was down is the one outcome worth engineering
    // against.
    let delivered = false;
    try {
      if (cfg.url) {
        const res = await fetch(cfg.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(report),
        });
        delivered = res.ok;
        await res.body?.cancel();
      }
      if (userCfg.sink) {
        await userCfg.sink(report);
        delivered = true;
      }
    } catch (e) {
      log.warn(
        "feedback",
        `report ${report.id} saved to ${path} but could not be delivered: ${e}`,
      );
    }

    log.info(
      "feedback",
      `report ${report.id} saved → ${path}${delivered ? " (delivered)" : ""}`,
    );
    return { id: report.id, path, createdAt: report.createdAt, delivered };
  };

  const runtime: FeedbackRuntime = {
    capture,
    count: async () => (await listReports(sources.dataDir)).length,
  };

  // Static — see the note in updates-boot.ts: a dynamic import from inside the
  // call an app top-level-awaits can leave module evaluation unable to finish.
  installFeedbackRuntime(runtime);

  // Automatic capture. Deduped by message so one repeating fault produces one
  // report, not one per occurrence.
  let autoCount = 0;
  let warnedCap = false;
  const seen = _createSeenKeys();
  let unsubscribe: (() => void) | null = null;

  if (cfg.auto) {
    unsubscribe = diagSubscribe((event) => {
      if (String(event.severity) !== "error") return;
      const key = `${event.type}:${String(event.message).slice(0, 200)}`;
      if (seen.has(key)) return;
      seen.add(key); // bounded — see _createSeenKeys
      if (autoCount >= MAX_AUTO_PER_SESSION) {
        if (!warnedCap) {
          warnedCap = true;
          log.warn(
            "feedback",
            `automatic reports capped at ${MAX_AUTO_PER_SESSION} this session — ` +
              `further errors are logged but not captured`,
          );
        }
        return;
      }
      autoCount++;
      // Fire and forget: capturing a problem must never cause one, and must
      // never block the dispatch that reported it.
      void capture({
        kind: "error",
        title: `${event.type}: ${String(event.message).slice(0, 200)}`,
      }).catch((e) => log.warn("feedback", `automatic capture failed: ${e}`));
    });
  }

  return {
    ...cfg,
    stop: () => {
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

export type { FeedbackRuntime };

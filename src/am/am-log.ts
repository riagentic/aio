/**
 * @module
 * `am`'s log routing: STDOUT is `am`'s data channel, so nothing else may use it.
 *
 * `--json` promises one JSON document on stdout, and a framework module that
 * `am` merely CALLS could break that promise from three modules away: the pin
 * reader announces `aio: local path pin → …` through `log.info`, which the
 * console formatter sends to stdout (the level picks the stream, and info is
 * an stdout level for a SERVER). `am pin --json` and `am link --json` therefore
 * emitted a log line ahead of the document and were not parseable JSON at all.
 *
 * The fix is one decider rather than a quiet flag threaded through every
 * reader: for the lifetime of an `am` process every framework log line goes to
 * STDERR, whatever level it carries. A human still sees it; `jq` never does.
 */
import { getLogDir, setLogger } from "../diagnostics/logger-api.ts";
import type { LogSink } from "../diagnostics/logger-types.ts";
import { now } from "../diagnostics/logger-types.ts";
import { formatText } from "../diagnostics/logger-format.ts";

/** The sink `am` runs with: the framework's own line, on stderr, at the same
 *  levels the console fallback shows (info and above — trace/debug stay off
 *  unless a logger is configured). Pure apart from the write. */
export const AM_STDERR_SINK: LogSink = {
  get logDir(): string {
    return getLogDir();
  },
  pub(lvl, cat, msg, data) {
    if (lvl !== "info" && lvl !== "warn" && lvl !== "error") return;
    console.error(
      formatText({ ts: now(), lvl, cat, msg, ...(data ? { data } : {}) }),
    );
  },
  perf() {/* am has no perf budget of its own */},
  flush(): Promise<void> {
    return Promise.resolve();
  },
};

/** Install {@linkcode AM_STDERR_SINK}. Called once, first thing in `am`'s
 *  `main()` — before any command, and before the pin reader that started this. */
export function routeAmLogsToStderr(): void {
  setLogger(AM_STDERR_SINK);
}

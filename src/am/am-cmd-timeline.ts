// `am timeline` + `am replay` — the time-travel commands.
//
//  • `am timeline`  — every recent dispatch, its payload, and the state diff it
//    produced. Live from the running app (in-memory ring, always on), or from a
//    durable journal file with `--from=<path>` (payloads only — the journal
//    doesn't store diffs).
//  • `am replay <range>` — deterministically re-dispatch a journal range against
//    the running app, to reproduce a bug (the "froze in electron but the test
//    passed" class becomes replay-and-look). `--dry` lists without dispatching.
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, out, outError } from "./am-output.ts";
import { amCtx, defaultJournalPath, resolveAmAppId } from "./am-utils.ts";
import { trojanGet, trojanPost } from "./am-http.ts";
import {
  isRedactedRow,
  type JournalRow,
  parseJournalEntries,
} from "./record.ts";
import type { DiffEntry, TimelineEntry } from "../server/timeline.ts";
import { count } from "../diagnostics/fmt.ts";

/** hh:mm:ss for a ms timestamp (local time). */
function clock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Compact one-line JSON, elided past ~60 chars so a header line stays scannable. */
function brief(v: unknown): string {
  if (v === undefined) return "";
  let s: string;
  try {
    s = JSON.stringify(v);
  } catch {
    s = String(v);
  }
  return s && s.length > 60 ? s.slice(0, 57) + "…" : s ?? "";
}

/** Pretty-render a diff leaf: `path: before → after`. */
function renderDiff(d: DiffEntry): string {
  if (d.path === "…") return `    ${d.before}`;
  return `    ${d.path}: ${brief(d.before)} → ${brief(d.after)}`;
}

/** Pretty-render a live timeline (entries carry diffs). */
function renderTimeline(entries: TimelineEntry[]): string {
  if (entries.length === 0) return "no dispatches recorded yet";
  const lines: string[] = [];
  for (const e of entries) {
    const args = (e.payload as { args?: unknown[] })?.args;
    const argStr = Array.isArray(args) && args.length > 0
      ? `(${args.map(brief).join(", ")})`
      : e.payload !== undefined
      ? ` ${brief(e.payload)}`
      : "";
    // A write-set commit is shown as what it IS — the async method's writes —
    // rather than as the opaque `cell:__setFoo` symbol the reducer sees. The
    // type is not renamed (a timeline that renames what happened is a timeline
    // that lies); the attribution is added beside it.
    const what = e.origin
      ? `${e.origin} ⟵ write-set (${e.type.slice(e.type.indexOf(":") + 1)})`
      : e.type;
    lines.push(`#${e.seq}  ${clock(e.ts)}  ${what}${argStr}`);
    for (const d of e.diff) lines.push(renderDiff(d));
  }
  return lines.join("\n");
}

/** Pretty-render offline journal rows (no diffs — the file stores actions only). */
function renderJournalRows(rows: JournalRow[]): string {
  if (rows.length === 0) return "journal has no entries";
  return rows.map((r) => {
    const args = (r.payload as { args?: unknown[] })?.args;
    const argStr = Array.isArray(args) && args.length > 0
      ? `(${args.map(brief).join(", ")})`
      : r.payload !== undefined
      ? ` ${brief(r.payload)}`
      : "";
    const when = r.ts ? `  ${clock(r.ts)}` : "";
    return `#${r.seq}${when}  ${r.type}${argStr}`;
  }).join("\n");
}

/** `am timeline [--from=<journal>] [--lines=N] [--json]`. */
export async function cmdTimeline(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const fromFlag = args.find((a) => a.startsWith("--from="));
  const limit = flags.lines;

  // Offline: read a durable journal file (payloads only — no diffs).
  if (fromFlag) {
    const path = fromFlag.slice("--from=".length) ||
      defaultJournalPath(resolveAmAppId(flags.app));
    let text: string;
    try {
      text = await Deno.readTextFile(path);
    } catch {
      outError(`no journal at "${path}"`, mode);
      Deno.exit(1);
    }
    let rows = parseJournalEntries(text);
    if (limit && rows.length > limit) rows = rows.slice(rows.length - limit);
    out(mode === "pretty" ? renderJournalRows(rows) : { entries: rows }, mode);
    return;
  }

  // Live: the in-memory ring on the running app (always on, carries diffs).
  const ctx = amCtx(flags);
  const q = limit ? `timeline?limit=${limit}` : "timeline";
  const r = await trojanGet(ctx.port, q, ctx.appId);
  if (!r.ok) {
    outError(
      `${r.error} — is the app running? (offline: am timeline --from=<journal>)`,
      mode,
    );
    Deno.exit(1);
  }
  const entries = (r.data as { entries?: TimelineEntry[] })?.entries ?? [];
  out(mode === "pretty" ? renderTimeline(entries) : { entries }, mode);
}

/** Parse a range spec: `5..12` (inclusive), `5` (single), or absent (all). */
export function parseRange(
  spec: string | undefined,
): { lo: number; hi: number } {
  if (!spec) return { lo: -Infinity, hi: Infinity };
  const m = spec.match(/^(\d+)\.\.(\d+)$/);
  if (m) return { lo: Number(m[1]), hi: Number(m[2]) };
  if (/^\d+$/.test(spec)) return { lo: Number(spec), hi: Number(spec) };
  return { lo: NaN, hi: NaN }; // signals a bad spec
}

/** `am replay [<range>] [--from=<journal>] [--dry]` — re-dispatch a journal
 *  range against the running app for deterministic repro. */
export async function cmdReplay(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const fromFlag = args.find((a) => a.startsWith("--from="));
  const dry = args.includes("--dry");
  const rangeSpec = args.find((a) => !a.startsWith("--"));
  const path = fromFlag
    ? fromFlag.slice("--from=".length)
    : defaultJournalPath(resolveAmAppId(flags.app));

  const { lo, hi } = parseRange(rangeSpec);
  if (Number.isNaN(lo)) {
    outError(`bad range "${rangeSpec}" — use N, N..M, or omit for all`, mode);
    Deno.exit(1);
  }

  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch {
    outError(
      `no journal at "${path}" — enable it with aio.run({ journal: true }) ` +
        `or pass --from=<path>`,
      mode,
    );
    Deno.exit(1);
  }
  const rows = parseJournalEntries(text).filter((r) =>
    r.seq >= lo && r.seq <= hi
  );
  if (rows.length === 0) {
    outError(`no journal entries in range`, mode);
    Deno.exit(1);
  }

  // Dry run: show what WOULD replay, dispatch nothing.
  if (dry) {
    out(
      mode === "pretty"
        ? `would replay ${count(rows.length, "action")}:\n${
          renderJournalRows(rows)
        }`
        : { dryRun: true, count: rows.length, entries: rows },
      mode,
    );
    return;
  }

  // Re-dispatch each action against the running app, in order.
  const ctx = amCtx(flags);
  const results: {
    seq: number;
    type: string;
    ok: boolean;
    error?: string;
    skipped?: true;
  }[] = [];
  for (const r of rows) {
    // A redacted row has no arguments — they were deliberately never written.
    // Re-dispatching it would send the literal string "[redacted]" as the
    // payload to a LIVE app: a method invoked with garbage, in the name of
    // reproducing a bug. Refuse it, name it, and keep going, because the rest
    // of the range is still a real repro — just an incomplete one.
    if (isRedactedRow(r)) {
      results.push({
        seq: r.seq,
        type: r.type,
        ok: false,
        skipped: true,
        error: "redacted — arguments were never recorded, cannot replay",
      });
      continue;
    }
    const res = await trojanPost(
      ctx.port,
      "dispatch",
      { type: r.type, payload: r.payload },
      ctx.appId,
    );
    results.push(
      res.ok
        ? { seq: r.seq, type: r.type, ok: true }
        : { seq: r.seq, type: r.type, ok: false, error: res.error },
    );
    if (!res.ok) break; // stop at the first failure — repro fidelity
  }

  // A skip is not a failure of the replay run — it is a hole IN the repro, and
  // it has to be visible either way. Only a real dispatch error stops the run.
  const failed = results.find((r) => !r.ok && !r.skipped);
  const skipped = results.filter((r) => r.skipped);
  if (mode === "pretty") {
    const lines = results.map((r) =>
      `${r.skipped ? "⊘" : r.ok ? "✓" : "✗"} #${r.seq} ${r.type}${
        r.error ? ` — ${r.error}` : ""
      }`
    );
    lines.push(
      failed
        ? `replay stopped at #${failed.seq} (${
          results.filter((r) => r.ok).length
        }/${rows.length} applied)`
        : `replayed ${count(results.filter((r) => r.ok).length, "action")}`,
    );
    if (skipped.length > 0) {
      lines.push(
        `⚠ ${skipped.length} redacted action(s) SKIPPED — this repro is ` +
          `incomplete; their arguments were never recorded`,
      );
    }
    out(lines.join("\n"), mode);
  } else {
    out({
      replayed: results.filter((r) => r.ok).length,
      skipped: skipped.length,
      results,
    }, mode);
  }
  if (failed) Deno.exit(1);
}

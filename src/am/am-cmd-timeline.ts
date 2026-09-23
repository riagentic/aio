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
import { detectMode, out, outData, outError, sayErr } from "./am-output.ts";
import { amCtx, defaultJournalPath, resolveAmAppId } from "./am-utils.ts";
import { trojanGet, trojanPost } from "./am-http.ts";
import {
  isRedactedRow,
  journalDamage,
  type JournalRow,
  parseJournal,
} from "./record.ts";
import type { DiffEntry, TimelineEntry } from "../server/timeline.ts";
import { TIMELINE_RING } from "../server/timeline.ts";
import { count } from "../diagnostics/fmt.ts";
import {
  isListenerReaction,
  isSyncOpReaction,
  staleStamps,
  TT_RESTORE_TYPE,
} from "../server/journal.ts";

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
    lines.push(
      isListenerReaction(e)
        ? `#${e.seq}  ${clock(e.ts)}  ${reactionLabel(e)}`
        : e.type === TT_RESTORE_TYPE
        ? `#${e.seq}  ${clock(e.ts)}  ${timeTravelLabel(e.payload)}`
        : `#${e.seq}  ${clock(e.ts)}  ${what}${argStr}`,
    );
    for (const d of e.diff) lines.push(renderDiff(d));
  }
  return lines.join("\n");
}

/** A time-travel row, said as what happened — its payload is a whole state,
 *  which a one-line header cannot usefully show. */
function timeTravelLabel(payload: unknown): string {
  const p = payload as { cmd?: unknown; arg?: unknown } | undefined;
  const arg = typeof p?.arg === "number" ? ` ${p.arg}` : "";
  return `time travel: ${typeof p?.cmd === "string" ? p.cmd : "jump"}${arg}` +
    ` (state restored)`;
}

/** A `listensTo` reaction row: the cells whose state it carries — it is
 *  neither an action nor a jump (see `isListenerReaction`). */
function reactionLabel(e: { type: string; payload?: unknown }): string {
  const p = e.payload as
    | { cell?: unknown; cells?: unknown; deltas?: unknown }
    | undefined;
  const keys = (o: unknown): string[] =>
    o && typeof o === "object" ? Object.keys(o) : [];
  const cells = typeof p?.cell === "string" ? [p.cell] : [
    ...keys(p?.cells),
    ...keys((p as { keyframes?: unknown } | undefined)?.keyframes),
    ...keys(p?.deltas),
  ];
  if ((p as { write?: unknown } | undefined)?.write === true) {
    return `state of ${
      cells.join(", ") || "?"
    } after the call above, at its op-log position (restored from here)`;
  }
  if ((p as { jump?: unknown } | undefined)?.jump === true) {
    return `time travel: ${cells.join(", ") || "?"} (sync state restored)`;
  }
  return `listensTo reaction: ${cells.join(", ") || "?"} (state recorded${
    isSyncOpReaction(e)
      ? "; caused by a sync op, not in the journal — not reproduced"
      : ""
  })`;
}

/** Pretty-render offline journal rows (no diffs — the file stores actions only). */
function renderJournalRows(rows: JournalRow[]): string {
  if (rows.length === 0) return "journal has no entries";
  return rows.map((r) => {
    if (isListenerReaction(r)) {
      return `#${r.seq}${r.ts ? `  ${clock(r.ts)}` : ""}  ${reactionLabel(r)}`;
    }
    if (r.type === TT_RESTORE_TYPE) {
      return `#${r.seq}${r.ts ? `  ${clock(r.ts)}` : ""}  ${
        timeTravelLabel(r.payload)
      }`;
    }
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

/** Did the RING decide the answer, rather than the history? True only when
 *  more was asked for than came back AND the ring has dropped entries — three
 *  dispatches are three dispatches, not a truncation. `rotated` is the app's
 *  own answer (the ring is bounded by retained bytes as well as count, so a
 *  ring of 40 big entries may already have dropped some); an app that does not
 *  say is judged by count, as before. Pure. */
export function timelineCapped(
  limit: number | undefined,
  returned: number,
  rotated?: boolean,
): boolean {
  return limit !== undefined && limit > returned &&
    (rotated ?? returned >= TIMELINE_RING);
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
    const parsed = parseJournal(text);
    // A damaged journal is SAID, never inferred from a short answer. It used
    // to truncate at the first bad line and report the remainder as the whole
    // file, exit 0.
    const damage = journalDamage(parsed, path);
    if (damage) sayErr(damage);
    let rows = parsed.rows;
    if (limit && rows.length > limit) rows = rows.slice(rows.length - limit);
    outData(
      mode === "pretty" ? renderJournalRows(rows) : { entries: rows },
      mode,
    );
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
  const data = r.data as { entries?: TimelineEntry[]; rotated?: boolean };
  const entries = data?.entries ?? [];
  // A request for more than the ring holds is answered with the ring, and used
  // to be answered SILENTLY: `--lines=20000` returned 500 rows with nothing to
  // say they were the last 500 of an unknown number. "Everything there is" and
  // "as much as I keep" are different answers, and only one of them means you
  // can stop looking. The journal is the unbounded history; name it.
  const capped = timelineCapped(limit, entries.length, data?.rotated);
  outData(
    capped
      ? {
        entries,
        requested: limit,
        returned: entries.length,
        capped,
        ring: TIMELINE_RING,
      }
      : { entries },
    mode,
    () =>
      renderTimeline(entries) +
      (capped
        ? `\n\n${entries.length} of the ${limit} asked for — the live ` +
          `timeline keeps the last ${TIMELINE_RING} dispatches (fewer when ` +
          `they carry big values). The full ` +
          `history is the journal: am timeline --from=<journal>`
        : ""),
  );
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

/** Why a journal row is not re-dispatched by `am replay`. */
export type ReplaySkipReason =
  | "effect"
  | "write-set"
  | "time-travel"
  | "reaction"
  | "sync-reaction"
  | "internal"
  | "version";

/** The running app's cell versions, as its trojan `cell-versions` route says
 *  them — what a journal line's version stamp is checked against. */
export type RunningCellVersions = Record<
  string,
  { version: number; migrates: boolean }
>;

/** What `am replay` will send, and what it will not — decided ONCE, so the
 *  dry run and the real run cannot count differently. */
export type ReplayPlan = {
  /** Rows re-dispatched, in seq order. */
  send: JournalRow[];
  /** Rows the running app re-creates on its own (or that are not actions). */
  skip: {
    seq: number;
    type: string;
    reason: ReplaySkipReason;
    /** For `version`: the stamp that refused it (`"w" v1 → v2`). */
    detail?: string;
  }[];
  /** Rows written before the journal recorded `cause`: nothing says which of
   *  them an earlier action produced, so an effect-born one among them is
   *  sent AND re-created — applied twice. */
  unattributed: number;
};

/** The one sentence per skip reason — said in the dry run, the real run and
 *  the JSON alike. */
export const REPLAY_SKIP_WHY: Record<ReplaySkipReason, string> = {
  effect: "caused by an earlier action (a timer it armed, its async body, a " +
    "$do) or by boot (a cell's onInit) — the cause produces it again",
  "write-set": "an async method's write-set — re-running the method " +
    "re-applies it",
  "time-travel": "a time-travel jump — a state restore, not an action; the " +
    "live app is not rewound, so the rows after it run on different state",
  reaction: "a listensTo reaction, journalled as the state it wrote — the " +
    "action that caused it is re-run, and the live app reacts again",
  "sync-reaction": "a listensTo reaction caused by a sync op — the op is in " +
    "the op-log, not the journal, so nothing sent re-creates it: caused by a " +
    "sync op, not in the journal — not reproduced (the rows after it run on " +
    "different state)",
  internal: "framework-internal — not dispatchable",
  version: "written under a cell version the running app does not run (the " +
    "same rule boot recovery applies) — its method is not this build's, and " +
    "re-running it through the new one would be a guess",
};

/** Split journal rows into what `am replay` sends and what it leaves to the
 *  running app. Pure.
 *
 *  Replay re-dispatches against a LIVE app, whose own machinery re-creates
 *  everything a replayed action causes. Sending those rows as well applied
 *  them twice (`later(4)`, which schedules `inc(4)`, replayed as +9) — or
 *  halted the run: an async method's `cell:__setX` write-set is refused by the
 *  dispatch route, after `--dry` had promised it. Only INPUT rows are sent.
 *
 *  A row's `cause` says which it is. A journal written before `cause` existed
 *  cannot say, so its `__` rows are still recognised as internal and the rest
 *  are sent — and counted, so the run can say its answer may double-apply. */
export function planReplay(
  rows: JournalRow[],
  /** The running app's cell versions. Present ⇒ a line whose version stamp
   *  the app would refuse at boot (`staleStamps`) is not sent either: a v1
   *  `add(5)` meaning "+5 units", re-sent to a v2 app whose `add` takes
   *  cents, reproduces a state no build ever held. */
  versions?: RunningCellVersions,
): ReplayPlan {
  const plan: ReplayPlan = { send: [], skip: [], unattributed: 0 };
  for (const r of rows) {
    const method = r.type.slice(r.type.indexOf(":") + 1);
    const cause = (r as { cause?: unknown }).cause;
    // `jump: true` means "time travel" ONLY on a sync-reaction row (see
    // `SyncReaction.jump` in journal.ts). Read on any row, it skipped a real
    // user action whose own payload happens to say it — `player:move
    // {jump: true}` — as time travel, and the replay silently dropped it.
    const reason: ReplaySkipReason | null = isListenerReaction(r) &&
        (r.payload as { jump?: unknown } | undefined)?.jump === true
      ? "time-travel"
      : isSyncOpReaction(r)
      ? "sync-reaction"
      : isListenerReaction(r)
      ? "reaction"
      : r.type === TT_RESTORE_TYPE
      ? "time-travel"
      : method.startsWith("__set")
      ? "write-set"
      : method.startsWith("__")
      ? "internal"
      : cause === "effect"
      ? "effect"
      : null;
    if (reason) {
      plan.skip.push({ seq: r.seq, type: r.type, reason });
      continue;
    }
    const stale = versions
      ? staleStamps(
        (r as { v?: unknown }).v,
        (c) => versions[c]?.version ?? 0,
        (c) => versions[c]?.migrates ?? false,
      )
      : [];
    if (stale.length > 0) {
      plan.skip.push({
        seq: r.seq,
        type: r.type,
        reason: "version",
        detail: stale.map(([c, v]) =>
          `"${c}" v${v} → v${versions![c]?.version ?? 0}`
        ).join(", "),
      });
      continue;
    }
    if (cause === undefined) plan.unattributed++;
    plan.send.push(r);
  }
  return plan;
}

/** The longest pause `am replay` keeps between two inputs — enough for the
 *  timers and async bodies a repro is made of, not an idle user's minutes. */
export const REPLAY_MAX_PAUSE_MS = 5_000;

/** How long to wait before sending `next`: the recorded gap since `prev`, when
 *  the app re-creates rows that fell between them — otherwise nothing. Pure. */
export function replayPause(
  plan: ReplayPlan,
  prev: JournalRow | undefined,
  next: JournalRow,
): number {
  if (!prev || prev.ts === undefined || next.ts === undefined) return 0;
  const between = plan.skip.some((k) =>
    k.seq > prev.seq && k.seq < next.seq &&
    (k.reason === "effect" || k.reason === "write-set")
  );
  return between
    ? Math.min(Math.max(0, next.ts - prev.ts), REPLAY_MAX_PAUSE_MS)
    : 0;
}

/** The skip summary, one line per reason, for the pretty outputs. */
function renderSkips(plan: ReplayPlan): string[] {
  const by = new Map<ReplaySkipReason, number>();
  for (const s of plan.skip) by.set(s.reason, (by.get(s.reason) ?? 0) + 1);
  const lines = [...by].map(([reason, n]) =>
    `⊘ ${count(n, "row")} not sent: ${REPLAY_SKIP_WHY[reason]}${
      reason === "version"
        ? ` (${
          plan.skip.filter((k) => k.reason === "version")
            .map((k) =>
              `#${k.seq} ${k.detail}`
            ).join("; ")
        })`
        : ""
    }`
  );
  if (plan.unattributed > 0) {
    lines.push(
      `⚠ ${count(plan.unattributed, "row")} from a journal that predates ` +
        `cause recording — an action one of them caused (a scheduled or ` +
        `effect-dispatched call) cannot be told apart and may apply twice`,
    );
  }
  return lines;
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
  const parsed = parseJournal(text);
  const damage = journalDamage(parsed, path);
  if (damage) sayErr(damage);
  // A tear INSIDE the file means the actions between the good ones are gone,
  // so a replay would run a sequence that never happened. Refuse it rather
  // than replay a hole silently.
  if (damage && !parsed.tornTailOnly) {
    outError(
      `refusing to replay a damaged journal — ${parsed.badLines.length} ` +
        `unreadable line(s) inside "${path}" mean the actions between the ` +
        `readable ones are gone, so this is not the sequence the app ran. ` +
        `Inspect it with: am timeline --from=${path}`,
      mode,
    );
    Deno.exit(1);
  }
  const rows = parsed.rows.filter((r) => r.seq >= lo && r.seq <= hi);
  if (rows.length === 0) {
    // WHY it is empty is the part worth saying. The journal is the
    // crash-recovery TAIL, not a history: every snapshot compacts away
    // everything at or below the watermark, so a healthy app's live journal is
    // empty almost all of the time and this refusal is what `am replay` says
    // to anyone who points it at one. Accurate, and it taught nothing.
    const total = parsed.rows.length;
    outError(
      total === 0
        ? `the journal at "${path}" is empty — it holds only the actions ` +
          `NOT yet in a snapshot (every persist compacts the rest away), so a ` +
          `healthy app's live journal is empty nearly always. Replay a journal ` +
          `captured from a crashed run with --from=<path>, or keep one on ` +
          `purpose: run with aio.run({ journal: true, persistDebounceMs: ` +
          `600_000 }) so no snapshot compacts it for ten minutes, reproduce, ` +
          `and copy the file before stopping the app (the final snapshot on ` +
          `a clean stop compacts it too).`
        : `no journal entries in range — the journal holds ${total} entr${
          total === 1 ? "y" : "ies"
        }, seq ${parsed.rows[0]?.seq} to ${parsed.rows[total - 1]?.seq}`,
      mode,
    );
    Deno.exit(1);
  }

  // The running app's cell versions — a line stamped with a version it
  // would refuse at boot is not sent either (see `planReplay`). The real run
  // needs the app anyway; a dry run asks when one answers, and says so when
  // none does.
  const stamped = rows.some((r) => (r as { v?: unknown }).v !== undefined);
  let versions: RunningCellVersions | undefined;
  let unchecked: string | undefined;
  let ctx: ReturnType<typeof amCtx> | undefined;
  try {
    ctx = amCtx(flags);
  } catch (e) {
    if (!dry) throw e;
    unchecked = e instanceof Error ? e.message : String(e);
  }
  if (stamped && ctx) {
    const r = await trojanGet(ctx.port, "cell-versions", ctx.appId);
    if (r.ok && r.data && typeof r.data === "object") {
      versions = r.data as RunningCellVersions;
      // An app built before the route existed answers `{}` or a 404 — no
      // versions to check against, which is not the same as "all match".
      if (Object.keys(versions).length === 0) {
        versions = undefined;
        unchecked = "the running app does not report its cell versions " +
          "(an older aio build)";
      }
    } else {
      unchecked = r.ok ? "no answer" : r.error;
    }
  }
  const versionNote = stamped && !versions
    ? `⚠ version stamps NOT checked — ${unchecked ?? "no running app"}. A ` +
      `line written under another cell version would be sent through this ` +
      `build's method.`
    : undefined;

  const plan = planReplay(rows, versions);

  // Dry run: show what WOULD replay, dispatch nothing. The count is the
  // plan's — the same rows the real run sends.
  if (dry) {
    outData(
      mode === "pretty"
        ? [
          `would replay ${count(plan.send.length, "action")}:`,
          renderJournalRows(plan.send),
          ...renderSkips(plan),
          ...(versionNote ? [versionNote] : []),
        ].join("\n")
        : {
          dryRun: true,
          count: plan.send.length,
          entries: plan.send,
          notSent: plan.skip.map((k) => ({
            ...k,
            why: REPLAY_SKIP_WHY[k.reason],
          })),
          ...(plan.unattributed > 0 ? { unattributed: plan.unattributed } : {}),
          ...(versionNote ? { versionsUnchecked: versionNote } : {}),
        },
      mode,
    );
    return;
  }

  // Re-dispatch each action against the running app, in order.
  if (!ctx) throw new Error("unreachable: the real run resolved its app");
  const results: {
    seq: number;
    type: string;
    ok: boolean;
    error?: string;
    skipped?: true;
  }[] = [];
  let prevSent: JournalRow | undefined;
  for (const r of plan.send) {
    // The rows not sent still HAPPEN — the app re-creates them — but on its
    // own clock: a timer fires after its delay, an async body after its
    // awaits. Sent back to back, the next input overtook them and the replay
    // reached the right totals in a different order. Where the run had such
    // rows between two inputs, the recorded gap is kept (capped).
    const gap = replayPause(plan, prevSent, r);
    if (gap > 0) await new Promise((res) => setTimeout(res, gap));
    prevSent = r;
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
        }/${plan.send.length} applied)`
        : `replayed ${count(results.filter((r) => r.ok).length, "action")}`,
    );
    if (skipped.length > 0) {
      lines.push(
        `⚠ ${skipped.length} redacted action(s) SKIPPED — this repro is ` +
          `incomplete; their arguments were never recorded`,
      );
    }
    lines.push(...renderSkips(plan));
    if (versionNote) lines.push(versionNote);
    out(lines.join("\n"), mode);
  } else {
    out({
      replayed: results.filter((r) => r.ok).length,
      skipped: skipped.length,
      results,
      notSent: plan.skip.map((k) => ({ ...k, why: REPLAY_SKIP_WHY[k.reason] })),
      ...(plan.unattributed > 0 ? { unattributed: plan.unattributed } : {}),
      ...(versionNote ? { versionsUnchecked: versionNote } : {}),
    }, mode);
  }
  if (failed) Deno.exit(1);
}

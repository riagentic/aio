// record.ts — `am record`: turn the actions an app ran into a runnable
// bootCells replay test. The source is the RUNNING app's live timeline (every
// committed dispatch since boot, payloads included, redacted by the same rule
// as the journal), or — with the app stopped, or `--from=<path>` — a journal
// file, which is the crash-recovery tail. Emits a test skeleton that
// re-dispatches the flow, ready for assertions.
import type { GlobalFlags } from "./am-types.ts";
import { detectMode, out, outError } from "./am-output.ts";
import {
  amCtx,
  defaultJournalPath,
  overwriteRefusal,
  resolveAmAppId,
} from "./am-utils.ts";
import { trojanGet } from "./am-http.ts";
import { TIMELINE_RING, type TimelineEntry } from "../server/timeline.ts";
// THE sentinel, not a copy of it — one decider for "this payload was
// redacted" across every sink (journal, timeline, am). am → diagnostics is an
// allowed boundary edge.
import { REDACTED } from "../diagnostics/redact.ts";
import { TT_RESTORE_TYPE } from "../server/journal.ts";
import { count } from "../diagnostics/fmt.ts";

type Action = {
  type: string;
  payload?: unknown;
  redacted?: true;
  /** `"effect"`: an earlier action caused it (see `ActionCause`). */
  cause?: string;
  /** The async call rejected in the recorded run (timeline only). */
  threw?: true;
  /** When it committed (ms). Paces the virtual clock when timers matter. */
  ts?: number;
  /** The `_callId` of the async call whose run dispatched it (a write-set, a
   *  dispatch from its body). The last action naming a call is where that
   *  call's recorded run ends — what tells overlapping calls apart. */
  call?: string;
};

/** A recorded timeline entry as a replayable action — the fields a generated
 *  test needs, and nothing the ring keeps for display. */
export function timelineActions(entries: TimelineEntry[]): Action[] {
  return entries.map((e) => ({
    type: e.type,
    payload: e.payload,
    ts: e.ts,
    ...(e.cause ? { cause: e.cause } : {}),
    ...(e.threw ? { threw: e.threw } : {}),
    ...(e.call ? { call: e.call } : {}),
  }));
}

/** A journal entry whose arguments the redactor dropped. Nothing downstream can
 *  reproduce it: `am replay` would re-dispatch the literal string
 *  `"[redacted]"` at a running app, and `am record` would emit
 *  `await vault.unlockWith();` — a "runnable replay test" that cannot run. */
export function isRedactedRow(
  r: { payload?: unknown; redacted?: true },
): boolean {
  return r.redacted === true || r.payload === REDACTED;
}

/** An argument as a JS literal. `JSON.stringify` cannot spell every value a
 *  server-side call recorded in the in-memory timeline: `undefined` came back
 *  as nothing, so `m(1, undefined, 2)` was emitted as `m(1, , 2)` — a syntax
 *  error — and `m(undefined)` as `m()`; a BigInt threw and took the whole
 *  generator down. JSON's own compact spelling for everything JSON can say,
 *  so an ordinary argument prints exactly as it always did. */
function literal(v: unknown): string {
  if (v === undefined) return "undefined";
  if (typeof v === "bigint") return `${v}n`;
  if (typeof v === "number") {
    return Object.is(v, -0) ? "-0" : Number.isFinite(v)
      ? JSON.stringify(v)
      // NaN, Infinity, -Infinity — `String` names each one as JS spells it.
      : String(v);
  }
  if (Array.isArray(v)) return `[${Array.from(v, literal).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const proto = Object.getPrototypeOf(v);
    if (proto === Object.prototype || proto === null) {
      return `{${
        Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}:${literal(x)}`)
          .join(",")
      }}`;
    }
  }
  // A Date, a Map, a function: what the wire would have made of it.
  return JSON.stringify(v) ?? "undefined";
}

/** Generate a bootCells replay test from recorded actions — pure + unit-tested.
 *  `cell:method` with `{ args }` becomes `await cell.method(...args)`; framework
 *  `__` methods are skipped. Imports are best-effort (`../src/<cell>.ts`) for the
 *  author to adjust; a TODO marks where to assert final state. */
export function generateReplayTest(
  actions: Action[],
  opts: {
    name?: string;
    cellDir?: string;
    /** Where the actions came from, said in the header — a replay of a live
     *  timeline and of a crash journal are different claims. */
    source?: string;
  } = {},
): string {
  const cells = new Set<string>();
  const calls: string[] = [];
  let redactedCount = 0;
  let callCount = 0;
  let caused = 0;
  let jumps = 0;
  let rejects = false;
  // A caused action is not called — its cause re-creates it — but a SCHEDULED
  // one only fires when the harness's virtual clock gets there, and bootCells'
  // clock moves only on `h.advance(ms)`. So when the flow has caused actions,
  // the clock is walked through the recorded gaps: before each call, and up to
  // each caused action. Without it the timer never fired and the test ended
  // short of the state the run reached.
  const paced = actions.some((a) => a.cause === "effect");
  let clock: number | undefined;
  const advanceTo = (ts: number | undefined, atLeast: number): void => {
    if (!paced || ts === undefined) return;
    if (clock === undefined) {
      clock = ts;
      if (atLeast === 0) return;
    }
    const ms = Math.max(atLeast, Math.round(ts - clock));
    clock = Math.max(clock, ts);
    if (ms > 0) calls.push(`  await h.advance(${ms});`);
  };
  // Calls whose runs OVERLAPPED are started together. Replayed one `await`
  // after another, two calls that both read `n` before either wrote it could
  // not lose the update the app really lost, and the test reached a state the
  // app never had. A call's recorded run ends at the last action naming it
  // (`call`: its write-sets, what its body dispatched); a later call recorded
  // before that point started while it was still running. A sync call is over
  // when it commits.
  const runEnd = new Map<string, number>();
  actions.forEach((a, i) => {
    if (a.call !== undefined) runEnd.set(a.call, i);
  });
  let group: { expr: string; threw: boolean }[] = [];
  let groupEnd = -1;
  const flush = (): void => {
    if (group.length === 1) {
      const { expr, threw } = group[0]!;
      // It rejected in the recorded run. A bare `await` of it fails the test
      // on the very line that reproduces the run faithfully; what it wrote
      // before it threw still commits either way.
      calls.push(
        threw
          ? `  await assertRejects(() => ${expr}); // threw in the recorded run`
          : `  await ${expr};`,
      );
    } else if (group.length > 1) {
      // Array elements are evaluated in order, so the calls START in the order
      // they were recorded, each before any of them has finished.
      calls.push(`  await Promise.all([`);
      for (const { expr, threw } of group) {
        calls.push(
          threw
            ? `    assertRejects(() => ${expr}), // threw in the recorded run`
            : `    ${expr},`,
        );
      }
      calls.push(`  ]);`);
    }
    group = [];
  };
  for (const [i, a] of actions.entries()) {
    if (a.type === TT_RESTORE_TYPE) {
      jumps++;
      continue;
    }
    const ci = a.type.indexOf(":");
    if (ci < 0) continue; // not a cell:method action
    const cell = a.type.slice(0, ci);
    const method = a.type.slice(ci + 1);
    if (method.startsWith("__")) continue; // framework-internal
    const open = group.length > 0 && i <= groupEnd;
    // The call that CAUSED it is in the flow, and re-running that call in the
    // test re-creates this one — emitting both applied it twice.
    if (a.cause === "effect") {
      caused++;
      // Inside a group the calls are all running: there is no line between
      // them to move the clock on.
      if (open) continue;
      flush();
      // At least 1ms: a `schedule.next` fires "after now", which a zero
      // advance does not reach.
      advanceTo(a.ts, 1);
      continue;
    }
    if (isRedactedRow(a)) {
      flush();
      advanceTo(a.ts, 0);
      // Its arguments were never written to disk, so this call CANNOT be
      // reproduced. Emitting `await vault.unlockWith();` produced a test that
      // compiles, runs, and reproduces something other than what happened —
      // the worst of the three options. A commented gap the author has to fill
      // is the honest one.
      redactedCount++;
      cells.add(cell);
      calls.push(
        `  // UNREPRODUCIBLE: ${a.type} was redacted (redactActions) — its ` +
          `arguments\n  // were never recorded. Supply them to continue the ` +
          `flow:\n  // await ${cell}.${method}(/* … */);`,
      );
      continue;
    }
    if (!open) {
      flush();
      advanceTo(a.ts, 0);
    }
    cells.add(cell);
    const payload = a.payload as { args?: unknown[]; _callId?: unknown };
    const args = payload?.args ?? [];
    if (a.threw) rejects = true;
    callCount++;
    group.push({
      expr: `${cell}.${method}(${args.map(literal).join(", ")})`,
      threw: a.threw === true,
    });
    const id = payload?._callId;
    groupEnd = Math.max(
      open ? groupEnd : i,
      typeof id === "string" ? runEnd.get(id) ?? i : i,
    );
  }
  flush();
  const dir = opts.cellDir ?? "../src";
  const cellList = [...cells];
  const imports = cellList.map((c) => `import { ${c} } from "${dir}/${c}.ts";`);
  const name = opts.name ?? "recorded flow";
  return [
    `// Generated by \`am record\` — replay of ${count(callCount, "action")}${
      opts.source ? `, from ${opts.source}` : ""
    }.`,
    `// Adjust the cell import paths and add assertions where marked.`,
    ...(redactedCount > 0
      ? [
        `//`,
        `// ⚠ ${
          count(redactedCount, "action")
        } in this flow were REDACTED and could not`,
        `// be generated — their arguments were never recorded. They appear`,
        `// below as commented gaps. This replay is INCOMPLETE until you fill`,
        `// them in.`,
      ]
      : []),
    ...(caused > 0
      ? [
        `//`,
        `// Not called: ${
          count(caused, "action")
        } caused by an earlier one (a timer it`,
        `// armed, its async body, a $do) or by boot (a cell's onInit) —`,
        `// what caused them re-creates them.`,
      ]
      : []),
    ...(jumps > 0
      ? [
        `//`,
        `// ⚠ the run TIME-TRAVELLED (${count(jumps, "jump")}) — calls after a`,
        `// jump ran on restored state, which this replay does not reproduce.`,
      ]
      : []),
    rejects
      ? `import { assertEquals, assertRejects } from "@std/assert";`
      : `import { assertEquals } from "@std/assert";`,
    `import { bootCells } from "aio/testing";`,
    ...imports,
    ``,
    `Deno.test(${JSON.stringify(name)}, async () => {`,
    // `using … = await`: bootCells returns a PROMISE of the handle. `await
    // using h = bootCells(…)` disposed the promise — a TS2851 in `deno check`
    // and "Symbol(Symbol.dispose) is not a function" when run, so every test
    // this verb wrote failed on its first line. tests/am-record-generated-runs
    // checks AND runs the output.
    `  using h = await bootCells([${cellList.join(", ")}]);`,
    ...calls,
    `  await h.settle();`,
    `  // TODO: assert final state, e.g. assertEquals(${
      cellList[0] ?? "cell"
    }.field, expected);`,
    `});`,
    ``,
  ].join("\n");
}

/** One parsed journal line — carries `seq`/`ts` so callers can range-filter. */
export type JournalRow = {
  seq: number;
  type: string;
  payload?: unknown;
  ts?: number;
};

/** What a journal parse recovered, and what it could not read. */
export type JournalParse = {
  rows: JournalRow[];
  /** 1-based line numbers that did not parse, in file order. */
  badLines: number[];
  /** True when the ONLY unreadable line is the last one with content — a
   *  process killed mid-write, which is ordinary and expected. Anything else
   *  is a tear inside the file, i.e. real corruption. */
  tornTailOnly: boolean;
};

/** Parse a journal file (JSONL: `{seq,type,payload,ts}` per line).
 *
 *  A bad line is SKIPPED and RECORDED; it does not end the parse. It used to
 *  `break` — correct for a torn tail, and applied at any position, so ONE bad
 *  line in the middle truncated everything after it. Measured on a four-row
 *  journal with row 2 truncated: `am timeline`, `am replay --dry` and
 *  `am record` each recovered one row, exited 0, and said nothing — and
 *  `am record` wrote a "replay test" from a quarter of the journal and
 *  called it a success. Silent data loss under a green exit code, which is
 *  the shape the project's own rule names first. Worse, the reach for
 *  `am replay` usually happens BECAUSE something crashed, i.e. exactly when a
 *  journal is likely torn. */
export function parseJournal(text: string): JournalParse {
  const rows: JournalRow[] = [];
  const badLines: number[] = [];
  const lines = text.split("\n");
  let lastContentLine = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    lastContentLine = i + 1;
    try {
      const e = JSON.parse(line) as JournalRow;
      if (typeof e.type === "string") rows.push(e);
      else badLines.push(i + 1);
    } catch {
      badLines.push(i + 1);
    }
  }
  rows.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return {
    rows,
    badLines,
    tornTailOnly: badLines.length <= 1 &&
      (badLines.length === 0 || badLines[0] === lastContentLine),
  };
}

/** The one sentence every journal reader says about a damaged file, so three
 *  commands cannot describe the same damage three ways. `null` when the file
 *  was clean. */
export function journalDamage(p: JournalParse, path: string): string | null {
  if (p.badLines.length === 0) return null;
  const where = p.badLines.slice(0, 5).join(", ") +
    (p.badLines.length > 5 ? `, …` : "");
  return p.tornTailOnly
    ? `[am] ${path}: the last line is torn (line ${where}) — written while ` +
      `the app was stopping. ${p.rows.length} entries recovered.`
    : `[am] ${path}: ${p.badLines.length} unreadable line(s) INSIDE the ` +
      `journal (line ${where}), not just a torn tail — this file is damaged. ` +
      `${p.rows.length} entries were recovered and the rest are gone; ` +
      `anything generated from it is incomplete.`;
}

/** `am record [out.test.ts] [--from=<journal>]` — generate a replay test from
 *  the running app's live timeline, or from a journal (`--from`, or the app's
 *  `<data>/journal` when it is not running). Writes to the output path, or
 *  prints to stdout. */
export async function cmdRecord(
  args: string[],
  flags: GlobalFlags,
): Promise<void> {
  const mode = detectMode(flags);
  const outPath = args.find((a) => !a.startsWith("--"));
  // A generated test is written over the file at this path. `am backup`
  // refuses to clobber; this did it silently — and the file most likely to be
  // sitting at `tests/foo.test.ts` is the hand-written test it replaces.
  if (outPath) {
    const clobber = overwriteRefusal(
      outPath,
      !!flags.force,
      "a generated replay test",
    );
    if (clobber) {
      outError(clobber, mode);
      Deno.exit(1);
    }
  }
  const fromFlag = args.find((a) => a.startsWith("--from="));
  let actions: Action[];
  let source: string;
  // The source, with no `--from`, is the RUNNING app's timeline. It used to be
  // the journal, always — and the journal is the crash-recovery TAIL: every
  // persist compacts away what the snapshot now holds, so on a running
  // `journal: true` app it is empty nearly always, and `am record` answered
  // "no replayable actions" to exactly the person the help promised it to ("a
  // bug you reproduced becomes a test"). The timeline carries the same actions
  // (same seq, same payloads, same redaction rule; a `diagnostics: false` cell
  // is the one thing the timeline leaves out), kept since boot. When no
  // app answers, the journal is what a crashed run left behind. `--from` is an
  // explicit file and never consults the app.
  const live = fromFlag ? null : await liveTimeline(flags);
  if (live?.ok) {
    source = "the running app's timeline";
    // The ring keeps the last TIMELINE_RING dispatches. A full ring means the
    // flow's start may already be gone, and a replay missing its first steps
    // re-runs a sequence the app never ran — say so rather than imply it is
    // complete.
    if (live.entries.length >= TIMELINE_RING) {
      console.error(
        `[am] ⚠ the live timeline is full (${TIMELINE_RING} dispatches) — ` +
          `earlier actions have rotated out, so this replay may start ` +
          `mid-flow. Restart the app, reproduce, then record.`,
      );
    }
    actions = timelineActions(live.entries);
    if (actions.length === 0) {
      outError(
        `the running app has dispatched nothing since boot — reproduce the ` +
          `flow (in the UI, or am dispatch / am trigger), then am record`,
        mode,
      );
      Deno.exit(1);
    }
  } else {
    const journalPath = fromFlag
      ? fromFlag.slice("--from=".length)
      : defaultJournalPath(resolveAmAppId(flags.app));
    // Not running is ordinary (a crashed run is why the journal is read), but
    // WHICH source answered has to be visible: the two hold different things.
    const notLive = live && !live.ok
      ? ` (no running app answered: ${live.error})`
      : "";
    source = `the journal ${journalPath}`;
    let text: string;
    try {
      text = await Deno.readTextFile(journalPath);
    } catch {
      outError(
        `no journal at "${journalPath}"${notLive} — record from the running ` +
          `app (am start, reproduce, am record), enable the journal with ` +
          `aio.run({ journal: true }), or pass --from=<path>`,
        mode,
      );
      Deno.exit(1);
    }
    const parsed = parseJournal(text);
    // A generated replay test built from a QUARTER of a journal, reported as a
    // success, is the worst outcome this file can produce: it looks like a
    // recording of what happened and is not one.
    const damage = journalDamage(parsed, journalPath);
    if (damage) console.error(damage);
    if (damage && !parsed.tornTailOnly) {
      outError(
        `refusing to generate a test from a damaged journal — ` +
          `${parsed.badLines.length} unreadable line(s) inside "${journalPath}" ` +
          `mean the actions between the readable ones are gone, so the test ` +
          `would assert a sequence the app never ran. Inspect it with: ` +
          `am timeline --from=${journalPath}`,
        mode,
      );
      Deno.exit(1);
    }
    actions = parsed.rows.map((r) => ({
      type: r.type,
      payload: r.payload,
      ...(r.ts !== undefined ? { ts: r.ts } : {}),
      ...((r as { cause?: string }).cause
        ? { cause: (r as { cause?: string }).cause }
        : {}),
      ...((r as { call?: string }).call
        ? { call: (r as { call?: string }).call }
        : {}),
    }));
    if (actions.length === 0) {
      outError(
        `journal "${journalPath}" has no replayable actions${notLive} — it ` +
          `holds only what is NOT yet in a snapshot (every persist compacts ` +
          `the rest away). To record a flow, run the app, reproduce it, and ` +
          `am record while it is still running.`,
        mode,
      );
      Deno.exit(1);
    }
  }
  const test = generateReplayTest(actions, {
    name: outPath
      ? outPath.replace(/.*\//, "").replace(/\.test\.ts$/, "")
      : "recorded flow",
    source,
  });
  if (outPath) {
    await Deno.writeTextFile(outPath, test);
    out(
      mode === "pretty"
        ? `wrote ${outPath} (${actions.length} actions, from ${source})`
        : { wrote: outPath, actions: actions.length, source },
      mode,
    );
  } else {
    out(test, mode);
  }
}

/** The running app's whole timeline, or why there is none. */
async function liveTimeline(
  flags: GlobalFlags,
): Promise<
  { ok: true; entries: TimelineEntry[] } | { ok: false; error: string }
> {
  const ctx = amCtx(flags);
  const r = await trojanGet(ctx.port, "timeline", ctx.appId);
  if (!r.ok) return { ok: false, error: r.error };
  return {
    ok: true,
    entries: (r.data as { entries?: TimelineEntry[] })?.entries ?? [],
  };
}

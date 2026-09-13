// report.ts — capturing what someone would otherwise have to describe.
//
// A bug report is only useful if it answers the questions the maintainer is
// going to ask anyway: which build, on what, doing what, and what had just
// happened. An app author cannot assemble that by hand — but aio already holds
// every piece of it (boot facts, cell state, the dispatch timeline, the
// diagnostic bus, the logs), so the only work left is collecting it safely.
//
// Three rules shape everything here:
//
//   1. REDACTION IS NOT OPTIONAL. A report carries state, and the app already
//      declared which state must be retained nowhere. It honours the SAME
//      redactor as the journal, the timeline and the checkpoint, or it becomes
//      the leak that list exists to prevent.
//   2. EVERYTHING IS CAPPED, and truncation is stated. A report nobody can
//      attach to an issue helps nobody.
//   3. OBSERVE-ONLY. Capturing a problem must never cause one.
import { join } from "@std/path";
import { _redactCheckpointState } from "../diagnostics/checkpoint.ts";
import { diagRecent } from "../diagnostics/diagnostic-bus.ts";
import { noRedaction, REDACTED, type Redactor } from "../diagnostics/redact.ts";
import type { CellFieldFlags } from "./aio-types.ts";
import type { TimelineEntry } from "./timeline.ts";
import { type BuildFacts, buildFacts } from "./boot-facts.ts";

/** Why a report exists. `crash` and `error` are captured without being asked;
 *  `user` is somebody pressing a button. */
export type ReportKind = "user" | "crash" | "error";

/** The bundle. Plain JSON on purpose: an issue tracker, a maintainer, a script
 *  and a coding agent all read it the same way, with no aio installed. */
export type Report = {
  /** Sortable and unique — timestamp plus a short random suffix. */
  id: string;
  createdAt: string;
  kind: ReportKind;
  /** One line. For a crash, the error; for a user, what they typed. */
  title: string;
  /** What the user described, when a user was involved. */
  body?: string;
  /** How to reach them, if they offered it. Never collected automatically. */
  contact?: string;
  /** Exactly what is running — the first thing anybody asks. */
  app: {
    id: string;
    version: string;
    aio: string;
    build: BuildFacts["build"];
    target: BuildFacts["target"];
    artifact: string;
    platform: string;
    runtime: string;
    /** Release channel and the commit it was built from, when known. */
    channel?: string;
    commit?: string;
  };
  /** How it was configured — the second thing anybody asks. */
  environment: {
    dataDir: string;
    exposed: boolean;
    persist: boolean;
    cells: string[];
  };
  /** Current state, with redacted cells withheld whole. */
  state?: Record<string, unknown>;
  /** Cells deliberately absent from `state`. Named, so their absence reads as
   *  a decision rather than as "this app has no such data". */
  redactedCells?: string[];
  /** What had just happened, newest last. */
  timeline?: TimelineEntry[];
  /** Recent warnings and errors off the diagnostic bus. */
  diagnostics?: {
    ts: number;
    type: string;
    severity: string;
    message: string;
  }[];
  /** Tail of the app log. */
  logs?: string[];
  /** What was dropped to keep this attachable, and why. */
  truncated?: string[];
};

/** Caps. Generous enough to diagnose, small enough to attach to an issue.
 *  A report that has to be zipped is a report that does not get sent. */
export const REPORT_LIMITS = {
  timelineEntries: 100,
  diagnostics: 50,
  logLines: 200,
  /** Characters of the free-text `body` kept. `title` has been capped since
   *  day one; `body` was not, so `feedback.report()` — anonymous and
   *  uncapped on an exposed app — accepted an arbitrarily large string,
   *  wrote it to disk and POSTed it. A cap is not censorship: a report body
   *  longer than this is not a description, it is a payload. */
  bodyChars: 20_000,
  /** Characters of `contact`. An address, not an essay. */
  contactChars: 200,
  /** Bytes of serialized state before it is dropped rather than truncated —
   *  half a state tree is misleading in a way that no state is not. */
  stateBytes: 256 * 1024,
  /** Bytes one timeline entry may carry. Past it, the entry keeps what it did
   *  and which paths it touched, and its values are elided: a diff leaf is a
   *  state value, and a 400 KB string written by one action is the same 400 KB
   *  the state cap just refused. */
  timelineEntryBytes: 16 * 1024,
  /** Bytes of the whole timeline section. The oldest entries go first — a
   *  maintainer reads toward the failure. */
  timelineBytes: 256 * 1024,
} as const;

/** Everything a report is built FROM: the app's data dir, its identity and
 *  version, the diagnostics to attach, and the redactor applied before any of
 *  it is written or sent. */
export type ReportSources = {
  appId: string;
  appVersion: string;
  aioVersion: string;
  dataDir: string;
  logsDir: string;
  exposed: boolean;
  persist: boolean;
  cells: string[];
  channel?: string;
  commit?: string;
  /** Current state, unredacted — this function redacts it. */
  getState?: () => Record<string, unknown>;
  getTimeline?: () => TimelineEntry[];
  /** The app's redaction rule. Defaults to redacting nothing, which is only
   *  correct for an app that declared nothing. */
  redact?: Redactor;
  /** Cell id → state key → the flags composition derived from the cell's own
   *  `visible` declaration (the same map the trojan `fields` route serves).
   *
   *  A report carries state, and the app already said which fields must never
   *  leave the server — so that declaration is the report's default redactor,
   *  not an unrelated setting the author has to remember to repeat under
   *  `redactActions`. Without it a `visible: "none"` field was serialized to
   *  disk and POSTed in full, which is the one thing declaring it prevents.
   *
   *  Absent ⇒ nothing is screened, and a report carrying state SAYS SO in
   *  `truncated` rather than looking as if it had been. */
  visible?: CellFieldFlags;
};

/** Project raw state through each cell's declared `visible` flags. A field the
 *  app hides from clients is not in the report either; a cell that hides every
 *  field is withheld whole and named. Cells with no entry (nothing declared)
 *  pass through — that IS the declaration. */
function _applyDeclaredVisibility(
  raw: Record<string, unknown>,
  visible: CellFieldFlags | undefined,
  truncated: string[],
): Record<string, unknown> {
  if (!visible || Object.keys(visible).length === 0) {
    truncated.push(
      "state was NOT screened by cell `visible` declarations — this report " +
        "carries every field, including any the app hides from clients",
    );
    return raw;
  }
  const out: Record<string, unknown> = {};
  const withheld: string[] = [];
  const dropped: string[] = [];
  for (const [cell, slice] of Object.entries(raw)) {
    const flags = visible[cell];
    if (!flags || slice === null || typeof slice !== "object") {
      out[cell] = slice;
      continue;
    }
    const kept: Record<string, unknown> = {};
    let any = false;
    for (
      const [key, value] of Object.entries(slice as Record<string, unknown>)
    ) {
      const flag = flags[key];
      if (flag && flag.ui === false) {
        dropped.push(`${cell}.${key}`);
        continue;
      }
      kept[key] = value;
      any = true;
    }
    if (!any && Object.keys(slice as object).length > 0) withheld.push(cell);
    else out[cell] = kept;
  }
  if (withheld.length) {
    truncated.push(
      `cells withheld whole — every field is hidden from clients: ${
        withheld.join(", ")
      }`,
    );
  }
  if (dropped.length) {
    truncated.push(
      `fields hidden from clients were omitted: ${dropped.join(", ")}`,
    );
  }
  return out;
}

/** Screen one timeline entry through the same `visible` flags as the state.
 *
 *  The timeline is state too — every diff leaf is a before/after VALUE, keyed
 *  by the path it lives at — and it went out unscreened: a report whose notes
 *  said "fields hidden from clients were omitted: w.secret" carried
 *  `{ path: "w.secret", before: "", after: "TOPSECRET" }` a few lines further
 *  down, and the call's own arguments beside it. A leaf under a hidden field
 *  keeps its path (the action DID touch it — that is diagnostic) and loses its
 *  values; a leaf that IS a whole cell loses the hidden keys inside it.
 *
 *  An action that wrote a hidden field very likely carried the value in its
 *  arguments (`setSecret(value)`), so its payload is withheld too. A truncated
 *  diff cannot say what it did not list, so while any field is hidden a
 *  truncated entry's payload is withheld as well — the safe direction. An
 *  ASYNC call's writes are not on its own entry at all; see
 *  {@link _withholdAsyncCallPayloads}. */
function _screenTimelineEntry(
  e: TimelineEntry,
  visible: CellFieldFlags,
  anyHidden: boolean,
): {
  entry: TimelineEntry;
  leaves: number;
  payload: boolean;
  /** The entry wrote (or may have written) a hidden field. */
  touched: boolean;
} {
  const hidden = (cell: string, key: string): boolean =>
    visible[cell]?.[key]?.ui === false;
  const project = (cell: string, v: unknown): unknown => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const flags = visible[cell];
    if (!flags) return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (flags[k]?.ui !== false) out[k] = x;
    }
    return out;
  };
  let leaves = 0;
  let touched = false;
  const diff = e.diff.map((d) => {
    if (d.path === "…") {
      if (anyHidden) touched = true;
      return d;
    }
    const segs = d.segments ?? (d.path === "" ? [] : d.path.split("."));
    if (segs.length === 0) {
      // The whole state replaced at once — project every cell in it.
      const whole = (v: unknown) =>
        v !== null && typeof v === "object" && !Array.isArray(v)
          ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>).map((
              [c, x],
            ) => [c, project(c, x)]),
          )
          : v;
      if (!anyHidden) return d;
      touched = true;
      leaves++;
      return { ...d, before: whole(d.before), after: whole(d.after) };
    }
    const cell = segs[0]!;
    if (segs.length === 1) {
      const before = project(cell, d.before);
      const after = project(cell, d.after);
      if (before === d.before && after === d.after) return d;
      touched = true;
      leaves++;
      return { ...d, before, after };
    }
    if (!hidden(cell, segs[1]!)) return d;
    touched = true;
    leaves++;
    return { ...d, before: REDACTED, after: REDACTED };
  });
  if (!touched) return { entry: e, leaves: 0, payload: false, touched };
  const dropPayload = e.payload !== undefined && e.payload !== REDACTED;
  return {
    entry: { ...e, diff, ...(dropPayload ? { payload: REDACTED } : {}) },
    leaves,
    payload: dropPayload,
    touched,
  };
}

/** The `_callId` an async method's CALL entry carries, if any. */
function _callIdOf(e: TimelineEntry): string | undefined {
  const p = e.payload;
  if (p === null || typeof p !== "object") return undefined;
  const id = (p as { _callId?: unknown })._callId;
  return typeof id === "string" ? id : undefined;
}

/** Withhold the arguments of async calls that wrote — or may yet write — a
 *  hidden field.
 *
 *  `_screenTimelineEntry` judges an entry by its own diff, which is a SYNC
 *  method's whole write set. An async method commits its writes later, as
 *  `cell:__setFoo` entries naming the call (`call: <_callId>`), so the call
 *  entry itself has `diff: []` and kept its arguments: a report that withheld
 *  `w.token` everywhere else carried
 *  `{"type":"w:setToken","payload":{"args":["TOPSECRET-XYZ"]},"diff":[]}`.
 *
 *  So the write set is gathered by `_callId`: any entry of the call's run that
 *  touched a hidden field withholds the call's payload, whichever cell the
 *  call belongs to. That is not enough on its own — a call still running when
 *  the report is taken has not written the field YET, and the timeline records
 *  no "this call is over" — so on a cell that declares a hidden field, the
 *  payload of every entry whose writes cannot be seen whole is withheld: an
 *  async call, and any entry with no diff to vouch for it. What stays is the
 *  type, the diff and the `call` link, which say what happened. */
function _withholdAsyncCallPayloads(
  entries: TimelineEntry[],
  touchedCalls: ReadonlySet<string>,
  visible: CellFieldFlags,
): { entries: TimelineEntry[]; payloads: number } {
  const hiddenCell = (type: string): boolean => {
    const at = type.indexOf(":");
    const flags = at > 0 ? visible[type.slice(0, at)] : undefined;
    return !!flags && Object.values(flags).some((f) => f.ui === false);
  };
  let payloads = 0;
  const out = entries.map((e) => {
    if (e.payload === undefined || e.payload === REDACTED) return e;
    const id = _callIdOf(e);
    const withhold = (id !== undefined && touchedCalls.has(id)) ||
      (hiddenCell(e.type) && (id !== undefined || e.diff.length === 0));
    if (!withhold) return e;
    payloads++;
    return { ...e, payload: REDACTED };
  });
  return { entries: out, payloads };
}

/** One entry within `timelineEntryBytes`: what happened and where stays, the
 *  values go. `null` when even that does not fit. */
function _capTimelineEntry(e: TimelineEntry): TimelineEntry | null {
  const size = safeSize(e);
  if (size <= REPORT_LIMITS.timelineEntryBytes) return e;
  const note = `(elided — this entry was ${Math.round(size / 1024)}KB)`;
  const slim: TimelineEntry = {
    ...e,
    ...(e.payload !== undefined ? { payload: note } : {}),
    diff: e.diff.map((d) =>
      d.path === "…" ? d : { ...d, before: note, after: note }
    ),
  };
  return safeSize(slim) <= REPORT_LIMITS.timelineEntryBytes ? slim : null;
}

function safeSize(v: unknown): number {
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return Infinity; // unserializable ⇒ treat as too big to carry
  }
}

/** Read the last N lines of the app log, if there is one. */
async function tailLog(logsDir: string, lines: number): Promise<string[]> {
  try {
    const text = await Deno.readTextFile(join(logsDir, "app.log"));
    const all = text.split("\n").filter(Boolean);
    return all.slice(-lines);
  } catch {
    return [];
  }
}

/** Assemble a report. Never throws: every source is optional and every failure
 *  degrades to an absent section, because the alternative is losing the report
 *  about the thing that was already going wrong. */
export async function buildReport(
  input: {
    kind: ReportKind;
    title: string;
    body?: string;
    contact?: string;
    /** Deterministic id, for tests. */
    id?: string;
    now?: Date;
  },
  src: ReportSources,
): Promise<Report> {
  const now = input.now ?? new Date();
  const id = input.id ??
    `${now.toISOString().replace(/[:.]/g, "-")}-${
      Math.random().toString(36).slice(2, 8)
    }`;
  const facts = buildFacts();
  const redact = src.redact ?? noRedaction;
  const truncated: string[] = [];

  const report: Report = {
    id,
    createdAt: now.toISOString(),
    kind: input.kind,
    title: input.title.slice(0, 300),
    app: {
      id: src.appId,
      version: src.appVersion,
      aio: src.aioVersion,
      build: facts.build,
      target: facts.target,
      artifact: facts.artifact,
      platform: facts.platform,
      runtime: facts.runtime,
    },
    environment: {
      dataDir: src.dataDir,
      exposed: src.exposed,
      persist: src.persist,
      cells: src.cells,
    },
  };
  if (input.body) {
    report.body = input.body.slice(0, REPORT_LIMITS.bodyChars);
    if (input.body.length > REPORT_LIMITS.bodyChars) {
      truncated.push(
        `body truncated to ${REPORT_LIMITS.bodyChars} of ${input.body.length} chars`,
      );
    }
  }
  if (input.contact) {
    report.contact = input.contact.slice(0, REPORT_LIMITS.contactChars);
  }
  if (src.channel) report.app.channel = src.channel;
  if (src.commit) report.app.commit = src.commit;

  // ── state ──
  try {
    const raw = src.getState?.();
    if (raw) {
      // The app's own `visible` declaration runs FIRST — it is the strongest
      // statement anyone made about this data, and `redactActions` (built for
      // action payloads) knows nothing about it. A cell with `visible: "none"`
      // contributes nothing; `include`/`exclude` are applied field by field,
      // exactly as they are for a browser.
      const screened = _applyDeclaredVisibility(raw, src.visible, truncated);
      const safe = _redactCheckpointState(screened, redact);
      if (redact.redactsAnyCell()) {
        const withheld = src.cells.filter((c) => redact.redactsCell(c));
        if (withheld.length) report.redactedCells = withheld;
      }
      const size = safeSize(safe);
      if (size > REPORT_LIMITS.stateBytes) {
        truncated.push(
          `state omitted (${Math.round(size / 1024)}KB > ${
            REPORT_LIMITS.stateBytes / 1024
          }KB) — half a state tree misleads in a way none does not`,
        );
      } else report.state = safe;
    }
  } catch (e) {
    truncated.push(`state could not be captured: ${e}`);
  }

  // ── timeline ──
  try {
    const all = src.getTimeline?.() ?? [];
    if (all.length > REPORT_LIMITS.timelineEntries) {
      truncated.push(
        `timeline trimmed to the newest ${REPORT_LIMITS.timelineEntries} of ${all.length}`,
      );
    }
    // Newest last: a maintainer reads toward the failure, not away from it.
    let kept = all.slice(-REPORT_LIMITS.timelineEntries);
    // The same `visible` declaration the state went through — see
    // `_screenTimelineEntry`. Absent ⇒ the state note above already says
    // nothing was screened.
    const visible = src.visible;
    if (visible && Object.keys(visible).length > 0 && kept.length) {
      const anyHidden = Object.values(visible).some((f) =>
        Object.values(f).some((x) => x.ui === false)
      );
      let leaves = 0, payloads = 0;
      const touchedCalls = new Set<string>();
      kept = kept.map((e) => {
        const r = _screenTimelineEntry(e, visible, anyHidden);
        leaves += r.leaves;
        if (r.payload) payloads++;
        if (r.touched) {
          if (e.call !== undefined) touchedCalls.add(e.call);
          const own = _callIdOf(e);
          if (own !== undefined) touchedCalls.add(own);
        }
        return r.entry;
      });
      if (anyHidden) {
        const r = _withholdAsyncCallPayloads(kept, touchedCalls, visible);
        kept = r.entries;
        payloads += r.payloads;
      }
      if (leaves || payloads) {
        truncated.push(
          `timeline: values of fields hidden from clients were withheld ` +
            `(${leaves} diff value${leaves === 1 ? "" : "s"}, ${payloads} ` +
            `action payload${
              payloads === 1 ? "" : "s"
            } of actions that wrote ` +
            `them or may have — an async call's writes land after it)`,
        );
      }
    }
    // Byte caps — the state cap meant nothing while the same values could
    // ride in through the diffs (a 391 KB state was "omitted" from a 406 KB
    // report).
    let elided = 0, dropped = 0;
    kept = kept.flatMap((e) => {
      const c = _capTimelineEntry(e);
      if (c !== e) c ? elided++ : dropped++;
      return c ? [c] : [];
    });
    let bytes = safeSize(kept);
    let oldest = 0;
    while (kept.length && bytes > REPORT_LIMITS.timelineBytes) {
      bytes -= safeSize(kept.shift()) + 1;
      oldest++;
    }
    if (elided || dropped) {
      truncated.push(
        `timeline: ${elided} entr${elided === 1 ? "y" : "ies"} over ${
          REPORT_LIMITS.timelineEntryBytes / 1024
        }KB had their values elided` +
          (dropped ? `, ${dropped} still too large were dropped` : ""),
      );
    }
    if (oldest) {
      truncated.push(
        `timeline: the oldest ${oldest} entr${
          oldest === 1 ? "y was" : "ies were"
        } dropped to stay within ${REPORT_LIMITS.timelineBytes / 1024}KB`,
      );
    }
    if (kept.length) report.timeline = kept;
  } catch (e) {
    truncated.push(`timeline could not be captured: ${e}`);
  }

  // ── diagnostics ──
  try {
    const recent = diagRecent().slice(-REPORT_LIMITS.diagnostics);
    if (recent.length) {
      report.diagnostics = recent.map((d) => ({
        ts: d.ts,
        type: d.type,
        severity: String(d.severity ?? "info"),
        message: String(d.message ?? ""),
      }));
    }
  } catch { /* the bus is optional */ }

  // ── logs ──
  try {
    const lines = await tailLog(src.logsDir, REPORT_LIMITS.logLines);
    if (lines.length) report.logs = lines;
  } catch { /* absent is fine */ }

  if (truncated.length) report.truncated = truncated;
  return report;
}

/** Where reports live: inside the app's data directory, so they travel with a
 *  backup and are deleted with the app. */
export function reportsDir(dataDir: string): string {
  return join(dataDir, "reports");
}

/** Write a report and return its path. */
export async function writeReport(
  dataDir: string,
  report: Report,
): Promise<string> {
  const dir = reportsDir(dataDir);
  await Deno.mkdir(dir, { recursive: true });
  const path = join(dir, `${report.id}.json`);
  await Deno.writeTextFile(path, JSON.stringify(report, null, 2) + "\n");
  return path;
}

/** Every report on disk, newest first. */
export async function listReports(dataDir: string): Promise<Report[]> {
  const out: Report[] = [];
  try {
    for await (const e of Deno.readDir(reportsDir(dataDir))) {
      if (!e.isFile || !e.name.endsWith(".json")) continue;
      try {
        out.push(
          JSON.parse(
            await Deno.readTextFile(join(reportsDir(dataDir), e.name)),
          ) as Report,
        );
      } catch { /* a half-written file is not a reason to lose the rest */ }
    }
  } catch { /* no reports yet */ }
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** A short human summary — what `am report list` prints, and what an app can
 *  show next to "we saved a report". */
export function summarize(r: Report): string {
  const bits = [
    r.createdAt.slice(0, 19).replace("T", " "),
    r.kind.toUpperCase().padEnd(5),
    `${r.app.id} ${r.app.version}`,
    r.title,
  ];
  return bits.join("  ");
}

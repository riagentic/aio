// src/diagnostics/checkpoint.ts — Atomic state checkpoint + recovery

import type { CheckpointData } from "./types.ts";
import { log } from "./logger-api.ts";
import { noRedaction, REDACTED } from "./redact.ts";
import type { Redactor } from "./redact.ts";

const FILE = "checkpoint.json";
const TMP = "checkpoint.json.tmp";

/** Owner-only. The checkpoint holds FULL application state — every value the
 *  journal and the action log are careful not to keep. It was written at the
 *  process umask (0644/0664), so the one artifact carrying the most was also
 *  the most readable. */
const MODE: Deno.WriteFileOptions = { mode: 0o600 };

/** Withhold the slices of cells that `redactActions` covers.
 *
 *  `docs/persistence/where-files-live.md` promises a redacted action's payload
 *  "and the before/after values it wrote" are kept nowhere. The checkpoint has
 *  no action attached — it is current state — so it cannot redact per action,
 *  and the values a redacted action wrote are sitting in its cell's slice. A
 *  sweep with `redactActions: ["vault:*"]` found the journal clean, the action
 *  log clean, and the passphrase in `logs/checkpoint.json`. The timeline
 *  already redacts diff VALUES for exactly this reason — "redacting the payload
 *  alone would have been theatre". So does this: the whole slice is withheld,
 *  and its absence is stated rather than implied. */
export function _redactCheckpointState(
  state: Record<string, unknown>,
  redact: Redactor,
): Record<string, unknown> {
  if (redact.cells.size === 0) return state;
  let touched = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(state)) {
    if (redact.cells.has(k)) {
      out[k] = REDACTED;
      touched = true;
    } else out[k] = v;
  }
  return touched ? out : state;
}

let _warnedDegraded = false;

/** TOTAL JSON.stringify: circular references (AIO-152), BigInt, and anything
 *  else state may legally hold that JSON cannot represent (a throwing getter,
 *  a hostile `toJSON`).
 *
 *  The old fallback replacer re-threw on a BigInt — the same throw the first
 *  attempt failed with — and could not intercept a getter that throws during
 *  property access at all. A snapshot writer is OBSERVE-ONLY: it may lose
 *  detail, never a caller. `flush()` is awaited on the shutdown path, so a
 *  throw here failed the shutdown that was trying to record the crash. */
function _safeStringify(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch { /* fall through to the lossy encoder */ }
  try {
    const seen = new WeakSet();
    return JSON.stringify(data, (_key, value) => {
      if (typeof value === "bigint") return `${value}n`;
      if (typeof value === "object" && value !== null) {
        if (seen.has(value)) return "[Circular]";
        seen.add(value);
      }
      return value;
    });
  } catch (e) {
    // Last resort: keep the envelope (a checkpoint that can't be read back is
    // worse than one without its state) and say why the state is missing.
    if (!_warnedDegraded) {
      _warnedDegraded = true;
      log.warn(
        "checkpoint",
        `state could not be serialized — the snapshot keeps its envelope but ` +
          `NOT the state (reported once). Cause: ${
            e instanceof Error ? e.message : String(e)
          }`,
      );
    }
    const d = (data ?? {}) as Partial<CheckpointData>;
    try {
      return JSON.stringify({
        ts: typeof d.ts === "number" ? d.ts : Date.now(),
        state: { _unserializable: e instanceof Error ? e.message : String(e) },
        recentActions: Array.isArray(d.recentActions)
          ? [...d.recentActions]
          : [],
        cells: {},
      });
    } catch {
      return `{"ts":${Date.now()},"state":{},"recentActions":[],"cells":{}}`;
    }
  }
}

/** Read checkpoint from dir. Returns null if missing, corrupt, or unreadable. */
export function readCheckpoint(dir: string): CheckpointData | null {
  try {
    const text = Deno.readTextFileSync(`${dir}/${FILE}`);
    const data = JSON.parse(text) as CheckpointData;
    if (
      !data || typeof data.ts !== "number" || !data.state ||
      !Array.isArray(data.recentActions) || !data.cells
    ) return null;
    return data;
  } catch {
    return null;
  }
}

/** Create a checkpoint writer. Debounce=0 means immediate write.
 *  `redact` is the SAME predicate the journal, timeline and action log use. */
export function createCheckpoint(
  dir: string,
  debounceMs: number,
  redact: Redactor = noRedaction,
) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: CheckpointData | null = null;
  // `logger-core.ts` mkdirs the log dir, and the checkpoint shares that path
  // but only ever USED it — so with checkpoints on and the directory not yet
  // created, every write failed NotFound and logged one error, forever: the
  // framework reporting its own failure on a loop instead of doing the one
  // idempotent syscall that fixes it. Done once, lazily, so the steady state
  // is still a plain write.
  let dirReady = false;
  // …and if a write fails for a reason mkdir cannot fix (a read-only mount, a
  // full disk), the SAME message must not repeat on every debounce tick.
  let lastError = "";

  // ONE tmp file, so two overlapping writes raced: both wrote it, the first
  // rename consumed it, the second failed with NotFound — and that rejection
  // surfaced through `flush()`, i.e. on the shutdown path. Writes are
  // serialized instead of racing.
  let chain: Promise<void> = Promise.resolve();
  function enqueue(fn: () => Promise<void>): Promise<void> {
    chain = chain.then(fn, fn);
    return chain;
  }

  const scrub = (data: CheckpointData): CheckpointData =>
    redact.cells.size === 0
      ? data
      : { ...data, state: _redactCheckpointState(data.state, redact) };

  /** One line per DISTINCT failure. The same error every debounce tick is not
   *  more information, it is a log nobody can read. */
  function reportWriteError(e: unknown): void {
    const msg = `${e}`;
    if (msg === lastError) return;
    lastError = msg;
    // The crash path calls this, so it must not become the reason a crash
    // handler dies: a torn-down sink swallows the report, never the process.
    try {
      log.error(`[checkpoint] write failed: ${msg}`);
    } catch {
      // aio-ok: reporting a failed write must never outrank the crash we are
      // in the middle of handling.
    }
  }

  function write(data: CheckpointData): Promise<void> {
    return enqueue(async () => {
      const tmp = `${dir}/${TMP}`;
      const target = `${dir}/${FILE}`;
      const json = _safeStringify(scrub(data));
      if (!dirReady) {
        await Deno.mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {});
        dirReady = true;
      }
      // `mode` only applies at CREATE time, so a leftover tmp from an earlier
      // crash — or an existing checkpoint written by an older, laxer build —
      // would keep its old permissions through the rename. Remove both first.
      await Deno.remove(tmp).catch(() => {});
      try {
        await Deno.writeTextFile(tmp, json, MODE);
      } catch (e) {
        // The directory can go away UNDER a live writer — log rotation runs in
        // it, another app booting into the same data dir archives it, an
        // operator clears logs. Latching `dirReady` after the first success
        // would then fail every write for the rest of the process's life. A
        // NotFound is the one error re-running mkdir can fix, so it is the one
        // error worth a single retry; anything else propagates unchanged.
        if (!(e instanceof Deno.errors.NotFound)) throw e;
        await Deno.mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {});
        await Deno.writeTextFile(tmp, json, MODE);
      }
      await Deno.rename(tmp, target);
    });
  }

  /** Synchronous emergency write — for crash handler.
   *
   *  Best-effort, but never SILENT. This is the one artifact that exists to
   *  explain a crash: when it cannot be written, "no checkpoint on disk" must
   *  not be the only evidence, or the reader is left guessing whether the
   *  process died before the handler ran or the handler itself failed. It
   *  carries the same NotFound retry as `write()` — the directory can be
   *  archived or cleared under a live process, and the emergency path must not
   *  be weaker than the routine one it stands in for. */
  function writeSync(data: CheckpointData): void {
    const path = `${dir}/${FILE}`;
    const json = _safeStringify(scrub(data));
    const attempt = (): void => {
      if (!dirReady) {
        try {
          Deno.mkdirSync(dir, { recursive: true, mode: 0o700 });
        } catch {
          // aio-ok: already there, or unfixable — the write below decides,
          // and reports through reportWriteError either way.
        }
        dirReady = true;
      }
      try {
        Deno.removeSync(path);
      } catch {
        // aio-ok: nothing to clear. `mode` applies at CREATE time only, so
        // this is about permissions on a leftover file, not about the write.
      }
      Deno.writeTextFileSync(path, json, MODE);
    };
    try {
      attempt();
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) {
        try {
          Deno.mkdirSync(dir, { recursive: true, mode: 0o700 });
          Deno.writeTextFileSync(path, json, MODE);
          return;
        } catch (retry) {
          reportWriteError(retry);
          return;
        }
      }
      reportWriteError(e);
    }
  }

  /** Schedule a debounced write. */
  function schedule(data: CheckpointData): void {
    pending = data;
    if (debounceMs <= 0) {
      // Consumed, not left behind: `pending` outliving its own write made
      // `flush()` (the shutdown path) write the identical checkpoint a second
      // time. Idempotent, and still one avoidable disk write at the moment the
      // process is trying to leave.
      pending = null;
      write(data).catch(reportWriteError); // AIO-279: log instead of swallow
      return;
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (pending) {
        write(pending).catch(reportWriteError); // AIO-279
      }
      timer = null;
    }, debounceMs);
    // A DEBOUNCE MUST NEVER BE WHY A PROCESS IS STILL RUNNING.
    //
    // `flush()` clears this on the shutdown path, but an `observe()` after
    // that — a last dispatch, a teardown hook — re-arms it, and a pending
    // timer holds the event loop. Measured on a clean embedded boot:
    // `app.close()` returned in 53 ms and the process did not unload until
    // 5,054 ms, every time, for every `libraryMode` app. The checkpoint is
    // best-effort diagnostics; the shutdown flush is what guarantees it is
    // written. Unref'd, it still fires while the app is alive and stops being
    // a reason for the app to stay that way.
    // Found by the persistence audit round.
    try {
      (Deno as { unrefTimer?: (id: unknown) => void }).unrefTimer?.(timer);
    } catch {
      // aio-ok: a runtime without unrefTimer keeps the old behaviour — the
      // timer fires, which is correct, just less polite about exiting.
    }
  }

  /** Flush any pending write immediately.
   *  Awaited on the shutdown path: a snapshot that cannot be written is
   *  reported, never thrown — a diagnostic must not fail the shutdown it is
   *  trying to record. */
  async function flush(): Promise<void> {
    if (timer) clearTimeout(timer);
    timer = null;
    const data = pending;
    pending = null;
    try {
      if (data) await write(data);
      else await chain; // still let an in-flight debounce-0 write land
    } catch (e) {
      log.warn(
        "checkpoint",
        `final write failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  return { write, writeSync, schedule, flush };
}

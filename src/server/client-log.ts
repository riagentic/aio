// client-log.ts — Server-side receiver for client log messages.
// Appends forwarded browser/Electron console entries to log/client.log.
// Called from server.ts for incoming "log" frames (WS/IPC).

import type { ClientLogEntry } from "../air/dom-inspector-types.ts";
import { log } from "../diagnostics/logger-api.ts";
import { remapClientText } from "../diagnostics/stack-remap.ts";

const MAX_RATE = 100; // messages per second per client
const MAX_CLIENT_MSG = 8192; // max msg length from client

const LEVEL_PAD: Record<ClientLogEntry["level"], string> = {
  debug: "DEBUG",
  info: "INFO ",
  warn: "WARN ",
  error: "ERROR",
};

// Rate tracking: clientIndex → { count within current second, warned flag }
const _rate = new Map<number, { count: number; warned: boolean }>();

// Overwritten at every server boot (`initClientLog`). The literal survives only
// for a direct caller that never booted a server — kept cwd-relative rather
// than guessing a home directory, because a wrong absolute path is harder to
// notice than a visibly local one.
let _logDir = ".aio/log";
let _resetTimer: ReturnType<typeof setTimeout> | null = null;
let _writeErrors = 0;
/** Whether this process has already tightened the current `client.log`. One
 *  chmod per file per boot, not one per append. */
let _modeFixed = false;

// ── Public API ────────────────────────────────────────────────────────

/** Set the directory where client.log will be written. */
export function initClientLog(logDir: string): void {
  _logDir = logDir;
  _modeFixed = false; // a different file — tighten that one too
}

/** Append a client log entry. Fire-and-forget; safe to call from WS handler. */
export function writeClientLog(
  clientIndex: number,
  entry: ClientLogEntry,
): void {
  _ensureResetTimer();

  // Rate limiting per client
  let slot = _rate.get(clientIndex);
  if (!slot) {
    slot = { count: 0, warned: false };
    _rate.set(clientIndex, slot);
  }

  slot.count++;

  if (slot.count > MAX_RATE) {
    if (!slot.warned) {
      slot.warned = true;
      _append(
        `[${new Date().toISOString()}] [WARN ] [client:${clientIndex}] ` +
          `rate limit exceeded (>${MAX_RATE} msg/s) — messages dropped\n`,
      );
    }
    return;
  }

  // Validate untrusted client fields
  const rawTs = typeof entry.ts === "number" && Number.isFinite(entry.ts)
    ? entry.ts
    : Date.now();
  const ts = new Date(rawTs).toISOString();
  const lvl = LEVEL_PAD[entry.level] ?? "DEBUG";
  // Sanitize: clamp length, replace newlines to prevent log injection
  // REMAPPED BEFORE CLAMPING. The bundle is one minified line, so a forwarded
  // stack is a wall of `app.js:1:22073` — and a position that names nothing is
  // the difference between a report an agent can act on and a report it
  // re-derives by hand. Remapping after the newline-escape would have to parse
  // `\\n`-joined text; before it, each frame is still a frame. Identity when no
  // map is installed.
  const msg = remapClientText(
    typeof entry.msg === "string" ? entry.msg : String(entry.msg),
  )
    .slice(0, MAX_CLIENT_MSG)
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  // WHERE it was written, when the client could tell us. Untrusted like `msg`:
  // clamped, newline-stripped, and only rendered when it looks like a location.
  const rawSrc = typeof entry.source === "string"
    ? remapClientText(entry.source)
    : "";
  const src = rawSrc
    .slice(0, 200)
    .replace(/[\n\r]/g, " ")
    .trim();
  const where = src ? ` (${src})` : "";
  const line = `[${ts}] [${lvl}] [client:${clientIndex}] ${msg}${where}\n`;

  _append(line);
}

// Rotation/wipe on start is NOT done here. `client.log` is listed in
// `logger-rotate.ts`'s `KINDS`, so it obeys exactly the same on-start policy as
// app/debug/error/warning/perf: wiped by default, rotated to `.N` when
// `backupLogs` is on. This file used to carry its own complete
// `rotateClientLog()` — which nothing ever called, so the file grew forever.
// A second rotation living next to the writer is how that happens; one policy,
// in one place, is the fix.

/** Cleanup resources on shutdown — clears rate timer and tracking map. */
/** Test hook: how many per-client rate slots are live right now. A long-running
 *  server must not accumulate one per connection ever made. */
/** @internal Writes still in flight — the seam that lets a test prove the
 *  tracking exists rather than racing it. Without it, a `flushClientLog()`
 *  that tracked NOTHING would return instantly and the assertions after it
 *  would still pass, because the write usually lands first: a test that cannot
 *  fail. Same shape as `_rateSlotCount` below. */
export function _pendingWrites(): number {
  return _pending.size;
}

export function _rateSlotCount(): number {
  return _rate.size;
}

/** Wait for every in-flight client-log write (and the mode fix that rides
 *  with it). Shutdown awaits this; a test can too. */
export async function flushClientLog(): Promise<void> {
  while (_pending.size > 0) {
    await Promise.allSettled([..._pending]);
  }
}

export function disposeClientLog(): void {
  if (_resetTimer !== null) {
    clearTimeout(_resetTimer);
    _resetTimer = null;
  }
  _rate.clear();
  _modeFixed = false;
}

// ── Internals ─────────────────────────────────────────────────────────

/** Write chains in flight. `_append` is deliberately not awaited by its
 *  callers, so without this nothing could tell whether the last line reached
 *  the disk — not shutdown, and not a test. */
const _pending = new Set<Promise<unknown>>();

function _append(line: string): void {
  const path = `${_logDir}/client.log`;
  // 0600 + the chmod half, exactly as `logger-core.ts` documents it and
  // `action-log.ts` obeys it. This was the one log writer in the repo that
  // did neither, and it is the worst file to miss: `client.log` holds every
  // line a browser or Electron renderer forwarded — session state, request
  // URLs, whatever an app console-logs — plus the diagnostics relayed to it.
  // Measured with umask 022 it landed 0644, readable by every local account,
  // and on-start rotation re-created it 0644 on every boot, so the hole
  // re-opened itself after each restart.
  //
  // `mode` applies only when the file is CREATED, and a log outlives many
  // boots — so a file an older build left at 0644 needs the chmod too. Once
  // per file per boot; best-effort, because Windows and mode-less filesystems
  // have nothing to set and losing the renderer's voice over a chmod would be
  // the worse trade.
  // RETURNED, not fired and forgotten: the chmod is part of the write's chain,
  // so draining the chain drains it too. Detached, it outlived the write — the
  // op sanitizer caught it under load ("An async operation to change the
  // permissions of a file was started in this test, but never completed"), and
  // the same detachment means a process exiting between the write and the
  // chmod leaves the file at the mode this code exists to correct.
  const done = Deno.writeTextFile(path, line, { append: true, mode: 0o600 })
    .then(() => {
      _writeErrors = 0; // reset on success
      if (!_modeFixed) {
        _modeFixed = true;
        if (Deno.build.os !== "windows") {
          return Deno.chmod(path, 0o600).catch(() => {});
        }
      }
    }).catch((e) => {
      if (_writeErrors < 3) {
        _writeErrors++;
        log.error(`[client-log] write failed for ${path}: ${e}`);
      }
    });
  // Callers stay fire-and-forget (losing the renderer's voice to an await
  // would be the worse trade), but the work is now REACHABLE — see
  // `flushClientLog`, which shutdown awaits so the last lines a renderer sent
  // are on disk before the process goes.
  _pending.add(done);
  void done.finally(() => {
    _pending.delete(done);
  });
}

/** Start a 1-second rolling reset timer (only one active at a time). */
function _ensureResetTimer(): void {
  if (_resetTimer !== null) return;
  _resetTimer = setTimeout(() => {
    _resetTimer = null;
    // Clear, don't walk-and-reset: an absent slot is identical to a zeroed one,
    // and the map is keyed by a monotonic client index — every browser reload
    // adds one. Resetting in place kept every client that ever connected alive
    // for the process's lifetime AND made this timer's work grow with uptime.
    _rate.clear();
  }, 1000);
}

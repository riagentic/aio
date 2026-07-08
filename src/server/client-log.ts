// client-log.ts — Server-side receiver for client log messages.
// Appends forwarded browser/Electron console entries to log/client.log.
// Called from server.ts when a WS/IPC message has the __log: prefix.

import type { ClientLogEntry } from "../air/dom-inspector-types.ts";

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

let _logDir = ".aio/log";
let _resetTimer: ReturnType<typeof setTimeout> | null = null;
let _writeErrors = 0;

// ── Public API ────────────────────────────────────────────────────────

/** Set the directory where client.log will be written. */
export function initClientLog(logDir: string): void {
  _logDir = logDir;
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
  const msg = (typeof entry.msg === "string" ? entry.msg : String(entry.msg))
    .slice(0, MAX_CLIENT_MSG)
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
  const line = `[${ts}] [${lvl}] [client:${clientIndex}] ${msg}\n`;

  _append(line);
}

/**
 * Rotate client.log — shifts existing .1, .2 … backups and renames current
 * log to .1. Older backups beyond `keep` are deleted.
 * @param logDir  Directory containing client.log
 * @param keep    Number of backup files to retain (default 7, 0 = unlimited)
 */
export async function rotateClientLog(
  logDir: string,
  keep = 7,
): Promise<void> {
  const base = `${logDir}/client.log`;

  // Confirm the current log exists before rotating
  try {
    await Deno.stat(base);
  } catch {
    return; // nothing to rotate
  }

  // Find the highest existing backup index
  let n = 1;
  while (true) {
    try {
      await Deno.stat(`${base}.${n}`);
      n++;
    } catch {
      break;
    }
  }

  // Shift: rename .N-1 → .N, down to .1, then base → .1
  for (let i = n; i >= 2; i--) {
    try {
      await Deno.rename(`${base}.${i - 1}`, `${base}.${i}`);
    } catch { /* best-effort */ }
  }
  try {
    await Deno.rename(base, `${base}.1`);
  } catch { /* best-effort */ }

  // Prune old backups beyond keep limit
  if (keep > 0) {
    for (let i = keep + 1; i <= n + 1; i++) {
      try {
        await Deno.remove(`${base}.${i}`);
      } catch { /* already gone */ }
    }
  }
}

/** Cleanup resources on shutdown — clears rate timer and tracking map. */
export function disposeClientLog(): void {
  if (_resetTimer !== null) {
    clearTimeout(_resetTimer);
    _resetTimer = null;
  }
  _rate.clear();
}

// ── Internals ─────────────────────────────────────────────────────────

function _append(line: string): void {
  const path = `${_logDir}/client.log`;
  Deno.writeTextFile(path, line, { append: true }).then(() => {
    _writeErrors = 0; // reset on success
  }).catch((e) => {
    if (_writeErrors < 3) {
      _writeErrors++;
      console.error(`[client-log] write failed for ${path}: ${e}`);
    }
  });
}

/** Start a 1-second rolling reset timer (only one active at a time). */
function _ensureResetTimer(): void {
  if (_resetTimer !== null) return;
  _resetTimer = setTimeout(() => {
    _resetTimer = null;
    for (const slot of _rate.values()) {
      slot.count = 0;
      slot.warned = false;
    }
  }, 1000);
}

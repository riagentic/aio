/**
 * @module
 * `am shot --video --markers`: where `am trigger` and the recorder meet.
 *
 * They are two processes, so they meet on disk, beside the app's lock: the
 * recorder files `<lockDir>/<appId>.<appPid>.recording.json` naming a journal
 * (in its own temp dir); each `am trigger` aimed at that app appends one JSON
 * line `{at, path, action, rect}` (epoch ms, CSS px) to it. When recording
 * stops, the recorder turns the journal into `<video>.markers.json` — times
 * on the video's own clock, rects in VIDEO pixels — and removes the file.
 * No server change, nothing on the wire: a trigger with no recording running
 * does exactly what it did before. A registry whose recorder died is ignored
 * (its pid is checked) and replaced by the next recording.
 */

import { join } from "@std/path";
import { isProcessAlive, lockDir } from "../server/single-instance-lock.ts";

/** A rect: x, y, width, height. */
export type MarkerRect = { x: number; y: number; w: number; h: number };

/** One line of the journal — what `am trigger` knows, on its own clock. */
export type MarkerNote = {
  /** Epoch ms when the trigger was sent. */
  at: number;
  path: string;
  action: string;
  /** The element's rect in CSS px, measured before the action; absent for
   *  `window` (a key that belongs to no element). */
  rect?: MarkerRect;
};

/** One entry of `<video>.markers.json`. */
export type Marker = {
  /** Milliseconds into the video. */
  t: number;
  path: string;
  action: string;
  /** In video pixels; null when the target has no element (`window`). */
  rect: MarkerRect | null;
};

type Registry = { pid: number; journal: string };

/** Where the recorder of the app running as `appPid` announces itself. */
export function markerRegistryPath(appId: string, appPid: number): string {
  return join(lockDir(), `${appId}.${appPid}.recording.json`);
}

/** File the registry for a recording; the returned function removes it. */
export async function announceRecording(
  appId: string,
  appPid: number,
  journal: string,
): Promise<() => Promise<void>> {
  const path = markerRegistryPath(appId, appPid);
  const reg: Registry = { pid: Deno.pid, journal };
  await Deno.writeTextFile(path, JSON.stringify(reg), { mode: 0o600 });
  return () =>
    Deno.remove(path).catch((e) => {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    });
}

/** The journal a live recorder of this app reads, or null (none, or its
 *  recorder is gone). */
export function liveJournal(appId: string, appPid: number): string | null {
  let reg: Registry;
  try {
    reg = JSON.parse(Deno.readTextFileSync(markerRegistryPath(appId, appPid)));
  } catch {
    return null; // aio-ok: no recording is running — the common case
  }
  return typeof reg?.journal === "string" && isProcessAlive(reg.pid)
    ? reg.journal
    : null;
}

/** Append one trigger to a recorder's journal (one `O_APPEND` write per line,
 *  so concurrent triggers never interleave). */
export async function noteTrigger(
  journal: string,
  note: MarkerNote,
): Promise<void> {
  await Deno.writeTextFile(journal, JSON.stringify(note) + "\n", {
    append: true,
  });
}

/** Pure: the journal's lines as markers on the video's clock. `t0` is the
 *  epoch ms of the video's time zero, `durationMs` its length, `scale` video
 *  px per CSS px. Lines outside the recording, and lines that do not parse
 *  (a trigger killed mid-write), are dropped. Sorted by time. */
export function markersFromJournal(
  text: string,
  t0: number,
  durationMs: number,
  scale: number,
): Marker[] {
  const px = (n: number) => Math.round(n * scale);
  const out: Marker[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let n: MarkerNote;
    try {
      n = JSON.parse(line);
    } catch {
      continue; // aio-ok: a torn final line — the rest of the journal stands
    }
    const t = Math.round(n.at - t0);
    if (!(t >= 0 && t <= durationMs)) continue;
    out.push({
      t,
      path: n.path,
      action: n.action,
      rect: n.rect
        ? { x: px(n.rect.x), y: px(n.rect.y), w: px(n.rect.w), h: px(n.rect.h) }
        : null,
    });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** `demo.mp4` → `demo.mp4.markers.json`. */
export const markersPathFor = (video: string): string =>
  `${video}.markers.json`;

// icon-replay.ts — what a window that connects LATER is sent to show the icon
// the app set with `appIcon()`. An icon is window state, and it went only to
// the UI clients connected at the call: a window opened afterwards (a second
// window, a reconnect after sleep, the first window of an app that set its
// icon in `onStart`) showed the app's own icon until the next call.
//
// One per app server, shared by both transports (WS and the desktop socket)
// and by the zero-port shape that runs no HTTP server at all.

/** The icon frames to replay, kept compacted. */
export type IconReplay = {
  /** Record an "icon" frame as it is sent to every UI client. */
  remember: (raw: string) => void;
  /** The frames a client that connects now must get, oldest first. */
  frames: () => string[];
};

/** Is `raw` an "icon" frame (`enc("icon", …)`)? */
export const isIconFrame = (raw: string): boolean =>
  raw.startsWith('{"v":2,"t":"icon"');

/** A frame keeps only the parts (`window`, `tray`, `tooltip`) no later frame
 *  sets, and goes when it has none left — at most three frames are kept. A
 *  kept frame is replayed whole, in order, so a later one overrides what an
 *  earlier one also carried. */
export function createIconReplay(
  warn: (msg: string) => void,
): IconReplay {
  let kept: { sets: Set<string>; keys: Set<string>; raw: string }[] = [];
  return {
    remember(raw) {
      let d: Record<string, unknown>;
      try {
        d = (JSON.parse(raw) as { d?: Record<string, unknown> }).d ?? {};
      } catch (e) {
        warn(`appIcon: frame not kept for windows that connect later — ${e}`);
        return;
      }
      const keys = new Set(Object.keys(d).filter((k) => k !== "fps"));
      for (const f of kept) for (const k of keys) f.keys.delete(k);
      kept = kept.filter((f) => f.keys.size > 0);
      // All `null` puts those parts back to the app's own — what a new
      // window shows anyway — so it is kept only to undo a kept frame that
      // still carries one of them.
      if (
        [...keys].some((k) => d[k] !== null) ||
        kept.some((f) => [...keys].some((k) => f.sets.has(k)))
      ) {
        kept.push({ sets: new Set(keys), keys, raw });
      }
    },
    frames: () => kept.map((f) => f.raw),
  };
}

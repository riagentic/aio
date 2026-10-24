// app-icon.ts — the app's tray icon, window icon and tray tooltip, changed at
// run time. An EFFECT a method emits, like `notify`: the busy state an icon
// shows lives in a cell, on the server, and the window may be hidden to the
// tray with its page throttled. `s.$do(appIcon({ tray: frames, fps: 8 }))` is
// routed by `routeEffect`, carried to every UI client as an "icon" frame, and
// applied by the Electron main process — which also loops an animation, so a
// frame costs no message. The page has the same calls on `__aioWindow`.
// A target without a desktop window (a browser, Android) says so once.

import { APP_ICON_LIMITS, checkAppIcon } from "../protocol/app-icon-check.ts";
import { log } from "../diagnostics/logger-api.ts";

/** One image: PNG bytes, a `data:` URL, or an app URL (`"/icons/busy.png"`,
 *  fetched by the window from the app). */
export type AppIconImage = string | Uint8Array;

/** What `appIcon()` takes. An absent key leaves that part as it is; `null`
 *  puts back the app's own icon (or the tray's configured tooltip). */
export type AppIconOptions = {
  /** The window/taskbar icon — one image, or frames to loop. */
  window?: AppIconImage | readonly AppIconImage[] | null;
  /** The tray icon (needs `ui.tray`) — one image, or frames to loop. */
  tray?: AppIconImage | readonly AppIconImage[] | null;
  /** The tray tooltip (needs `ui.tray`). */
  tooltip?: string | null;
  /** Frames per second of an animation. Default 8, at most 12. */
  fps?: number;
};

/** What `appIcon()` returns — the options under the framework effect tag,
 *  every image as a string so the effect is plain JSON on the wire. */
export type AppIconEffect = {
  type: "__appIcon";
  window?: string | string[] | null;
  tray?: string | string[] | null;
  tooltip?: string | null;
  fps?: number;
};

const _said = new Set<string>();

function _dataUrl(img: AppIconImage): string {
  if (typeof img === "string") return img;
  let bin = "";
  for (let i = 0; i < img.length; i += 0x8000) {
    bin += String.fromCharCode(...img.subarray(i, i + 0x8000));
  }
  return "data:image/png;base64," + btoa(bin);
}

/** Build the effect. Refuses a bad spec at the call site. */
export function appIcon(o: AppIconOptions): AppIconEffect {
  const { spec, notes } = checkAppIcon(o, APP_ICON_LIMITS);
  for (const n of notes) {
    if (_said.has(n)) continue;
    _said.add(n);
    log.warn("appIcon", n);
  }
  const out: AppIconEffect = { type: "__appIcon", fps: spec.fps as number };
  for (const k of ["window", "tray"] as const) {
    const v = o[k];
    if (v === undefined) continue;
    out[k] = v === null
      ? null
      : Array.isArray(v)
      ? v.map(_dataUrl)
      : _dataUrl(v as AppIconImage);
  }
  if (o.tooltip !== undefined) out.tooltip = o.tooltip;
  return out;
}

/** Type guard — `type === "__appIcon"`. */
export function isAppIconEffect(e: unknown): e is AppIconEffect {
  return typeof e === "object" && e !== null &&
    (e as { type?: unknown }).type === "__appIcon";
}

/** The wire payload: everything but the effect tag. */
export function appIconPayload(
  e: AppIconEffect,
): Omit<AppIconEffect, "type"> {
  const { type: _type, ...rest } = e;
  return rest;
}

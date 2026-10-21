/**
 * @module
 * Where the app's window opens — and the splash, the download window and the
 * Retry / Quit question with it, centred on it. ONE rule, pure, with no
 * imports: {@linkcode boundsFromState} and {@linkcode windowRect} are written
 * into the Electron main script and the macOS helpers as their own source
 * (`Function.prototype.toString`), the GTK worker imports them, and the
 * Windows Forms helpers carry the same few lines in PowerShell
 * (runtime-dialog.ts `PS_PLACE`), pinned against this by tests. Same screens
 * in, same rectangle out, in every process that draws a window.
 *
 * Coordinates are Electron's: logical pixels, origin at the primary
 * display's top-left. Screens are WORK AREAS (no taskbar, no menu bar).
 */

export type Rect = { x: number; y: number; width: number; height: number };

// boundsFromState, windowRect and centredOn are EMITTED as their own source
// (the Electron main script, the Cocoa helpers) — from a minified aio too.
// So each is SELF-CONTAINED: it calls no other function of this module (the
// minifier renames them) and declares no named function inside (keepNames
// wraps one in a global neither process has); the emitter binds each to its
// name (`const windowRect = ` and then its source). Kept whole on its
// screen is `Math.max(lo, Math.min(v, lo + Math.max(0, span - n)))`: `v`
// inside `[lo, lo + span - n]`, `lo` when wider than the screen. Pinned by
// tests/emitted-source-minified.test.ts.

/** A window's size, and its position when one was saved. */
export type Bounds = { width: number; height: number; x?: number; y?: number };

/** The bounds the app's window opens with, from its saved
 *  `<userData>/window-state.json` (`json`; null: none) and the size the app
 *  declares now (`dw`×`dh`): the saved size while the declared one is
 *  unchanged since it was saved, else the declared one; the saved position
 *  when there is one; whether it was maximized. An unreadable or empty state
 *  is none. Pure and self-contained: the Electron main script runs this very
 *  source. */
export function boundsFromState(
  json: string | null,
  dw: number,
  dh: number,
): Bounds & { maximized: boolean; screen?: Rect } {
  try {
    const d = JSON.parse(json === null ? "null" : json);
    if (d && d.width > 0 && d.height > 0) {
      const same = d.declaredWidth === dw && d.declaredHeight === dh;
      const out: Bounds & { maximized: boolean; screen?: Rect } = {
        width: same ? d.width : dw,
        height: same ? d.height : dh,
        maximized: d.maximized === true,
      };
      if (typeof d.x === "number") out.x = d.x;
      if (typeof d.y === "number") out.y = d.y;
      // Windows: the same rect in physical screen pixels, as saved (what a
      // per-monitor-aware helper places in) — for the saved size only.
      const p = d.screen;
      if (
        same && p && typeof p.x === "number" && typeof p.y === "number" &&
        p.width > 0 && p.height > 0
      ) out.screen = { x: p.x, y: p.y, width: p.width, height: p.height };
      return out;
    }
  } catch {
    // aio-ok: an unreadable state is no state, as Electron's own
  }
  return { width: dw, height: dh, maximized: false };
}

/** Where the window opens, and on which screen. A saved position inside a
 *  screen is kept; one that is not (a display gone, or smaller now) moves
 *  into the screen it overlaps most — the first when it overlaps none — and
 *  a window larger than that screen sits at its top-left (the title bar is
 *  what must stay reachable). No saved position: centred on the primary,
 *  kept inside it the same way. No screens: the primary alone. Pure and
 *  self-contained: the Electron main script runs this very source. */
export function windowRect(
  b: Bounds,
  screens: Rect[],
  primary: Rect,
): Rect & { screen: Rect } {
  const w = b.width, h = b.height;
  if (typeof b.x !== "number" || typeof b.y !== "number") {
    const s = primary;
    return {
      x: Math.max(
        s.x,
        Math.min(
          s.x + Math.floor((s.width - w) / 2),
          s.x + Math.max(0, s.width - w),
        ),
      ),
      y: Math.max(
        s.y,
        Math.min(
          s.y + Math.floor((s.height - h) / 2),
          s.y + Math.max(0, s.height - h),
        ),
      ),
      width: w,
      height: h,
      screen: s,
    };
  }
  const x = b.x, y = b.y;
  const all = screens.length ? screens : [primary];
  for (const s of all) {
    if (
      x >= s.x && y >= s.y && x + w <= s.x + s.width &&
      y + h <= s.y + s.height
    ) return { x, y, width: w, height: h, screen: s };
  }
  let s = all[0]!, best = -1;
  for (const k of all) {
    const ix = Math.max(0, Math.min(x + w, k.x + k.width) - Math.max(x, k.x));
    const iy = Math.max(0, Math.min(y + h, k.y + k.height) - Math.max(y, k.y));
    if (ix * iy > best) {
      best = ix * iy;
      s = k;
    }
  }
  return {
    x: Math.max(s.x, Math.min(x, s.x + Math.max(0, s.width - w))),
    y: Math.max(s.y, Math.min(y, s.y + Math.max(0, s.height - h))),
    width: w,
    height: h,
    screen: s,
  };
}

/** The top-left of a `w`×`h` window centred on another: the splash, the
 *  download window and the question on the app's window (`windowRect`),
 *  kept inside that window's screen. Pure and self-contained. */
export function centredOn(
  r: Rect & { screen: Rect },
  w: number,
  h: number,
): { x: number; y: number } {
  const s = r.screen;
  return {
    x: Math.max(
      s.x,
      Math.min(
        Math.round(r.x + r.width / 2 - w / 2),
        s.x + Math.max(0, s.width - w),
      ),
    ),
    y: Math.max(
      s.y,
      Math.min(
        Math.round(r.y + r.height / 2 - h / 2),
        s.y + Math.max(0, s.height - h),
      ),
    ),
  };
}

/** The top-left of a `w`×`h` splash. `window`: centred where the app's
 *  window opens (`windowRect` of `target`; no target: the primary's centre).
 *  `pointer`: the centre of the screen under the pointer. `primary`: the
 *  primary's centre. Kept inside that screen (one larger than it sits at its
 *  top-left). Pure. */
export function splashOrigin(o: {
  mode: "window" | "primary" | "pointer";
  target: Bounds | null;
  screens: Rect[];
  primary: Rect;
  pointer: { x: number; y: number } | null;
  w: number;
  h: number;
}): { x: number; y: number } {
  const whole = (s: Rect) => ({ ...s, screen: s });
  if (o.mode === "window" && o.target) {
    return centredOn(windowRect(o.target, o.screens, o.primary), o.w, o.h);
  }
  if (o.mode === "pointer" && o.pointer) {
    const p = o.pointer;
    const s = o.screens.find((s) =>
      p.x >= s.x && p.y >= s.y && p.x < s.x + s.width && p.y < s.y + s.height
    ) ?? o.primary;
    return centredOn(whole(s), o.w, o.h);
  }
  return centredOn(whole(o.primary), o.w, o.h);
}

/** The parts of the splash below/over the image, laid out the same on every
 *  OS: the bar `bottom` px above the window's bottom edge (or along it,
 *  full width), `side` px from the sides; the text's bottom 8 px above the
 *  bar (or `bottom` px above the edge). `textPosition: "below"` adds a strip
 *  under the image as tall as it holds. `lh`: the text's height, 0 = no
 *  text. Pure. */
export function splashFrame(
  f: {
    w: number;
    h: number;
    below: boolean;
    side: number;
    bottom: number;
    bp: number;
    barEdge: boolean;
  },
  lh: number,
): { TH: number; yb: number; bx: number; bw: number; labelBottom: number } {
  const under = f.bp > 0 && !f.barEdge;
  const TH = f.below && lh > 0
    ? f.h + 8 + lh + f.bottom + (under ? 8 + f.bp : 0)
    : f.h;
  const yb = f.barEdge ? TH - f.bp : TH - f.bottom - f.bp;
  return {
    TH,
    yb,
    bx: f.barEdge ? 0 : f.side,
    bw: f.barEdge ? f.w : f.w - 2 * f.side,
    labelBottom: under ? yb - 8 : TH - f.bottom,
  };
}

/** Where an `iw`×`ih` image is drawn in a `w`×`h` box: `cover` fills it
 *  (the overflow cropped, centred), `contain` shows it whole (centred, the
 *  background around it). Pure. */
export function fitRect(
  iw: number,
  ih: number,
  w: number,
  h: number,
  fit: "cover" | "contain",
): Rect {
  const k = fit === "contain"
    ? Math.min(w / iw, h / ih)
    : Math.max(w / iw, h / ih);
  const dw = Math.round(iw * k), dh = Math.round(ih * k);
  return {
    x: Math.round((w - dw) / 2),
    y: Math.round((h - dh) / 2),
    width: dw,
    height: dh,
  };
}

/** A rounded rectangle as one-pixel rows plus its middle — what an X11
 *  window shape takes (no anti-aliasing, as on Windows). Pure. */
export function roundedRows(w: number, h: number, r: number): Rect[] {
  const R = Math.min(r, Math.floor(w / 2), Math.floor(h / 2));
  if (R <= 0) return [{ x: 0, y: 0, width: w, height: h }];
  const rows: Rect[] = [];
  for (let y = 0; y < R; y++) {
    const dy = R - y - 0.5;
    const inset = Math.round(R - Math.sqrt(R * R - dy * dy));
    rows.push({ x: inset, y, width: w - 2 * inset, height: 1 });
    rows.push({ x: inset, y: h - 1 - y, width: w - 2 * inset, height: 1 });
  }
  rows.push({ x: 0, y: R, width: w, height: h - 2 * R });
  return rows;
}

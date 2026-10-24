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
// name (`const windowRect = ` and then its source). Kept whole inside its
// screen's margin is `Math.max(lo, Math.min(v, lo + Math.max(0, span - n)))`
// with `lo`/`span` the area EDGE_MARGIN inside it: `v` inside
// `[lo, lo + span - n]`, `lo` when wider. Pinned by
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

/** How far inside its screen's work area every window aio places stays, on
 *  each side (logical pixels; less on a screen under 8× that).
 *
 *  A window manager draws its FRAME outside the rect a client asks for:
 *  muffin (Cinnamon) adds an invisible 10 px resize border and a 37 px title
 *  bar, so a window placed at x = 0 has its frame at x = -10, y = -45; a
 *  frameless Electron window grows by its own shadow edge instead (-16, -10;
 *  32 below). Measured on the GPU lab (scripts/gpu-lab.sh). An NVIDIA X
 *  driver (595, 610) handed that off-screen frame faults (Xid 69, 2D engine,
 *  destination X = -10) and 595 then takes Xorg — the whole desktop — down
 *  (feedback/critical.md). aio does not rely on a driver or a window manager
 *  to bounds-check: nothing it places reaches the edge. 64 covers the largest
 *  measured overhang (45) with room for a taller title bar. The functions
 *  below carry it as a literal (they are emitted as their own source);
 *  tests/window-place.test.ts pins the two together. */
export const EDGE_MARGIN = 64;

/** Where the window opens, and on which screen. A saved position inside a
 *  screen is kept; one that is not (a display gone, or smaller now) moves
 *  into the screen it overlaps most — the first when it overlaps none. No
 *  saved position: centred on the primary. No screens: the primary alone.
 *  Whatever it was, the result lies {@linkcode EDGE_MARGIN} inside the
 *  screen's work area on every side, in whole pixels — a window larger than
 *  that is made smaller, and `fills` says so (the window opens maximized:
 *  what a window as big as the screen was). A size or position that is not
 *  a finite number is no value. Pure and self-contained: the Electron main
 *  script runs this very source. */
export function windowRect(
  b: Bounds,
  screens: Rect[],
  primary: Rect,
): Rect & { screen: Rect; fills: boolean } {
  // Number.isFinite is false for anything not a number (no helper function:
  // see the note above the module's functions).
  const w0 = Number.isFinite(b.width) && b.width >= 1
    ? Math.round(b.width)
    : 800;
  const h0 = Number.isFinite(b.height) && b.height >= 1
    ? Math.round(b.height)
    : 600;
  const placed = Number.isFinite(b.x) && Number.isFinite(b.y);
  const all = screens.length ? screens : [primary];
  let s = primary;
  if (placed) {
    const x = b.x!, y = b.y!;
    let found = false;
    for (const k of all) {
      if (
        x >= k.x && y >= k.y && x + w0 <= k.x + k.width &&
        y + h0 <= k.y + k.height
      ) {
        s = k;
        found = true;
        break;
      }
    }
    if (!found) {
      let best = -1;
      s = all[0]!;
      for (const k of all) {
        const ix = Math.max(
          0,
          Math.min(x + w0, k.x + k.width) - Math.max(x, k.x),
        );
        const iy = Math.max(
          0,
          Math.min(y + h0, k.y + k.height) - Math.max(y, k.y),
        );
        if (ix * iy > best) {
          best = ix * iy;
          s = k;
        }
      }
    }
  }
  // EDGE_MARGIN, as a literal (this function is emitted as its own source).
  const mx = Math.min(64, Math.floor(s.width / 8));
  const my = Math.min(64, Math.floor(s.height / 8));
  const iw = Math.max(1, s.width - 2 * mx), ih = Math.max(1, s.height - 2 * my);
  const w = Math.min(w0, iw), h = Math.min(h0, ih);
  const lx = s.x + mx, ly = s.y + my;
  return {
    x: placed
      ? Math.max(lx, Math.min(Math.round(b.x!), lx + iw - w))
      : lx + Math.floor((iw - w) / 2),
    y: placed
      ? Math.max(ly, Math.min(Math.round(b.y!), ly + ih - h))
      : ly + Math.floor((ih - h) / 2),
    width: w,
    height: h,
    screen: s,
    fills: w0 >= iw && h0 >= ih,
  };
}

/** The top-left of a `w`×`h` window centred on another: the splash, the
 *  download window and the question on the app's window (`windowRect`),
 *  kept {@linkcode EDGE_MARGIN} inside that window's screen (one wider than
 *  that sits at the margin). Pure and self-contained. */
export function centredOn(
  r: Rect & { screen: Rect },
  w: number,
  h: number,
): { x: number; y: number } {
  const s = r.screen;
  // EDGE_MARGIN, as a literal (this function is emitted as its own source).
  const mx = Math.min(64, Math.floor(s.width / 8));
  const my = Math.min(64, Math.floor(s.height / 8));
  return {
    x: Math.max(
      s.x + mx,
      Math.min(
        Math.round(r.x + r.width / 2 - w / 2),
        s.x + mx + Math.max(0, s.width - 2 * mx - w),
      ),
    ),
    y: Math.max(
      s.y + my,
      Math.min(
        Math.round(r.y + r.height / 2 - h / 2),
        s.y + my + Math.max(0, s.height - 2 * my - h),
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

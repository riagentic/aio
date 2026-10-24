// app-icon-check.ts — the contract of the "icon" frame (`appIcon()`, and the
// page's `__aioWindow` icon calls): its caps and THE validator. A protocol
// leaf because three runtimes check it — the effect builder (state), the
// shell's preload and its main process (electron, as emitted source).

/** The caps {@linkcode checkAppIcon} enforces — passed to it, never read by
 *  it, because its source is also emitted into the Electron main process and
 *  a build may rename a module constant. */
export const APP_ICON_LIMITS = {
  /** Frames per animation. */
  frames: 64,
  /** Bytes per image, DECODED (a data: URL counts what it decodes to). */
  bytes: 512 * 1024,
  /** Frame rate ceiling — StatusNotifier panels lag above ~12. */
  fps: 12,
  /** Windows shows this many tooltip characters, and drops the rest. */
  tooltip: 127,
} as const;

/** THE validator, for every path (the effect builder, the page's
 *  `__aioWindow` calls in the preload, and the main process): refuses a bad
 *  spec with an Error naming what is wrong; returns the spec with `fps`
 *  resolved and the notes worth saying once (a clamped fps, a tooltip
 *  Windows cuts). Self-contained — its source runs in the Electron shells. */
export function checkAppIcon(
  spec: unknown,
  lim: { frames: number; bytes: number; fps: number; tooltip: number },
): { spec: Record<string, unknown>; notes: string[] } {
  // No named inner functions: a minified build would wrap them in a name
  // helper the Electron processes do not have.
  const P = "appIcon(): ";
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
    throw new Error(P + "takes { window?, tray?, tooltip?, fps? }");
  }
  const s = spec as Record<string, unknown>;
  const unknownKey = Object.keys(s).find((k) =>
    k !== "window" && k !== "tray" && k !== "tooltip" && k !== "fps"
  );
  if (unknownKey) {
    throw new Error(
      P +
        `unknown key "${unknownKey}" — it takes window, tray, tooltip, fps`,
    );
  }
  if (
    s.window === undefined && s.tray === undefined && s.tooltip === undefined
  ) {
    throw new Error(P + "give at least one of window, tray, tooltip");
  }
  const notes: string[] = [];
  let animated = false;
  for (const k of ["window", "tray"]) {
    const v = s[k];
    if (v === undefined || v === null) continue;
    const list = Array.isArray(v) ? v : [v];
    if (list.length === 0) {
      throw new Error(
        P + `${k}: an empty frame list — pass null for the app's own icon`,
      );
    }
    if (list.length > lim.frames) {
      throw new Error(
        P + `${k}: ${list.length} frames — at most ${lim.frames}`,
      );
    }
    if (list.length > 1) animated = true;
    list.forEach((img, i) => {
      // ONE measure at every site: the image's DECODED bytes. Raw bytes are
      // their length; a data: URL is measured by what it decodes to (the
      // builder turns bytes into base64, and the wire must not grow past the
      // cap what the method let through); an app URL is measured once it is
      // fetched, as bytes, by the main process.
      let size = -1;
      if (img instanceof Uint8Array) size = img.byteLength;
      else if (typeof img === "string" && img.startsWith("data:")) {
        const comma = img.indexOf(",");
        const body = comma < 0 ? "" : img.slice(comma + 1);
        size = img.slice(0, comma).endsWith(";base64")
          ? Math.floor(body.length * 3 / 4) -
            (body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0)
          : body.length;
      } else if (typeof img === "string" && img.length > 0) size = 1;
      if (size <= 0) {
        throw new Error(
          P +
            `${k}[${i}]: not an image — PNG bytes, a data: URL or an app URL`,
        );
      }
      if (size > lim.bytes) {
        throw new Error(
          P + `${k}[${i}]: ${size} bytes — at most ${lim.bytes} per image`,
        );
      }
    });
  }
  if (s.tooltip !== undefined && s.tooltip !== null) {
    if (typeof s.tooltip !== "string") {
      throw new Error(P + "tooltip: a string, or null");
    }
    if (s.tooltip.length > lim.tooltip) {
      notes.push(
        `the tooltip is ${s.tooltip.length} characters — Windows shows the first ${lim.tooltip}`,
      );
    }
  }
  let fps = 8;
  if (s.fps !== undefined) {
    if (typeof s.fps !== "number" || !Number.isFinite(s.fps) || s.fps <= 0) {
      throw new Error(P + "fps: a positive number");
    }
    fps = s.fps;
  }
  if (fps > lim.fps) {
    if (animated) {
      notes.push(`fps ${fps} is above ${lim.fps} — running at ${lim.fps}`);
    }
    fps = lim.fps;
  }
  return { spec: { ...s, fps }, notes };
}

/**
 * @module
 * deno.json `build.splash` → the {@linkcode SplashSpec} a desktop package
 * bakes (electron/splash.ts). ONE resolver, pure: the file read is injected.
 * Every key is checked on every build and a bad one is refused by name with
 * its fix — this is the first thing a new user sees.
 */
import { basename, resolve } from "@std/path";
import { appIdentityColors } from "./app-theme.ts";
import { pngSize } from "./app-icon.ts";
import { decodePngSync } from "./png-scale.ts";
import {
  SPLASH_CAP_MS,
  SPLASH_DEFAULTS,
  type SplashColors,
  type SplashLook,
  type SplashSpec,
  splashWithVersion,
} from "../electron/splash.ts";

const KEYS = [
  "image",
  "text",
  "downloadText",
  "progress",
  "minMs",
  "font",
  "color",
  "bar",
  "size",
  "fit",
  "position",
  "background",
  "textPosition",
  "align",
  "margin",
  "shadow",
  "radius",
  "border",
  "windowShadow",
  "maxMs",
  "fadeMs",
  "show",
  "cancel",
  "followWindow",
];
const FONT_KEYS = ["family", "size", "weight"];
const BAR_KEYS = ["style", "color", "track", "height", "position", "radius"];
const PLACEHOLDERS = ["title", "version", "got", "total", "pct"];

/** A splash image larger than this is refused: it is read and drawn before
 *  anything else of the app. */
export const SPLASH_MAX_BYTES = 1_000_000;

const HEX = /^#[0-9a-fA-F]{6}$/;

/** PNG bytes as base64 (chunked: a spread of 1 MB is an argument-count
 *  crash). Pure. */
export function pngBase64(png: Uint8Array): string {
  let s = "";
  for (let i = 0; i < png.length; i += 0x8000) {
    s += String.fromCharCode(...png.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** `build.splash` resolved; `{ splash: null }` when absent or `false`. Pure
 *  over `read` (a file's bytes, or null when it cannot be read). */
export function resolveSplash(
  mainConfig: { build?: unknown },
  ctx: {
    /** The project root — `image` is relative to it. */
    root: string;
    /** The appId: the identity colours' hue. */
    appId: string;
    read: (path: string) => Uint8Array | null;
  },
): { splash: SplashSpec | null } | { error: string } {
  const raw = (mainConfig.build as { splash?: unknown } | undefined)?.splash;
  if (raw === undefined || raw === false) return { splash: null };
  const at = "deno.json build.splash";
  const show = (v: unknown) => JSON.stringify(v);
  const isObj = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const bad = (error: string) => ({ error });
  if (!isObj(raw)) {
    return bad(
      `${at} is ${show(raw)} — it must be false (no splash) or ` +
        `{ "image": "assets/splash.png" } (with "text", "progress", … optional).`,
    );
  }
  const unknown = (o: Record<string, unknown>, path: string, keys: string[]) =>
    Object.keys(o).filter((k) => !keys.includes(k)).map((k) =>
      `${path}.${k} is not a key aio reads — the keys are ${keys.join(", ")}.`
    )[0];
  const u = unknown(raw, at, KEYS);
  if (u) return bad(u);

  if (typeof raw.image !== "string" || !raw.image) {
    return bad(
      `${at}.image is ${show(raw.image)} — a splash needs its image: the ` +
        `path of a PNG relative to the project ("assets/splash.png"; name it ` +
        `…@2x.png when it is drawn for a 2× screen).`,
    );
  }
  const path = resolve(ctx.root, raw.image);
  const bytes = ctx.read(path);
  if (!bytes) {
    return bad(
      `${at}.image names ${path}, which is not there — add the PNG, or fix ` +
        `the path (it is relative to the project).`,
    );
  }
  if (bytes.length > SPLASH_MAX_BYTES) {
    return bad(
      `${at}.image (${path}) is ${(bytes.length / 1e6).toFixed(1)} MB — keep ` +
        `it under 1 MB (it is drawn before anything else of the app).`,
    );
  }
  const size = pngSize(bytes);
  if (!size) return bad(`${at}.image (${path}) is not a PNG — save it as PNG.`);

  // The placeholders a text may use; any other `{…}` is refused by name.
  const stray = (key: string, t: string) => {
    const p = [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)
      .find((p) => !PLACEHOLDERS.includes(p));
    return p === undefined ? null : (
      `${at}.${key} uses {${p}}, which aio does not fill — it may use ` +
      `${PLACEHOLDERS.map((p) => `{${p}}`).join(" ")}.`
    );
  };
  const text = raw.text;
  if (text !== undefined && text !== false) {
    if (typeof text !== "string" || !text.trim()) {
      return bad(
        `${at}.text is ${show(text)} — it must be a non-empty string, or ` +
          `false (image only).`,
      );
    }
    const s = stray("text", text);
    if (s) return bad(s);
  }
  const downloadText = raw.downloadText;
  if (downloadText !== undefined) {
    if (typeof downloadText !== "string" || !downloadText.trim()) {
      return bad(
        `${at}.downloadText is ${show(downloadText)} — it must be a ` +
          `non-empty string (shown instead of "text" while Electron ` +
          `downloads), or left out (the same text throughout).`,
      );
    }
    const s = stray("downloadText", downloadText);
    if (s) return bad(s);
  }
  if (raw.progress !== undefined && typeof raw.progress !== "boolean") {
    return bad(
      `${at}.progress is ${
        show(raw.progress)
      } — it must be true (a bar while ` +
        `Electron downloads) or false.`,
    );
  }
  if (
    raw.minMs !== undefined &&
    !(Number.isInteger(raw.minMs) && (raw.minMs as number) >= 0 &&
      (raw.minMs as number) <= 10_000)
  ) {
    return bad(
      `${at}.minMs is ${show(raw.minMs)} — it must be a whole number of ` +
        `milliseconds from 0 to 10000 (how long the splash stays at least).`,
    );
  }
  const color = (p: string, v: unknown) =>
    v === undefined || (typeof v === "string" && HEX.test(v))
      ? null
      : `${p} is ${show(v)} — it must be a colour as "#rrggbb".`;
  const c = color(`${at}.color`, raw.color);
  if (c) return bad(c);

  const font = raw.font ?? {};
  if (!isObj(font)) {
    return bad(
      `${at}.font is ${show(font)} — it must be ` +
        `{ "family": "…", "size": 14, "weight": "normal" | "bold" }.`,
    );
  }
  const fu = unknown(font, `${at}.font`, FONT_KEYS);
  if (fu) return bad(fu);
  if (
    font.family !== undefined &&
    (typeof font.family !== "string" || !font.family.trim())
  ) {
    return bad(
      `${at}.font.family is ${show(font.family)} — it must be a font name ` +
        `("Segoe UI", "Helvetica Neue"); leave it out for the system's.`,
    );
  }
  if (
    font.size !== undefined &&
    (typeof font.size !== "number" || !(font.size >= 8 && font.size <= 48))
  ) {
    return bad(
      `${at}.font.size is ${show(font.size)} — it must be a number of points ` +
        `from 8 to 48.`,
    );
  }
  if (
    font.weight !== undefined && font.weight !== "normal" &&
    font.weight !== "bold"
  ) {
    return bad(
      `${at}.font.weight is ${show(font.weight)} — it must be "normal" or ` +
        `"bold".`,
    );
  }

  const bar = raw.bar ?? {};
  if (!isObj(bar)) {
    return bad(
      `${at}.bar is ${show(bar)} — it must be ` +
        `{ "style": "solid" | "thin", "color": "#rrggbb", "track": "#rrggbb" }.`,
    );
  }
  const bu = unknown(bar, `${at}.bar`, BAR_KEYS);
  if (bu) return bad(bu);
  if (
    bar.style !== undefined && bar.style !== "solid" && bar.style !== "thin"
  ) {
    return bad(
      `${at}.bar.style is ${show(bar.style)} — it must be "solid" or "thin".`,
    );
  }
  for (const k of ["color", "track"] as const) {
    const e = color(`${at}.bar.${k}`, bar[k]);
    if (e) return bad(e);
  }

  // The look: every key optional, every value checked by name.
  const oneOf = (p: string, v: unknown, ok: readonly string[]) =>
    v === undefined || ok.includes(v as string)
      ? null
      : `${p} is ${show(v)} — it must be ${
        ok.map((o) => `"${o}"`).join(", ").replace(/, ([^,]*)$/, " or $1")
      }.`;
  const int = (p: string, v: unknown, lo: number, hi: number, unit: string) =>
    v === undefined ||
      (Number.isInteger(v) && (v as number) >= lo && (v as number) <= hi)
      ? null
      : `${p} is ${show(v)} — it must be a whole number of ${unit} from ` +
        `${lo} to ${hi}.`;
  const bool = (p: string, v: unknown) =>
    v === undefined || typeof v === "boolean"
      ? null
      : `${p} is ${show(v)} — it must be true or false.`;
  const sz = raw.size;
  if (sz !== undefined) {
    if (!isObj(sz)) {
      return bad(
        `${at}.size is ${show(sz)} — it must be ` +
          `{ "width": 640, "height": 360 } (logical pixels).`,
      );
    }
    const su = unknown(sz, `${at}.size`, ["width", "height"]);
    if (su) return bad(su);
    for (const k of ["width", "height"] as const) {
      const e = sz[k] === undefined
        ? `${at}.size.${k} is missing — a size names both width and height.`
        : int(`${at}.size.${k}`, sz[k], 16, 4096, "logical pixels");
      if (e) return bad(e);
    }
  }
  const look = [
    oneOf(`${at}.fit`, raw.fit, ["cover", "contain"]),
    oneOf(`${at}.position`, raw.position, ["window", "primary", "pointer"]),
    color(`${at}.background`, raw.background),
    oneOf(`${at}.textPosition`, raw.textPosition, ["over", "below", "none"]),
    oneOf(`${at}.align`, raw.align, ["left", "center", "right"]),
    int(`${at}.margin`, raw.margin, 0, 200, "logical pixels"),
    bool(`${at}.shadow`, raw.shadow),
    int(`${at}.radius`, raw.radius, 0, 200, "logical pixels"),
    color(`${at}.border`, raw.border),
    bool(`${at}.windowShadow`, raw.windowShadow),
    int(`${at}.maxMs`, raw.maxMs, 1000, 600_000, "milliseconds"),
    int(`${at}.fadeMs`, raw.fadeMs, 0, 2000, "milliseconds"),
    oneOf(`${at}.show`, raw.show, ["always", "firstStart", "never"]),
    bool(`${at}.cancel`, raw.cancel),
    bool(`${at}.followWindow`, raw.followWindow),
    int(`${at}.bar.height`, bar.height, 1, 64, "logical pixels"),
    oneOf(`${at}.bar.position`, bar.position, ["under-text", "bottom-edge"]),
    int(`${at}.bar.radius`, bar.radius, 0, 32, "logical pixels"),
  ].find((e) => e !== null);
  if (look) return bad(look);
  const minMs = (raw.minMs as number | undefined) ?? 1000;
  if (raw.maxMs !== undefined && (raw.maxMs as number) < minMs) {
    return bad(
      `${at}.maxMs is ${raw.maxMs}, under minMs (${minMs}) — the longest ` +
        `the splash stays cannot be shorter than the shortest.`,
    );
  }
  if (raw.show === "never") return { splash: null };

  // Colours the app did not set are its identity's, per light/dark mode; a
  // colour it set is the same in both. The text over the image (the
  // default `textPosition`) takes the colour that reads on the image's
  // lower part instead: the page's text colour is for the page, not for a
  // picture (a dark title on a dark image was the result).
  const id = appIdentityColors(ctx.appId);
  const over = raw.textPosition !== "below" && raw.color === undefined
    ? decodePngSync(bytes)
    : null;
  const mode = (m: typeof id.light): SplashColors => {
    const bg = (raw.background as string | undefined) ?? m.background;
    return {
      background: bg,
      text: (raw.color as string | undefined) ??
        (over !== null ? overTextColor(over, bg) : m.text),
      bar: (bar.color as string | undefined) ?? m.accent,
      track: (bar.track as string | undefined) ?? m.track,
    };
  };
  return {
    splash: {
      image: {
        png: pngBase64(bytes),
        w: size.w,
        h: size.h,
        scale: /@2x\.png$/i.test(basename(path)) ? 2 : 1,
      },
      // Left out: the app's title, and while Electron downloads the
      // download's own line (SPLASH_DEFAULTS). `text: false`: no text.
      text: raw.textPosition === "none" || text === false
        ? null
        : typeof text === "string"
        ? text
        : SPLASH_DEFAULTS.text,
      ...(raw.textPosition === "none" ||
          (text === false && typeof downloadText !== "string")
        ? {}
        : {
          downloadText: typeof downloadText === "string"
            ? downloadText
            : SPLASH_DEFAULTS.downloadText,
        }),
      // Left out: the bar (and with it the ✕) while Electron downloads.
      progress: raw.progress !== false,
      minMs,
      font: {
        family: (font.family as string | undefined) ?? null,
        size: (font.size as number | undefined) ?? 13,
        weight: (font.weight as "normal" | "bold" | undefined) ?? "bold",
      },
      bar: (bar.style as "solid" | "thin" | undefined) ?? "solid",
      light: mode(id.light),
      dark: mode(id.dark),
      look: {
        size: isObj(sz)
          ? { width: sz.width as number, height: sz.height as number }
          : null,
        fit: (raw.fit as SplashLook["fit"] | undefined) ?? "cover",
        position: (raw.position as SplashLook["position"] | undefined) ??
          "window",
        textPosition: raw.textPosition === "below" ? "below" : "over",
        align: (raw.align as SplashLook["align"] | undefined) ?? null,
        margin: (raw.margin as number | undefined) ?? null,
        shadow: (raw.shadow as boolean | undefined) ?? null,
        radius: (raw.radius as number | undefined) ?? SPLASH_DEFAULTS.radius,
        border: (raw.border as string | undefined) ?? null,
        windowShadow: (raw.windowShadow as boolean | undefined) ?? null,
        maxMs: (raw.maxMs as number | undefined) ?? SPLASH_CAP_MS,
        fadeMs: (raw.fadeMs as number | undefined) ?? null,
        show: raw.show === "firstStart" ? "firstStart" : "always",
        cancel: raw.cancel !== false,
        barHeight: (bar.height as number | undefined) ?? null,
        barPosition: bar.position === "bottom-edge"
          ? "bottom-edge"
          : "under-text",
        barRadius: (bar.radius as number | undefined) ?? null,
        followWindow: raw.followWindow !== false,
      },
    },
  };
}

/** The text colour that reads over an image's lower third (where
 *  `textPosition: "over"` puts the text), the image laid over `bg`: white,
 *  or near-black — whichever has the higher contrast (WCAG) with that part's
 *  mean colour. An image that cannot be read (`img` is why): white, which
 *  the text's shadow carries. Pure. */
export function overTextColor(
  img: { w: number; h: number; rgba: Uint8Array } | string,
  bg: string,
): string {
  if (typeof img === "string") return "#ffffff";
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const b = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16));
  let sum = 0, n = 0;
  // Every 4th pixel of the lower third: the mean, not every pixel, matters.
  for (let y = Math.floor(img.h * 2 / 3); y < img.h; y += 2) {
    for (let x = 0; x < img.w; x += 4) {
      const o = (y * img.w + x) * 4, a = img.rgba[o + 3]! / 255;
      const [r, g, bl] = [0, 1, 2].map((k) =>
        lin(img.rgba[o + k]! * a + b[k]! * (1 - a))
      );
      sum += 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
      n++;
    }
  }
  const l = n ? sum / n : 0;
  const dark = 0.0056; // #111111's relative luminance
  return 1.05 / (l + 0.05) >= (l + 0.05) / (dark + 0.05)
    ? "#ffffff"
    : "#111111";
}

/** A run from source shows the splash its build would bake: THE resolver
 *  over the project's own deno.json (`config`, in `root`), `{version}` filled
 *  with this run's version — but only on a start the user made, never on the
 *  dev loop's automatic restart after a save (`restarted`: it would flash on
 *  every save). `{ splash: null }`: none to show. Pure over `read`. */
export function sourceSplash(
  config: { build?: unknown } | undefined,
  ctx: {
    root: string;
    appId: string;
    version: string;
    restarted: boolean;
    read: (path: string) => Uint8Array | null;
  },
): { splash: SplashSpec | null } | { error: string } {
  if (!config || ctx.restarted) return { splash: null };
  const r = resolveSplash(config, ctx);
  return "error" in r || !r.splash
    ? r
    : { splash: splashWithVersion(r.splash, ctx.version) };
}

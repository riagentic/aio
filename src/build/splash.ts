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
import type { SplashColors, SplashSpec } from "../electron/splash.ts";

const KEYS = ["image", "text", "progress", "minMs", "font", "color", "bar"];
const FONT_KEYS = ["family", "size", "weight"];
const BAR_KEYS = ["style", "color", "track"];
const PLACEHOLDERS = ["title", "got", "total", "pct"];

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

  const text = raw.text;
  if (text !== undefined && text !== false) {
    if (typeof text !== "string" || !text.trim()) {
      return bad(
        `${at}.text is ${show(text)} — it must be a non-empty string, or ` +
          `false (image only).`,
      );
    }
    const stray = [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)
      .find((p) => !PLACEHOLDERS.includes(p));
    if (stray) {
      return bad(
        `${at}.text uses {${stray}}, which aio does not fill — it may use ` +
          `${PLACEHOLDERS.map((p) => `{${p}}`).join(" ")}.`,
      );
    }
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

  // Colours the app did not set are its identity's, per light/dark mode; a
  // colour it set is the same in both.
  const id = appIdentityColors(ctx.appId);
  const mode = (m: typeof id.light): SplashColors => ({
    background: m.background,
    text: (raw.color as string | undefined) ?? m.text,
    bar: (bar.color as string | undefined) ?? m.accent,
    track: (bar.track as string | undefined) ?? m.track,
  });
  return {
    splash: {
      image: {
        png: pngBase64(bytes),
        w: size.w,
        h: size.h,
        scale: /@2x\.png$/i.test(basename(path)) ? 2 : 1,
      },
      text: typeof text === "string" ? text : null,
      progress: raw.progress === true,
      minMs: (raw.minMs as number | undefined) ?? 1000,
      font: {
        family: (font.family as string | undefined) ?? null,
        size: (font.size as number | undefined) ?? 13,
        weight: (font.weight as "normal" | "bold" | undefined) ?? "bold",
      },
      bar: (bar.style as "solid" | "thin" | undefined) ?? "solid",
      light: mode(id.light),
      dark: mode(id.dark),
    },
  };
}

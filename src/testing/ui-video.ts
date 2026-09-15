/**
 * @module
 * `--video` for `testUI` — a recording of a UI test, made from the command
 * line, with no change to the test.
 *
 *   deno test -A tests/todo.test.tsx -- --video=videos/
 *   AIO_VIDEO=demo.mp4 deno test -A tests/todo.test.tsx --filter "adds"
 *
 * HOW, and why this way: `testUI` runs the app in happy-dom, which has a DOM
 * and no pixels. So the recorder never touches the test's run at all — after
 * each step it SERIALIZES the page (synchronously: no await, no timer, nothing
 * the app could observe), and when the test is over it replays those pages in
 * a headless Chromium that draws them with the app's real stylesheet, then
 * encodes the pictures. The test takes the same path with the flag as without
 * it, so a recorded run cannot pass where an unrecorded one fails (tests are
 * the strictest environment — a recorder that let timers fire between steps
 * would not be).
 *
 * What the picture cannot show, said plainly: pointer hover styles, a text
 * caret, `<canvas>` content, and anything an app draws with a layout the DOM
 * does not carry. The layout itself is Chromium's, from the app's own CSS.
 */

import { basename, dirname, join, resolve } from "@std/path";
import { chromiumBin, chromiumPage, launchChromium } from "./chromium.ts";
import {
  evaluateIn,
  isolatedWorld,
  openPageEncoder,
  planFrames,
  videoFormatOf,
} from "../media/encoder.ts";
import type { VideoFormat } from "../media/chunks.ts";
import { codeMask } from "../diagnostics/code-mask.ts";
import { generateHTML } from "../server/server-html-gen.ts";
import { APP_STYLE, appHasStylesheet } from "../server/app-files.ts";
import { readDenoJsonSync } from "../server/deno-json.ts";
import { resolveEntryPath } from "../server/paths.ts";
import { appIdFromConfig, slugify } from "../server/single-instance-lock.ts";
import { declareHarnessFlags } from "../server/aio-cli.ts";

// deno-lint-ignore no-explicit-any
type AnyNode = any;

/** What `--video` asked for. */
export type UiVideoConfig = {
  /** A directory (one file per test) or one file. */
  path: string;
  kind: "dir" | "file";
  format: VideoFormat;
  /** How long each step stays on screen, ms. */
  paceMs: number;
};

const DEFAULT_PACE_MS = 800;
const FLAGS = ["--video", "--video-pace"];
// The test process's arguments are also parsed by every boot inside it; these
// are the harness's, not the app's. `--video <path>` (space form) passes too:
// a bare word is not a flag to the app parser.
declareHarnessFlags(FLAGS.flatMap((f) => [f, `${f}=`]));

/** Pure: read `--video[=| ]<path>` / `--video-pace[=| ]<ms>` from the test's
 *  arguments (what follows `--` on `deno test`) and `AIO_VIDEO` /
 *  `AIO_VIDEO_PACE` from the environment. `null` when no video was asked for.
 *
 *  Every mistake throws, because each one would otherwise be a test run that
 *  quietly produced no video: an unknown `--video-*` flag, a flag with no
 *  value, a pace with no video, an extension that is not a video format, and
 *  the argument and the environment naming two different places. */
export function uiVideoConfig(
  args: readonly string[],
  env: (name: string) => string | undefined,
): UiVideoConfig | null {
  const fromArgs: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith("--video")) continue;
    const eq = a.indexOf("=");
    const flag = eq === -1 ? a : a.slice(0, eq);
    if (!FLAGS.includes(flag)) {
      throw new Error(
        `[aio:video] unknown flag ${flag} — the video flags are ` +
          `--video=<dir/ or file.mp4|.webm> and --video-pace=<ms>`,
      );
    }
    let value = eq === -1 ? args[i + 1] : a.slice(eq + 1);
    if (eq === -1) {
      if (value === undefined || value.startsWith("--")) value = "";
      else i++;
    }
    if (!value) {
      throw new Error(
        `[aio:video] ${flag} needs a value (${flag}=${
          flag === "--video" ? "videos/" : "800"
        })`,
      );
    }
    fromArgs[flag] = value;
  }
  const pick = (flag: string, envName: string) => {
    const a = fromArgs[flag];
    const e = env(envName) || undefined;
    if (a !== undefined && e !== undefined && a !== e) {
      throw new Error(
        `[aio:video] ${flag}=${a} and ${envName}=${e} disagree — set one`,
      );
    }
    return a ?? e;
  };
  const path = pick("--video", "AIO_VIDEO");
  const pace = pick("--video-pace", "AIO_VIDEO_PACE");
  if (path === undefined) {
    if (pace !== undefined) {
      throw new Error(
        "[aio:video] --video-pace without --video records nothing — add " +
          "--video=videos/",
      );
    }
    return null;
  }
  const paceMs = pace === undefined ? DEFAULT_PACE_MS : Number(pace);
  if (!Number.isInteger(paceMs) || paceMs < 50 || paceMs > 60_000) {
    throw new Error(
      `[aio:video] --video-pace=${pace}: whole milliseconds, 50–60000`,
    );
  }
  const hasExt = /\.[a-z0-9]+$/i.test(basename(path)) && !path.endsWith("/");
  return hasExt
    ? { path, kind: "file", format: videoFormatOf(path), paceMs }
    : { path, kind: "dir", format: "mp4", paceMs };
}

// ── the page, frozen ─────────────────────────────────────────────────────

/** One serialized moment of the page. */
export type UiSnapshot = {
  title: string;
  htmlAttrs: [string, string][];
  bodyAttrs: [string, string][];
  /** Stylesheets the app added to `<head>` at runtime. */
  head: string;
  body: string;
  /** The step being taken, drawn as a caption. */
  caption?: string;
};

const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "source",
  "track",
  "wbr",
]);

const escText = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** Pure read of the live DOM into HTML — the element's LIVE state included
 *  (an input's typed value and a checkbox's checked state are properties,
 *  which `outerHTML` does not carry), marks for the focused element, the
 *  step's target and scroll offsets, and no scripts or inline handlers. */
export function serializeNode(
  node: AnyNode,
  marks: { focus?: AnyNode; target?: AnyNode; root?: AnyNode },
): string {
  if (node.nodeType === 3) return escText(String(node.data ?? ""));
  if (node.nodeType !== 1 && node.nodeType !== 11) return "";
  if (node.nodeType === 11) {
    return [...node.childNodes].map((c) => serializeNode(c, marks)).join("");
  }
  // Lower-cased: the HTML parser that reads this back restores the case of
  // SVG's camelCase names (`linearGradient`) itself.
  const tag = String(node.localName ?? node.tagName).toLowerCase();
  if (tag === "script" || tag === "template") return "";
  const attrs = new Map<string, string>();
  for (const a of [...(node.attributes ?? [])]) {
    if (/^on/i.test(a.name)) continue;
    attrs.set(a.name, a.value);
  }
  if (tag === "input") {
    const type = String(node.type ?? "").toLowerCase();
    if (type === "checkbox" || type === "radio") {
      if (node.checked) attrs.set("checked", "");
      else attrs.delete("checked");
    } else if (type !== "file") {
      attrs.set("value", String(node.value ?? ""));
    }
  }
  if (tag === "option") {
    if (node.selected) attrs.set("selected", "");
    else attrs.delete("selected");
  }
  if (node === marks.root && !attrs.has("id")) attrs.set("id", "root");
  if (marks.focus && node === marks.focus) {
    attrs.set("data-aio-video-focus", "");
  }
  if (marks.target && node === marks.target) {
    attrs.set("data-aio-video-target", "");
  }
  const top = Number(node.scrollTop) || 0;
  const left = Number(node.scrollLeft) || 0;
  if (top || left) attrs.set("data-aio-video-scroll", `${top} ${left}`);
  const open = `<${tag}${
    [...attrs].map(([k, v]) => ` ${k}="${escAttr(v)}"`).join("")
  }>`;
  if (VOID.has(tag)) return open;
  let inner: string;
  if (tag === "textarea") inner = escText(String(node.value ?? ""));
  else if (tag === "style") {
    inner = String(node.textContent ?? "").replace(/<\/style/gi, "<\\/style");
  } else {
    inner = [...node.childNodes].map((c) => serializeNode(c, marks)).join("");
  }
  return `${open}${inner}</${tag}>`;
}

/** Pure read: the whole page as a {@linkcode UiSnapshot}. */
export function snapshotDocument(
  doc: AnyNode,
  root: AnyNode,
  target?: AnyNode,
  caption?: string,
): UiSnapshot {
  const active = doc.activeElement;
  const marks = {
    root,
    target,
    focus: active && active !== doc.body && active !== doc.documentElement
      ? active
      : undefined,
  };
  const attrs = (el: AnyNode): [string, string][] =>
    [...(el?.attributes ?? [])]
      .filter((a: AnyNode) => !/^on/i.test(a.name))
      .map((a: AnyNode) => [a.name, a.value]);
  const head = [...(doc.head?.children ?? [])]
    .filter((el: AnyNode) =>
      el.localName === "style" ||
      (el.localName === "link" &&
        /\bstylesheet\b/i.test(el.getAttribute("rel") ?? ""))
    )
    .map((el: AnyNode) => serializeNode(el, {}))
    .join("");
  return {
    title: String(doc.title ?? ""),
    htmlAttrs: attrs(doc.documentElement),
    bodyAttrs: attrs(doc.body),
    head,
    body: [...(doc.body?.childNodes ?? [])]
      .map((c: AnyNode) => serializeNode(c, marks))
      .join(""),
    ...(caption ? { caption } : {}),
  };
}

// ── the app's look ───────────────────────────────────────────────────────

/** The literal values of an `aio.run({ … })` call that decide how the page
 *  LOOKS. A static read (the entry cannot be imported — it starts the app), so
 *  a value that is not a literal is reported, never guessed. */
export type RunLook = {
  appId?: string;
  theme?: string;
  layout?: boolean;
  lang?: string;
  dir?: string;
  /** Keys that are present but not literals — the video uses their default. */
  unread: string[];
};

/** Pure: read {@linkcode RunLook} from an entry's source. */
export function readRunLook(src: string): RunLook {
  const mask = codeMask(src);
  let at = -1;
  for (const m of src.matchAll(/\baio\s*\.\s*run\s*\(/g)) {
    if (mask[m.index!]) {
      at = m.index! + m[0].length;
      break;
    }
  }
  const look: RunLook = { unread: [] };
  if (at === -1) return look;
  // The call's argument text, up to its balanced close paren.
  let depth = 1;
  let end = at;
  for (; end < src.length && depth > 0; end++) {
    if (!mask[end]) continue;
    if (src[end] === "(") depth++;
    else if (src[end] === ")") depth--;
  }
  const args = src.slice(at, end);
  const key = (name: string, value: RegExp): string | undefined => {
    const present = new RegExp(`\\b${name}\\s*:`).exec(args);
    if (!present) return undefined;
    const m = new RegExp(`\\b${name}\\s*:\\s*${value.source}`).exec(args);
    if (!m) {
      look.unread.push(name);
      return undefined;
    }
    return m[2] ?? m[1];
  };
  const str = /(["'`])([^"'`$]*)\1/;
  const appId = key("appId", str);
  const theme = key("theme", str);
  const layout = key("layout", /(true|false)\b/);
  const lang = key("lang", str);
  const dir = key("dir", str);
  if (appId !== undefined) look.appId = appId;
  if (theme !== undefined) look.theme = theme;
  if (layout !== undefined) look.layout = layout === "true";
  if (lang !== undefined) look.lang = lang;
  if (dir !== undefined) look.dir = dir;
  return look;
}

/** Where the app lives and the `<head>` its real page would carry. */
type AppLook = {
  appDir: string | null;
  /** The shell's `<head>` content, scripts removed. */
  head: string;
  lang?: string;
  dir?: string;
  /** One line saying where the look came from. */
  summary: string;
};

/** The project a test belongs to: the nearest `deno.json` above the test
 *  file, else above the cwd. */
function projectOf(
  testFile: string | null,
): { dir: string; config: Record<string, unknown> } | null {
  const starts = [testFile ? dirname(testFile) : null, Deno.cwd()];
  for (const start of starts) {
    if (!start) continue;
    for (let d = resolve(start);; d = dirname(d)) {
      const found = readDenoJsonSync(d);
      if (found) return { dir: d, config: found.config };
      if (dirname(d) === d) break;
    }
  }
  return null;
}

/** Resolve the look the app's real page would have. */
export function appLook(testFile: string | null): AppLook {
  const project = projectOf(testFile);
  if (!project) {
    return {
      appDir: null,
      head: shellHead({ title: "aio", themeName: "aio" }),
      summary: "no deno.json found — aio's default look",
    };
  }
  const entry = join(project.dir, resolveEntryPath(project.config));
  let look: RunLook = { unread: [] };
  let entryNote = "";
  try {
    look = readRunLook(Deno.readTextFileSync(entry));
  } catch {
    entryNote = ` (no entry at ${entry} — default look)`;
  }
  const appDir = dirname(entry);
  const appId = look.appId ? slugify(look.appId) : appIdFromConfig(
    project.config as { appId?: string; title?: string; name?: string },
  ) ?? slugify(basename(project.dir));
  const hasCSS = appHasStylesheet(appDir);
  const theme = look.theme as Parameters<typeof generateHTML>[0]["theme"];
  const head = shellHead({
    title: appId,
    themeName: appId,
    hasCSS,
    theme,
    layout: look.layout,
    lang: look.lang,
  });
  const notes = [
    `theme ${JSON.stringify(look.theme ?? "tokens")}`,
    `appId ${JSON.stringify(appId)}`,
    hasCSS ? APP_STYLE : `no ${APP_STYLE}`,
    ...(look.unread.length
      ? [`not literal, so default: ${look.unread.join(", ")}`]
      : []),
  ];
  return {
    appDir,
    head,
    lang: look.lang,
    dir: look.dir,
    summary: `look from ${entry}${entryNote}: ${notes.join(", ")}`,
  };
}

/** The real shell's `<head>` — generated by THE shell generator, so the video
 *  carries exactly the stylesheet the app's page does — minus its scripts. */
function shellHead(o: {
  title: string;
  themeName: string;
  hasCSS?: boolean;
  theme?: Parameters<typeof generateHTML>[0]["theme"];
  layout?: boolean;
  lang?: string;
}): string {
  const html = generateHTML({
    title: o.title,
    prod: true,
    hasCSS: o.hasCSS ?? false,
    importMap: "",
    theme: o.theme,
    layout: o.layout,
    themeName: o.themeName,
    lang: o.lang,
  });
  const head = /<head>([\s\S]*?)<\/head>/.exec(html)?.[1] ?? "";
  return head.replace(/<script\b[\s\S]*?<\/script>/gi, "");
}

// ── the recorder ─────────────────────────────────────────────────────────

/** Files claimed by this process — a second test writing the same file is
 *  refused instead of silently overwriting the first one's video. */
const claimed = new Map<string, string>();
let lookPrinted = false;

/** The test file that called `testUI`, from the stack. */
function callerTestFile(): string | null {
  const stack = new Error().stack ?? "";
  for (const m of stack.matchAll(/(file:\/\/[^\s)]+?):\d+:\d+/g)) {
    const url = m[1]!;
    if (/\/src\/testing\/|\/src\/cell-test\.ts/.test(url)) continue;
    try {
      return new URL(url).pathname;
    } catch {
      return null;
    }
  }
  return null;
}

type Frame = { snap: UiSnapshot; ms: number };

/** Records one `testUI` mount. */
export type UiVideoRecorder = {
  /** A step is about to act on `target` — frame it, captioned. */
  before(target: AnyNode | null, caption: string): void;
  /** The step finished — frame the result. */
  after(): void;
  /** An observation point (and the first render) — frame it if the page
   *  changed. */
  observe(): void;
  /** Draw, encode and write the video. */
  finish(): Promise<void>;
};

/** Start recording a mount, or `null` when no video was asked for. Throws
 *  (so the mount fails, loudly) on a bad flag, a missing Chromium, or a
 *  second test claiming the same file. */
export function openUiVideo(o: {
  name: string | undefined;
  doc: AnyNode;
  root: AnyNode;
  viewport: { width: number; height: number };
  args?: readonly string[];
  env?: (name: string) => string | undefined;
}): UiVideoRecorder | null {
  const cfg = uiVideoConfig(
    o.args ?? Deno.args,
    o.env ?? ((n) => Deno.env.get(n)),
  );
  if (!cfg) return null;
  const bin = chromiumBin("testUI --video");
  const testFile = callerTestFile();
  const label = o.name ??
    `${
      basename(testFile ?? "testui").replace(/\.(test|spec)?\.?[jt]sx?$/, "")
    }`;
  let out: string;
  if (cfg.kind === "file") {
    out = resolve(cfg.path);
    const prior = claimed.get(out);
    if (prior !== undefined) {
      throw new Error(
        `[aio:video] ${cfg.path} names ONE file, and "${prior}" is already ` +
          `recording into it — "${label}" would overwrite it. Pass a ` +
          `directory (--video=videos/) or run one test (--filter).`,
      );
    }
  } else {
    const base = slugify(label, "testui");
    out = resolve(cfg.path, `${base}.${cfg.format}`);
    for (let n = 2; claimed.has(out); n++) {
      out = resolve(cfg.path, `${base}-${n}.${cfg.format}`);
    }
  }
  claimed.set(out, label);

  const frames: Frame[] = [];
  let failure: unknown = null;
  let step: string | undefined;
  const pace = cfg.paceMs;
  const take = (target?: AnyNode, caption?: string) => {
    try {
      return snapshotDocument(o.doc, o.root, target, caption);
    } catch (e) {
      failure ??= e; // raised at finish — never in the middle of the test
      return null;
    }
  };
  const sameAsLast = (s: UiSnapshot) => {
    const last = frames.at(-1)?.snap;
    return !!last && last.body === s.body && last.head === s.head &&
      last.title === s.title && last.caption === s.caption &&
      JSON.stringify([last.htmlAttrs, last.bodyAttrs]) ===
        JSON.stringify([s.htmlAttrs, s.bodyAttrs]);
  };

  return {
    before(target, caption) {
      step = caption;
      const s = take(target ?? undefined, caption);
      if (s) frames.push({ snap: s, ms: Math.max(50, Math.round(pace / 2)) });
    },
    after() {
      const s = take(undefined, step);
      step = undefined;
      if (s) frames.push({ snap: s, ms: pace });
    },
    observe() {
      const s = take();
      if (s && !sameAsLast(s)) frames.push({ snap: s, ms: pace });
    },
    async finish() {
      if (failure) throw failure;
      const t0 = performance.now();
      const look = appLook(testFile);
      const seconds = await renderVideo(
        frames,
        out,
        cfg.format,
        o.viewport,
        look,
        bin,
      );
      if (!lookPrinted) {
        lookPrinted = true;
        console.log(`[aio:video] ${look.summary}`);
      }
      console.log(
        `[aio:video] ${label} → ${out} (${frames.length} frames, ` +
          `${seconds.toFixed(1)}s video, ${
            Math.round(performance.now() - t0)
          }ms to make)`,
      );
    },
  };
}

/** Plain JS run in the drawing page: put a snapshot on screen and wait until
 *  it is painted (fonts, images and stylesheets loaded, two frames). */
const MIRROR = `(() => {
  let applied = [];
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const settled = async () => {
    const imgs = [...document.images].filter((i) => !i.complete)
      .map((i) => new Promise((r) => { i.onload = i.onerror = r; }));
    const sheets = [...document.querySelectorAll('link[rel~="stylesheet"]')]
      .filter((l) => !l.sheet)
      .map((l) => new Promise((r) => { l.onload = l.onerror = r; }));
    await Promise.race([Promise.all([...imgs, ...sheets, document.fonts.ready]), wait(3000)]);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  };
  globalThis.__aioMirror = async (s) => {
    document.title = s.title;
    const html = document.documentElement;
    for (const name of applied) html.removeAttribute(name);
    applied = s.htmlAttrs.map(([k]) => k);
    for (const [k, v] of s.htmlAttrs) html.setAttribute(k, v);
    for (const n of document.head.querySelectorAll("[data-aio-video-head]")) n.remove();
    const t = document.createElement("template");
    t.innerHTML = s.head;
    for (const n of [...t.content.children]) {
      n.setAttribute("data-aio-video-head", "");
      document.head.appendChild(n);
    }
    for (const a of [...document.body.attributes]) document.body.removeAttribute(a.name);
    for (const [k, v] of s.bodyAttrs) document.body.setAttribute(k, v);
    document.body.innerHTML = s.body;
    for (const el of document.querySelectorAll("[data-aio-video-scroll]")) {
      const [top, left] = el.getAttribute("data-aio-video-scroll").split(" ").map(Number);
      el.scrollTop = top;
      el.scrollLeft = left;
    }
    const focus = document.querySelector("[data-aio-video-focus]");
    if (focus && focus.focus) focus.focus({ preventScroll: true });
    else if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    for (const n of document.querySelectorAll("[data-aio-video-overlay]")) n.remove();
    const target = document.querySelector("[data-aio-video-target]");
    if (target) {
      target.scrollIntoView({ block: "nearest", inline: "nearest" });
      const r = target.getBoundingClientRect();
      const ring = document.createElement("div");
      ring.setAttribute("data-aio-video-overlay", "");
      ring.style.cssText = "position:fixed;pointer-events:none;z-index:2147483647;" +
        "border:3px solid #ff2e88;border-radius:8px;box-shadow:0 0 0 5px rgba(255,46,136,.25);" +
        "left:" + (r.left - 5) + "px;top:" + (r.top - 5) + "px;" +
        "width:" + (r.width + 10) + "px;height:" + (r.height + 10) + "px";
      html.appendChild(ring);
    }
    if (s.caption) {
      const cap = document.createElement("div");
      cap.setAttribute("data-aio-video-overlay", "");
      cap.textContent = s.caption;
      cap.style.cssText = "position:fixed;left:50%;bottom:16px;transform:translateX(-50%);" +
        "z-index:2147483647;pointer-events:none;max-width:90vw;overflow:hidden;" +
        "text-overflow:ellipsis;white-space:nowrap;padding:6px 12px;border-radius:999px;" +
        "background:rgba(20,20,24,.82);color:#fff;font:500 16px/1.3 system-ui,sans-serif";
      html.appendChild(cap);
    }
    await settled();
    return true;
  };
  return true;
})()`;

const CONTENT_TYPES: Record<string, string> = {
  css: "text/css",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
};

async function renderVideo(
  frames: readonly Frame[],
  out: string,
  format: VideoFormat,
  viewport: { width: number; height: number },
  look: AppLook,
  bin: string,
): Promise<number> {
  if (frames.length === 0) {
    throw new Error(
      "[aio:video] nothing was recorded — the mount never rendered",
    );
  }
  const page = `<!DOCTYPE html>\n<html${
    look.lang ? ` lang="${escAttr(look.lang)}"` : ""
  }${
    look.dir && look.dir !== "ltr" ? ` dir="${escAttr(look.dir)}"` : ""
  }>\n<head>${look.head}</head>\n<body></body>\n</html>`;
  // The app's own files (style.css, images) at the paths its page uses.
  const appRoot = look.appDir ? resolve(look.appDir) : null;
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, onListen() {} },
    async (req) => {
      const path = decodeURIComponent(new URL(req.url).pathname);
      if (path === "/") {
        return new Response(page, { headers: { "content-type": "text/html" } });
      }
      if (appRoot) {
        const file = resolve(appRoot, "." + path);
        if (file.startsWith(appRoot + "/")) {
          try {
            const body = await Deno.readFile(file);
            const ext = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase() ?? "";
            return new Response(body, {
              headers: {
                "content-type": CONTENT_TYPES[ext] ??
                  "application/octet-stream",
              },
            });
          } catch {
            // aio-ok: missing path is not an error — the 404 below is the answer
          }
        }
      }
      return new Response(null, { status: 404 });
    },
  );
  const w = viewport.width;
  const h = viewport.height;
  const browser = await launchChromium(bin, [
    "--remote-debugging-port=0",
    `--window-size=${w},${h}`,
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "about:blank",
  ]);
  try {
    const cdp = await chromiumPage(browser);
    try {
      await cdp.call("Page.enable");
      await cdp.call("Emulation.setDeviceMetricsOverride", {
        width: w,
        height: h,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await cdp.call("Emulation.setFocusEmulationEnabled", { enabled: true });
      let off = () => {};
      const loaded = new Promise<void>((r) => {
        off = cdp.on("Page.loadEventFired", () => r());
      });
      await cdp.call("Page.navigate", {
        url: `http://127.0.0.1:${server.addr.port}/`,
      });
      await loaded;
      off();
      const encoder = await openPageEncoder(cdp, format, w, h);
      const mirror = await isolatedWorld(cdp, "aio-video-mirror");
      await evaluateIn(cdp, mirror, MIRROR);
      const times: number[] = [];
      let t = 0;
      for (const f of frames) {
        times.push(t * 1000);
        t += f.ms;
      }
      const endUs = t * 1000; // `t` already includes the last frame's time
      for (const p of planFrames(times, endUs)) {
        let image: string | undefined;
        if (p.src !== null) {
          await evaluateIn(
            cdp,
            mirror,
            `__aioMirror(${JSON.stringify(frames[p.src]!.snap)})`,
          );
          const shot = await cdp.call("Page.captureScreenshot", {
            format: "png",
          }) as { data: string };
          image = shot.data;
        }
        await encoder.add([{ image, us: p.us, key: p.key }]);
      }
      const bytes = await encoder.finish(endUs);
      await Deno.mkdir(dirname(out), { recursive: true });
      await Deno.writeFile(out, bytes);
      return endUs / 1e6;
    } finally {
      await cdp.close();
    }
  } finally {
    await browser.close();
    await server.shutdown();
  }
}

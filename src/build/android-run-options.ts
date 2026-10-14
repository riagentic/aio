// android-run-options.ts — which `aio.run()` options reach a packaged (local)
// APK or web app, and how.
//
// The bundle entry (`makeEntryCode` in client-bundle.ts) imports the UI
// component and nothing else: the app's entry module (`src/app.ts`) never runs
// on the phone. So the BUILD runs it once (`probeRunOptions`), with `aio.run`
// replaced by a function that prints the options and exits, and bakes the
// serializable ones the standalone runtime honours into the packaged shell:
// `ui.*` through the one head builder every target uses, the rest as
// `__aioRunOptions`, which `ensureConnected` (standalone-air.ts) boots with.
// What cannot travel — a hook (server code), a function inside an option, a
// server-only option — is still NAMED by the build (.katana/core.md: never a
// silent drop). When the probe cannot run, nothing is baked and the build
// falls back to reading the SOURCE: the top-level keys of the object literal
// passed to `aio.run(`.
import { join, toFileUrl } from "@std/path";

/** Every key of the literal `aio.run({...})` in `src`, plus the keys of its
 *  `ui: {...}` literal. `opaque` is true when some option cannot be read from
 *  the text (a spread, a computed key, `aio.run(config)`) — the warning then
 *  says so rather than claiming a complete list. `found` is false when the
 *  source has no `aio.run(` call at all. */
export type RunOptionScan = {
  found: boolean;
  keys: string[];
  uiKeys: string[];
  opaque: boolean;
};

/** Comments blanked, string/template contents neutralised — so the brace
 *  walk below never counts a `{` inside a string or a comment. Quoted-string
 *  text survives (minus the structural characters) so a quoted key keeps its
 *  name; template contents are blanked whole (a `${}` holds braces). */
function mask(src: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src.charAt(i), n = src.charAt(i + 1);
    if (c === "/" && n === "/") {
      while (i < src.length && src.charAt(i) !== "\n") {
        out.push(" ");
        i++;
      }
    } else if (c === "/" && n === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end < 0 ? src.length : end + 2;
      out.push(src.slice(i, stop).replace(/[^\n]/g, " "));
      i = stop;
    } else if (c === "/" && regexMayStart(out)) {
      // A regex literal: `/"/g` read as a string opener swallowed the source
      // up to the next quote — `aio.run(` with it — and the build warned
      // about nothing. Blanked whole; a `/` inside `[...]` does not close it.
      let inClass = false;
      out.push(" ");
      i++;
      while (i < src.length && src.charAt(i) !== "\n") {
        const r = src.charAt(i);
        if (r === "\\") {
          out.push("  ");
          i += 2;
          continue;
        }
        out.push(" ");
        i++;
        if (r === "[") inClass = true;
        else if (r === "]") inClass = false;
        else if (r === "/" && !inClass) break;
      }
    } else if (c === '"' || c === "'" || c === "`") {
      out.push(c);
      i++;
      while (i < src.length && src.charAt(i) !== c) {
        if (src.charAt(i) === "\\") {
          out.push("  ");
          i += 2;
          continue;
        }
        out.push(c === "`" ? " " : src.charAt(i).replace(/[{}()[\],:]/, "_"));
        i++;
      }
      if (i < src.length) {
        out.push(c);
        i++;
      }
    } else {
      out.push(c);
      i++;
    }
  }
  return out.join("");
}

/** Whether a `/` after the masked text so far starts a regex literal rather
 *  than dividing: no value precedes it (an operator, an opening bracket, a
 *  `,`/`;`, a keyword such as `return`, or nothing at all). */
function regexMayStart(out: string[]): boolean {
  // The last few non-blank characters — walked back, never the whole join
  // (a `/` per line would make the scan quadratic).
  let before = "";
  for (let k = out.length - 1; k >= 0 && before.length < 12; k--) {
    const piece = out[k] ?? "";
    if (before === "" && piece.trim() === "") continue;
    before = piece + before;
  }
  before = before.trimEnd();
  if (before === "") return true;
  // Not `<`/`>`: a JSX closing tag (`</b>`) is no regex.
  if (/[(,=:[!&|?{};+\-*%~^]$/.test(before)) return true;
  return /(?:^|[^\w$])(?:return|typeof|case|do|else|in|of|void|yield|await)$/
    .test(before);
}

const OPEN = "{([", CLOSE = "})]";

/** The index of the bracket closing the one at `open`, or -1. */
function closeOf(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s.charAt(i);
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c) && --depth === 0) return i;
  }
  return -1;
}

/** Top-level keys of the object literal whose `{` is at `open`, and where
 *  each `key: value` value starts. */
function literalKeys(
  s: string,
  open: number,
): { keys: string[]; opaque: boolean; values: Map<string, number> } {
  const close = closeOf(s, open);
  const keys: string[] = [];
  const values = new Map<string, number>();
  let opaque = close < 0;
  const end = close < 0 ? s.length : close;
  const isSpace = (at: number) => /\s/.test(s.charAt(at));
  let i = open + 1;
  while (i < end) {
    while (i < end && (isSpace(i) || s.charAt(i) === ",")) i++;
    if (i >= end) break;
    if (s.startsWith("...", i) || s.charAt(i) === "[") opaque = true;
    else {
      // `async`/`get`/`set`/`*` before a method name, then the key itself.
      const m = /^(?:(?:async|get|set)\s+)?\*?\s*(["']?)([\w$]+)\1\s*/.exec(
        s.slice(i, end),
      );
      const key = m?.[2];
      if (m && key) {
        keys.push(key);
        let v = i + m[0].length;
        if (s.charAt(v) === ":") {
          v++;
          while (v < end && isSpace(v)) v++;
          values.set(key, v);
        }
      } else opaque = true;
    }
    // Skip to the next top-level comma.
    let depth = 0;
    for (; i < end; i++) {
      const c = s.charAt(i);
      if (OPEN.includes(c)) depth++;
      else if (CLOSE.includes(c)) depth--;
      else if (c === "," && depth === 0) break;
    }
  }
  return { keys, opaque, values };
}

/** Read the options an entry module passes to `aio.run(`. Text-level on
 *  purpose: the build cannot execute the entry (it is server code). */
export function scanRunOptions(src: string): RunOptionScan {
  const s = mask(src);
  // `import { aio as app }` renames it: `app.run({...})` is the same call, and
  // matching only the literal `aio.` left that app's warning silent. (A
  // namespace import still reads `ns.aio.run(`, which the literal matches.)
  const names = ["aio"];
  for (const m of s.matchAll(/\bimport\s*(?:type\s+)?\{([^}]*)\}/g)) {
    for (const a of (m[1] ?? "").matchAll(/\baio\s+as\s+([\w$]+)/g)) {
      if (a[1]) names.push(a[1].replace(/\$/g, "\\$"));
    }
  }
  const call = new RegExp(
    `(?<![\\w$])(?:${names.join("|")})\\s*\\.\\s*run\\s*\\(`,
  ).exec(s);
  if (!call) return { found: false, keys: [], uiKeys: [], opaque: false };
  let i = call.index + call[0].length;
  while (i < s.length && /\s/.test(s.charAt(i))) i++;
  if (s.charAt(i) === ")") {
    return { found: true, keys: [], uiKeys: [], opaque: false };
  }
  if (s.charAt(i) !== "{") {
    return { found: true, keys: [], uiKeys: [], opaque: true };
  }
  const top = literalKeys(s, i);
  const uiAt = top.values.get("ui");
  const ui = uiAt !== undefined && s.charAt(uiAt) === "{"
    ? literalKeys(s, uiAt)
    : { keys: [], opaque: top.keys.includes("ui") };
  return {
    found: true,
    keys: top.keys,
    uiKeys: ui.keys,
    opaque: top.opaque || ui.opaque,
  };
}

/** What each option the standalone runtime WOULD honour costs a local APK,
 *  and what to do instead. Anything not listed is server/desktop-only and has
 *  no meaning on a phone — it is still named, in one line. */
const UI_LOSS: Record<string, string> = {
  theme: "the APK renders the tokens-only look — ship src/style.css",
  layout: "follows ui.theme — ship src/style.css",
  lang: "set document.documentElement.lang from the App component",
  dir: "set document.documentElement.dir from the App component",
  head: "the packaged <head> is fixed at build time",
  viewport: "the packaged <head> is fixed at build time",
  showStatus: "the packaged shell has no status banner",
};
const TOP_LOSS: Record<string, string> = {
  persist:
    "the APK persists every cell — set persist per cell: cell({ persist })",
  cellDefaults: "set persist/visible on each cell instead",
  localFirst: "not applied — no server to sync with in a local APK",
  onRestore: "does not run — use the cell's own onRestore",
  onStart: "does not run — the APK has no server lifecycle",
  onStop: "does not run — the APK has no server lifecycle",
  onStopping: "does not run — the APK has no server lifecycle",
  onError: "does not run — errors surface through the runtime's own log",
  onAction: "does not run — observe from a cell method instead",
  onEffect: "does not run — observe from a cell method instead",
  beforeReduce: "does not run — validate inside the cell method",
  circuitBreaker: "the APK uses the default",
  perfBudget: "the APK uses the default budgets",
  effectTimeoutMs: "the APK uses the default effect timeout",
  cells: "only the cells App.tsx imports are in the APK",
  // Not server-only: the build packages the deno.json `assets` mounts at the
  // same paths (`_packAssetMounts`) — the `assets` scaffold declares both.
  assets: "the APK packages deno.json `assets` instead — declare the mount " +
    "there (relative fetches keep working)",
};

/** The top-level options a build bakes for the standalone runtime — the ones
 *  `bootStandalone` reads and that mean something without a server.
 *  (`localFirst` is left out on purpose: there is no server to sync with.) */
export const BAKED_TOP = [
  "persist",
  "persistDebounceMs",
  "cellDefaults",
  "circuitBreaker",
  "refusalsReject",
  "perfBudget",
  "effectTimeoutMs",
] as const;
/** The `ui` options a build writes into the packaged shell. */
export const BAKED_UI = [
  "theme",
  "layout",
  "lang",
  "dir",
  "head",
  "viewport",
] as const;

/** What the entry really passed to `aio.run()`, read by running it. */
export type ProbedRunOptions = {
  /** Every key of the options object, and of its `ui`. */
  keys: string[];
  uiKeys: string[];
  /** The serializable part of the {@linkcode BAKED_TOP} options. */
  options: Record<string, unknown>;
  /** The valid {@linkcode BAKED_UI} options. */
  ui: {
    theme?: "tokens" | "auto" | "full" | "none";
    layout?: boolean;
    lang?: string;
    dir?: "ltr" | "rtl" | "auto";
    head?: string;
    viewport?: string | false;
  };
  /** Paths inside a baked option that could not travel (a function, a class
   *  instance, a value of the wrong type), e.g. `cellDefaults.visible.forUser`. */
  dropped: string[];
};

/** The script the probe runs: `aio.run` is replaced before the entry loads,
 *  so the entry's first call hands its options over and the process ends —
 *  no server, no window, no data directory. It runs under the app's own
 *  import map, so the `aio` it patches is the one the entry imports.
 *  Exported for its test. */
export function runOptionsProbeSource(
  aioSpecifier: string,
  entryUrl: string,
  nonce: string,
): string {
  return `import { aio } from ${JSON.stringify(aioSpecifier)};
const TOP = ${JSON.stringify(BAKED_TOP)}, UI = ${JSON.stringify(BAKED_UI)};
const say = (v) => {
  console.log(${
    JSON.stringify(`[aio:${nonce}] run-options: `)
  } + JSON.stringify(v));
  Deno.exit(0);
};
const dropped = [];
const plain = (v, path, seen) => {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "object" && !seen.includes(v)) {
    const proto = Object.getPrototypeOf(v);
    if (Array.isArray(v)) {
      return v.map((x, i) => plain(x, path + "[" + i + "]", [...seen, v]) ?? null);
    }
    if (proto === Object.prototype || proto === null) {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        const y = plain(x, path + "." + k, [...seen, v]);
        if (y !== undefined) out[k] = y;
      }
      return out;
    }
  }
  if (v !== undefined) dropped.push(path);
  return undefined;
};
aio.run = (cfg) => {
  const c = cfg !== null && typeof cfg === "object" ? cfg : {};
  const ui = c.ui !== null && typeof c.ui === "object" ? c.ui : {};
  const pick = (from, names, at) => {
    const out = {};
    for (const k of names) {
      const y = plain(from[k], at + k, []);
      if (y !== undefined) out[k] = y;
    }
    return out;
  };
  say({
    keys: Object.keys(c),
    uiKeys: Object.keys(ui),
    options: pick(c, TOP, ""),
    ui: pick(ui, UI, "ui."),
    dropped,
  });
};
await import(${JSON.stringify(entryUrl)});
say(null);
`;
}

/** The `ui` values a shell can take, each checked — a wrong type is dropped
 *  (and named), never written into the page. Pure. */
function validUi(
  ui: Record<string, unknown>,
  dropped: string[],
): ProbedRunOptions["ui"] {
  const ok: Record<string, (v: unknown) => boolean> = {
    theme: (v) => ["tokens", "auto", "full", "none"].includes(v as string),
    layout: (v) => typeof v === "boolean",
    lang: (v) => typeof v === "string",
    dir: (v) => ["ltr", "rtl", "auto"].includes(v as string),
    head: (v) => typeof v === "string",
    viewport: (v) => typeof v === "string" || v === false,
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ui)) {
    if (ok[k]?.(v)) out[k] = v;
    else dropped.push(`ui.${k}`);
  }
  return out as ProbedRunOptions["ui"];
}

/** A part of a baked option the build leaves out on purpose, and why. */
const NOT_BAKED: Record<string, string> = {
  "cellDefaults.visible":
    "not applied in the APK, as in every build before — set `visible` on " +
    "the cell itself",
};

/** `cellDefaults.visible` is never baked. No APK or web build before 1.0.20
 *  applied it (the entry's options did not reach them), and on this runtime a
 *  `visible` filter is enforced on the UI's own reads — so the same source,
 *  rebuilt, would stop showing state it showed (measured: a hidden field's
 *  read is refused, and a value that is no filter stops the boot). A cell's own
 *  `visible` always applied there, and still does. Named in the warning
 *  (`dropped`), once, whatever was inside it. Pure. */
function withoutDefaultVisible(p: ProbedRunOptions): ProbedRunOptions {
  const cd = p.options.cellDefaults;
  if (!cd || typeof cd !== "object" || !("visible" in cd)) return p;
  const { visible: _, ...rest } = cd as Record<string, unknown>;
  const { cellDefaults: __, ...options } = p.options;
  return {
    ...p,
    options: Object.keys(rest).length
      ? { ...options, cellDefaults: rest }
      : options,
    dropped: [
      ...p.dropped.filter((d) => !d.startsWith("cellDefaults.visible")),
      "cellDefaults.visible",
    ],
  };
}

/** Set (to `1`) in the process the build runs the entry in — an entry whose
 *  top-level code must not run during a build can read it
 *  (docs/build/environment.md). */
export const BUILD_PROBE_ENV = "AIO_BUILD_PROBE";

/** What the probe's process may do: read (files, the environment, the
 *  system) — what an entry needs to be IMPORTED (measured on examples/*: the
 *  environment alone, for a dependency's `NODE_ENV` read). Nothing that leaves
 *  a mark: no write, no network, no subprocess, no native library. An entry
 *  whose top-level code needs one of those fails the probe — nothing is
 *  baked, the build goes on as it did before the probe existed. */
const PROBE_PERMISSIONS = [
  "--no-prompt",
  "--allow-read",
  "--allow-env",
  "--allow-sys",
];

/** Run the app's entry far enough to read what it passes to `aio.run()`.
 *  Returns the options, or — as a string, one line — why they could not be
 *  read (the caller then bakes nothing and says so). Never throws and never
 *  prints: whatever the entry says stays in this function. The script reaches
 *  the child on stdin (no file is written into the app), which Deno resolves
 *  from `root` — so the entry's own deno.json (import map, unstable flags,
 *  node_modules) is the probe's too. */
export async function probeRunOptions(
  root: string,
  entryRel: string,
  timeoutMs = 60_000,
): Promise<ProbedRunOptions | string> {
  try {
    const src = await Deno.readTextFile(join(root, entryRel));
    const spec = /\bimport\s*\{[^}]*\baio\b[^}]*\}\s*from\s*["']([^"']+)["']/
      .exec(src)?.[1];
    if (!spec) return `${entryRel} has no \`import { aio } from "…"\``;
    const nonce = crypto.randomUUID();
    // Asked afterwards, not read off the exit: Windows has no signal to report
    // (the abort is TerminateProcess — exit 1, `signal: null`).
    const timeout = AbortSignal.timeout(timeoutMs);
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", ...PROBE_PERMISSIONS, "--no-check", "--no-lock", "-"],
      cwd: root,
      env: { NO_COLOR: "1", [BUILD_PROBE_ENV]: "1" },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      signal: timeout,
    }).spawn();
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(
      runOptionsProbeSource(
        spec,
        toFileUrl(join(root, entryRel)).href,
        nonce,
      ),
    ));
    await w.close();
    const out = await child.output();
    const dec = new TextDecoder();
    const mark = `[aio:${nonce}] run-options: `;
    const line = dec.decode(out.stdout).split("\n").find((l) =>
      l.startsWith(mark)
    );
    if (!line) {
      // Deno's own "error: …" line, else the last thing said — one line.
      const lines = dec.decode(out.stderr).trim().split("\n");
      const said = (lines.find((l) => l.startsWith("error: ")) ?? lines.at(-1))
        ?.slice(0, 200);
      return timeout.aborted
        ? `${entryRel} did not reach aio.run() within ${timeoutMs / 1000}s`
        : `running ${entryRel} failed (exit ${out.code}${
          said ? `: ${said}` : ""
        })`;
    }
    const got = JSON.parse(line.slice(mark.length)) as
      | (Omit<ProbedRunOptions, "ui"> & { ui: Record<string, unknown> })
      | null;
    if (!got) return `${entryRel} ended without calling aio.run()`;
    return withoutDefaultVisible({ ...got, ui: validUi(got.ui, got.dropped) });
  } catch (e) {
    // aio-ok: a probe that cannot run is an answer, not a failed build — the caller prints it and bakes nothing.
    return `${entryRel} could not be run (${
      String(e instanceof Error ? e.message : e).split("\n")[0]
    })`;
  }
}

/** The inline script that hands the baked options to the standalone runtime,
 *  or "" when there are none. `<` is escaped, so no option's text can close
 *  the script. Pure. */
export function bakedRunOptionsScript(
  options: Record<string, unknown>,
): string {
  if (Object.keys(options).length === 0) return "";
  return `<script>globalThis.__aioRunOptions=${
    JSON.stringify(options).replace(/</g, "\\u003c")
  }</script>`;
}

/** The warning for a local APK built from an app whose entry is `src`
 *  (`entryRel` names it), or null when nothing is lost. With `probed` (the
 *  build read the real options) it names only what could NOT be baked;
 *  without (`why` says what stopped the probe) nothing was baked and it names
 *  every option the source sets. */
export function androidRunOptionsWarning(
  src: string,
  entryRel: string,
  shell: "apk" | "web" = "apk",
  probed?: ProbedRunOptions | string,
): { headline: string; body: string; fix: string } | null {
  const baked = typeof probed === "object";
  const scan = baked
    ? { found: true, keys: probed.keys, uiKeys: probed.uiKeys, opaque: false }
    : scanRunOptions(src);
  if (!scan.found) return null;
  const isBaked = (k: string) =>
    baked && !probed.dropped.includes(k) &&
    (k.startsWith("ui.")
      ? (BAKED_UI as readonly string[]).includes(k.slice(3))
      : (BAKED_TOP as readonly string[]).includes(k));
  const set = [
    ...scan.keys.filter((k) => k !== "ui"),
    ...scan.uiKeys.map((k) => `ui.${k}`),
  ].filter((k) => !isBaked(k));
  if (set.length === 0 && !scan.opaque && !(baked && probed.dropped.length)) {
    return null;
  }
  const lost: string[] = [];
  const serverOnly: string[] = [];
  for (const k of set) {
    const why = baked && probed.dropped.includes(k)
      ? "not a value the build can bake"
      : k.startsWith("ui.")
      ? UI_LOSS[k.slice(3)]
      : TOP_LOSS[k];
    if (why) lost.push(`  · ${k} — ${why}`);
    else serverOnly.push(k);
  }
  if (serverOnly.length) {
    lost.push(`  · ${serverOnly.join(", ")} — server/desktop only`);
  }
  if (baked) {
    for (const path of probed.dropped.filter((d) => !set.includes(d))) {
      lost.push(
        `  · ${path} — ${
          NOT_BAKED[path] ?? "a function or object the build cannot bake"
        }`,
      );
    }
  }
  if (scan.opaque) {
    lost.push(
      "  · (some options are computed or spread — none of them reach it either)",
    );
  }
  if (typeof probed === "string") {
    lost.push(`  (nothing could be baked in: ${probed})`);
  }
  const what = baked
    ? "some aio.run() options it sets could not be baked in"
    : "aio.run() options it sets do not reach";
  if (shell === "web") {
    return {
      headline: `the standalone web app never runs ${entryRel} — ` +
        (baked ? what : `${what} the page`),
      body: lost.join("\n").replaceAll("APK", "web app"),
      fix: "the web build bundles only the UI component and what it " +
        "imports; or build the `browser` target (a binary that serves the " +
        `page and runs ${entryRel})`,
    };
  }
  return {
    headline: `the local APK never runs ${entryRel} — ` +
      (baked ? what : `${what} the phone`),
    body: lost.join("\n"),
    fix: "the APK bundles only App.tsx and what it imports; " +
      "or build --android --remote (the APK is then a client of the server " +
      `that runs ${entryRel})`,
  };
}

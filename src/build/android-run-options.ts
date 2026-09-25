// android-run-options.ts — what a packaged (local) APK loses from `aio.run()`.
//
// The APK's bundle entry (`makeEntryCode` in client-bundle.ts) imports the UI
// component and nothing else: the app's entry module (`src/app.ts`) never runs
// on the phone, so NOTHING passed to `aio.run({...})` reaches it — not `ui.*`,
// not the hooks, not `persist`/`cellDefaults`/`localFirst`. The standalone
// runtime WOULD honour several of them (`runStandalone` in standalone-air.ts),
// but nothing calls it. Until the build bakes the serializable config into the
// bundle (todo.md, "APK: bake app.ts config into the bundle"), the build must
// at least SAY so, naming each option the app sets (.katana/core.md: never a
// silent drop). The build cannot run app.ts, so it reads the SOURCE: the
// top-level keys of the object literal passed to `aio.run(`.

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
};

/** The warning for a local APK built from an app whose entry is `src`
 *  (`entryRel` names it), or null when the entry passes no options. */
export function androidRunOptionsWarning(
  src: string,
  entryRel: string,
): { headline: string; body: string; fix: string } | null {
  const scan = scanRunOptions(src);
  if (!scan.found) return null;
  const set = [
    ...scan.keys.filter((k) => k !== "ui"),
    ...scan.uiKeys.map((k) => `ui.${k}`),
  ];
  if (set.length === 0 && !scan.opaque) return null;
  const lost: string[] = [];
  const serverOnly: string[] = [];
  for (const k of set) {
    const why = k.startsWith("ui.") ? UI_LOSS[k.slice(3)] : TOP_LOSS[k];
    if (why) lost.push(`  · ${k} — ${why}`);
    else serverOnly.push(k);
  }
  if (serverOnly.length) {
    lost.push(`  · ${serverOnly.join(", ")} — server/desktop only`);
  }
  if (scan.opaque) {
    lost.push(
      "  · (some options are computed or spread — none of them reach it either)",
    );
  }
  return {
    headline: `the local APK never runs ${entryRel} — ` +
      `aio.run() options it sets do not reach the phone`,
    body: lost.join("\n"),
    fix: "the APK bundles only App.tsx and what it imports; " +
      "or build --android --remote (the APK is then a client of the server " +
      `that runs ${entryRel})`,
  };
}

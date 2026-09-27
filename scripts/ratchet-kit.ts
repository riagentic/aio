// ratchet-kit.ts — the shared frame of the bug-CLASS ratchets
// (check-proto-in, check-utf16-bytes, check-string-keys).
//
// Each of those gates is one scanner — a pure `scanSource(raw)` that its test
// pins on text — plus the same frame every ratchet in this repo carries: walk
// `src/`, read a `// aio-ok: <reason>` justification from the comment the code
// mask blanks (on the line or the one above), and hold the count to a CEILING
// that may only go down. The frame is identical three times, so it lives here
// once; the scanners, which are what a reviewer actually needs to read, stay
// in their own files.
//
// The scanners read source through `scripts/source-mask.ts`, not
// `src/diagnostics/code-mask.ts`. Both blank comments, strings and regex
// bodies with offsets preserved; the difference is `${…}`. code-mask treats a
// hole as template TEXT and finds a template's end by the next backtick — so a
// NESTED template (`${a ? `x` : ""}`) closes the outer one early and flips the
// rest of that literal into "code": 30 lines of English prose in src/ read as
// `… in …` operators. source-mask walks holes as real code, recursively, which
// is also what these rules want — `${k in o ? … : …}` is a membership test.
import { justified as okMarker } from "../src/diagnostics/ok-marker.ts";

export type Hit = { file: string; line: number };

/** 1-based line of offset `i` in `src`. */
export function lineAt(src: string, i: number): number {
  let n = 1;
  for (let k = 0; k < i; k++) if (src.charCodeAt(k) === 10) n++;
  return n;
}

/** Is the finding on 1-based `line` of `lines` justified for `rule` — by an
 *  `aio-ok` marker on that line or on the line above it? The marker lives in
 *  a comment, so `lines` must be the ORIGINAL text, never the masked one. */
export function justifiedAt(
  lines: readonly string[],
  line: number,
  rule: string,
): boolean {
  return okMarker(lines[line - 1] ?? "", rule) ||
    okMarker(lines[line - 2] ?? "", rule);
}

/** Every `.ts` under `root` (a directory path ending in `/`), sorted. */
export async function walkTs(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string) {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}${e.name}`;
      if (e.isDirectory) await walk(`${p}/`);
      else if (e.name.endsWith(".ts")) out.push(p);
    }
  }
  await walk(root);
  return out.sort();
}

/** The `k` hits most likely to be the NEW ones — those in the most recently
 *  modified files (ties: later in the file first). Pure over `mtimeOf`.
 *
 *  A ceiling only knows HOW MANY hits there are, not which ones are new, and
 *  every gate used to name the last `k` in walk order — alphabetically last,
 *  not newest. One planted violation in `src/am/` was reported as
 *  `src/testing/ui-test.ts:3632`, and the fix the message asks for (an
 *  `aio-ok` marker "in place") put on THAT line turns the gate green with the
 *  new hit still there. */
export function likelyNew<T extends { file: string }>(
  hits: readonly T[],
  k: number,
  mtimeOf: (file: string) => number,
): T[] {
  if (k <= 0) return [];
  return hits.map((h, i) => ({ h, i, t: mtimeOf(h.file) }))
    .sort((a, b) => b.t - a.t || b.i - a.i)
    .slice(0, k)
    .map((o) => o.h);
}

/** `mtimeOf` for files named relative to `root` — memoised; 0 if unreadable. */
export function mtimeUnder(root: string): (file: string) => number {
  const seen = new Map<string, number>();
  return (file) => {
    let t = seen.get(file);
    if (t === undefined) {
      try {
        t = Deno.statSync(root + file).mtime?.getTime() ?? 0;
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
        t = 0;
      }
      seen.set(file, t);
    }
    return t;
  };
}

/** The scanned root: `src/` of this checkout, or `--root=<dir>` — so a rule
 *  can be replayed against an older tree to prove it would have fired there
 *  (the report is then informational: no ceiling applies to a foreign tree). */
export function scanRoot(): { root: string; foreign: boolean } {
  const arg = Deno.args.find((a) => a.startsWith("--root="));
  if (!arg) {
    return {
      root: new URL("../src/", import.meta.url).pathname,
      foreign: false,
    };
  }
  const r = arg.slice("--root=".length);
  return { root: r.endsWith("/") ? r : `${r}/`, foreign: true };
}

/** Scan every file under the root with `scan`, keyed by budget name. */
export async function collect<K extends string>(
  root: string,
  scan: (raw: string) => Record<K, number[]>,
  keys: readonly K[],
): Promise<Record<K, Hit[]>> {
  const out = Object.fromEntries(keys.map((k) => [k, [] as Hit[]])) as Record<
    K,
    Hit[]
  >;
  for (const file of await walkTs(root)) {
    const r = scan(await Deno.readTextFile(file));
    const rel = file.slice(root.length);
    for (const k of keys) {
      for (const line of r[k]) out[k].push({ file: rel, line });
    }
  }
  return out;
}

/** Hold one budget. Both directions fail: over the ceiling is a regression,
 *  under it is ground gained that must be nailed down — a ratchet allowed to
 *  sit above the real count is just a ceiling, and a ceiling rots.
 *
 *  `foreign` (a `--root=` replay) prints the count and never fails. */
export function holdBudget(o: {
  hits: Hit[];
  ceiling: number;
  what: string;
  name: string;
  script: string;
  fix: string;
  foreign: boolean;
  prefix: string;
}): boolean {
  const n = o.hits.length;
  if (Deno.args.includes("--list")) {
    for (const h of o.hits) console.log(`  ${o.prefix}${h.file}:${h.line}`);
  }
  if (o.foreign) {
    console.log(`  ${o.what}: ${n} (replay; ceiling ${o.ceiling} not applied)`);
    return true;
  }
  if (n > o.ceiling) {
    console.error(
      `✗ ${n} ${o.what} in src/ (ceiling ${o.ceiling}).\n` + o.fix +
        `  Run with --list to see all of them. Recently added, most likely:\n` +
        likelyNew(o.hits, n - o.ceiling, mtimeUnder(scanRoot().root)).map((
          h,
        ) => `      ${o.prefix}${h.file}:${h.line}`).join("\n"),
    );
    return false;
  }
  if (n < o.ceiling) {
    console.error(
      `✗ ${n} ${o.what} — below the ceiling of ${o.ceiling}.\n` +
        `  Good. Lower ${o.name} to ${n} in scripts/${o.script} so the\n` +
        `  ground you just gained cannot be given back.`,
    );
    return false;
  }
  return true;
}

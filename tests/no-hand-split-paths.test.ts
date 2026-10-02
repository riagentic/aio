// Ratchet: no OS path is split on `/` by hand in src/.
//
// A Windows path has no `/`. "Everything before the last `/`" is then the whole
// path, and "after the last `/`" is the whole path too: the dev server's import
// graph looked for `…\App.tsx\cell.ts` and served every Windows dev app the
// diagnostic page; the update pruner did not recognise the running version by
// name. `@std/path` (`dirname`, `basename`, `relative`) knows the host's
// separators. A split that never sees an OS path — a URL, a route, a package
// name, a path already normalised to `/`, POSIX-only code — says why on the
// line or the line above: `// aio-ok: path-split — <why>`.
//
// Not scanned: src/air, src/browser and src/ui — the browser runtime, which
// only ever sees URLs and routes (the boundary matrix keeps server code out).
import { assertEquals } from "@std/assert";
import { codeMatches } from "../aiol/scan.ts";

/** The hand splits: cut at the last `/` by regex, `lastIndexOf`/`indexOf` of
 *  `/`, `split("/")`, and a prefix/suffix test that glues on a `/`. */
const HAND =
  /\.replace\(\s*\/\\\/\[\^\/\][*+]\$\/|\.lastIndexOf\(\s*["'`]\/["'`]|\.indexOf\(\s*["'`]\/["'`]|\.split\(\s*["'`]\/["'`]\s*\)|\.split\(\s*\/\\\/\/\s*\)|\.startsWith\([^)\n]*\+\s*["'`]\/["'`]\s*\)|\.endsWith\(\s*["'`]\/["'`]\s*\+/g;
const MARK = /\/\/\s*aio-ok:\s*path-split\s*—\s*\S/;
const BROWSER_ONLY = /^src\/(air|browser|ui)\//;

/** Every unmarked hand split in `src`, as 1-based line numbers. Pure. */
function unmarked(src: string): number[] {
  const lines = src.split("\n");
  const out: number[] = [];
  for (const m of codeMatches(src, HAND)) {
    const n = src.slice(0, m.index).split("\n").length;
    if (MARK.test(lines[n - 1]!) || MARK.test(lines[n - 2] ?? "")) continue;
    out.push(n);
  }
  return out;
}

Deno.test("path splits: every hand-made shape is seen; prose, strings and marked lines are not", () => {
  const src = [
    'const dir = importerPath.replace(/\\/[^/]+$/, "");', // 1
    'const name = app.slice(app.lastIndexOf("/") + 1);', // 2
    'const first = p.indexOf("/");', // 3
    'const last = p.split("/").pop();', // 4
    'const inside = p.startsWith(root + "/");', // 5
    'const tail = v.endsWith("/" + kt);', // 6
    '// a comment may say p.split("/")', // 7
    'const s = "p.lastIndexOf(\\"/\\")";', // 8
    "// aio-ok: path-split — a URL pathname", // 9
    'const segs = url.pathname.split("/");', // 10
    'const seg = route.split("/"); // aio-ok: path-split — a route', // 11
    "// aio-ok: path-split —", // 12 (no reason)
    'const bare = p.split("/");', // 13
    "const fine = dirname(p);", // 14
  ].join("\n");
  assertEquals(unmarked(src), [1, 2, 3, 4, 5, 6, 13]);
});

function* sources(dir: string): Generator<string> {
  for (const e of Deno.readDirSync(dir)) {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory) yield* sources(path);
    else if (e.isFile && /\.tsx?$/.test(e.name)) yield path;
  }
}

Deno.test("src: no OS path is split on `/` by hand", () => {
  const found: string[] = [];
  const read: string[] = [];
  for (const path of [...sources("src")].sort()) {
    if (BROWSER_ONLY.test(path)) continue;
    read.push(path);
    for (const n of unmarked(Deno.readTextFileSync(path))) {
      found.push(`${path}:${n}`);
    }
  }
  // The walk reached the trees that carry the risk.
  assertEquals(
    ["src/server/graph-validator.ts", "src/build/build-compile.ts"]
      .filter((p) => !read.includes(p)),
    [],
  );
  assertEquals(
    found,
    [],
    "use dirname / basename / relative from @std/path — or, when the value " +
      "is never an OS path, say why: `// aio-ok: path-split — <why>`",
  );
});

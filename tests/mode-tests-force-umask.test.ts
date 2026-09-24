// A permission test must be able to FAIL on the machine that runs it.
//
// A file created with no mode comes out at `0o666 & ~umask`. Under umask 077
// (this dev box's, and many hardened hosts') that is already 0600, so every
// "owner-only" assertion in the suite passed whether or not the code under
// test stated a mode — tests/journal-compaction-perms.test.ts stayed green
// with the journal's `mode: 0o600` deleted. A test that cannot fail proves
// nothing, and the suite never said so.
//
// The ratchet, per TEST (per top-level statement): a test that reads
// permission bits (`mode & 0o…`, or through a helper that does) either runs
// that code under a permissive umask — `permissiveUmask()` from
// ./permissive-umask.ts, or its own `Deno.umask(`, directly or through a
// helper of its file — or says on one line inside it why a umask cannot hide
// the bug: `// aio-ok(umask): <reason>` (e.g. it asserts bits PRESENT, which a
// restrictive umask can only break, never fake; or it chmods the path itself
// first). A marker in the file header covers the whole file. It used to be
// per FILE: one `permissiveUmask(` anywhere cleared every assertion in it.
// `& 0o111` (the executable bit) is presence by construction and not counted.
import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join, relative } from "@std/path";
import { justified } from "../src/diagnostics/ok-marker.ts";

const TESTS = dirname(fromFileUrl(import.meta.url));

/** Reads permission bits: `x.mode & 0o7…`, `(st.mode ?? 0) & 0o…`,
 *  `mode! & 0o777` — any mask except the executable bit. */
const MODE_MASK = /\bmode\b[!)]*\s*(?:\?\?\s*0\s*\)?\s*)?&\s*0o(?!111\b)[0-7]+/;
const FORCES_UMASK = /\bpermissiveUmask\(|\bDeno\.umask\(/;

/** One top-level statement of a test file, with its leading comments. */
type Chunk = { name: string | null; text: string; kind: "file" | "code" };

/** Split `src` at every line that starts a top-level statement (column 0, not
 *  a comment, not a closer). Comments directly above a statement belong to
 *  it; the header and the imports are the FILE region. A named declaration
 *  (`function f`, `const f =`) is a helper the other chunks may call. */
function chunks(src: string): Chunk[] {
  const lines = src.split("\n");
  const starts: number[] = [];
  const isComment = (l: string) => /^\s*(\/\/|\/\*|\*)/.test(l);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l === "" || /^[\s})\]]/.test(l) || isComment(l)) continue;
    let at = i;
    while (at > 0 && isComment(lines[at - 1]!)) at--;
    starts.push(at);
  }
  const out: Chunk[] = [];
  const first = starts[0] ?? lines.length;
  if (first > 0) {
    out.push({
      name: null,
      text: lines.slice(0, first).join("\n"),
      kind: "file",
    });
  }
  starts.forEach((at, k) => {
    const text = lines.slice(at, starts[k + 1] ?? lines.length).join("\n");
    const code = text.split("\n").find((l) => l !== "" && !isComment(l)) ?? "";
    const decl =
      /^(?:export\s+)?(?:async\s+)?(?:function\*?\s+(\w+)|(?:const|let)\s+(\w+)\s*[=:])/
        .exec(code);
    const kind = /^(?:import|export\s+(?:\*|\{)[^=]*\bfrom\b)/.test(code)
      ? "file"
      : "code";
    out.push({ name: decl ? (decl[1] ?? decl[2])! : null, text, kind });
  });
  return out;
}

const marked = (text: string) =>
  text.split("\n").some((l) => justified(l, "umask"));

/** Why `src` would pass under a restrictive umask with the mode forgotten —
 *  one line per test (top-level statement) that reads permission bits
 *  without forcing a permissive umask — or null when none can.
 *
 *  Per TEST, not per file: one `permissiveUmask(` anywhere used to clear
 *  every assertion in the file, so a second test added beside a wrapped one
 *  was green on the bug. A statement is covered when it forces the umask
 *  itself, calls a helper of this file that does (transitively), or carries
 *  an `aio-ok(umask)` marker itself; a marker in the file's header or imports
 *  covers the whole file. A helper that READS bits makes each caller read them. */
export function umaskHole(src: string): string | null {
  if (!MODE_MASK.test(src)) return null;
  const cs = chunks(src);
  if (cs.some((c) => c.kind === "file" && marked(c.text))) return null;
  const helpers = cs.filter((c) => c.name !== null && c.kind === "code");
  const calls = (c: Chunk, names: Set<string>) =>
    [...names].some((n) => new RegExp(`\\b${n}\\(`).test(c.text));
  /** Helpers with `flag`, closed over "calls a helper with `flag`". */
  const closure = (flag: (c: Chunk) => boolean): Set<string> => {
    const set = new Set(helpers.filter(flag).map((c) => c.name!));
    for (let grew = true; grew;) {
      grew = false;
      for (const h of helpers) {
        if (!set.has(h.name!) && calls(h, set)) {
          set.add(h.name!);
          grew = true;
        }
      }
    }
    return set;
  };
  // A marker covers only the statement it sits in: a helper's `aio-ok` was
  // written for that helper's line, never for every test that calls it.
  const forcing = closure((c) => FORCES_UMASK.test(c.text));
  const reading = closure((c) => MODE_MASK.test(c.text));
  const holes = cs.filter((c) =>
    c.kind === "code" &&
    // A helper is judged where it is called; one nobody calls is judged here.
    (c.name === null ||
      !cs.some((o) => o !== c && calls(o, new Set([c.name!])))) &&
    (MODE_MASK.test(c.text) || calls(c, reading)) &&
    !FORCES_UMASK.test(c.text) && !calls(c, forcing) && !marked(c.text)
  ).map((c) => {
    const title = /Deno\.test\(\s*(?:\{\s*name:\s*)?(["'`])(.*?)\1/.exec(c.text)
      ?.[2];
    const line = src.slice(0, src.indexOf(c.text)).split("\n").length;
    return `line ${line}${title ? ` ("${title}")` : ""}`;
  });
  return holes.length === 0
    ? null
    : `asserts a permission mode but never forces a permissive umask: ${
      holes.join(", ")
    }`;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of Deno.readDirSync(dir)) {
    const p = join(dir, e.name);
    if (e.isDirectory) {
      if (e.name !== "fixtures" && e.name !== "node_modules") {
        out.push(...walk(p));
      }
    } else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

Deno.test("mode tests: every permission assertion runs under a umask that can expose a missing mode", () => {
  const holes = walk(TESTS)
    .filter((p) => p !== fromFileUrl(import.meta.url))
    .map((p) => ({ p, why: umaskHole(Deno.readTextFileSync(p)) }))
    .filter((h) => h.why !== null)
    .map((h) => `${relative(TESTS, h.p)}: ${h.why}`);
  assertEquals(
    holes,
    [],
    "wrap the code under test in permissiveUmask() (tests/permissive-umask.ts) " +
      "— under umask 077 a forgotten mode still comes out 0600 and the test " +
      "is green on the bug — or say why it cannot be hidden with " +
      "`// aio-ok(umask): <reason>`:\n  " + holes.join("\n  "),
  );
});

// The instrument, verified: it must see each spelling the suite uses, and
// each way out must be real.
Deno.test("mode tests: the scanner catches every spelling, and only a real way out clears it", () => {
  for (
    const s of [
      "assertEquals((await Deno.stat(p)).mode! & 0o777, 0o600);",
      "assertEquals((st.mode ?? 0) & 0o777, 0o700);",
      "assertEquals(st.mode & 0o077, 0);",
      "const m = Deno.statSync(d).mode & 0o777;",
      "assertEquals(mode & 0o777, 0o700);",
    ]
  ) assert(umaskHole(s), `missed: ${s}`);
  const bare = "assertEquals((st.mode ?? 0) & 0o777, 0o600);";
  const t = (name: string, body: string) =>
    `Deno.test("${name}", async () => {\n  ${body}\n});\n`;
  assertEquals(umaskHole("assert((st.mode! & 0o111) !== 0);"), null);
  assertEquals(
    umaskHole(t("a", `await permissiveUmask(() => ${bare});`)),
    null,
  );
  assertEquals(umaskHole(t("a", `Deno.umask(0o022);\n  ${bare}`)), null);
  assertEquals(
    umaskHole(t("a", `// aio-ok(umask): asserts bits present\n  ${bare}`)),
    null,
  );
  // A marker in the header covers the file; the wrapper may be a helper.
  assertEquals(
    umaskHole(`// aio-ok(umask): asserts bits present\n${t("a", bare)}`),
    null,
  );
  assertEquals(
    umaskHole(
      "async function run(fn: () => Promise<void>) {\n" +
        "  await permissiveUmask(fn);\n}\n" +
        t("a", `await run(async () => { ${bare} });`),
    ),
    null,
  );
  // PER TEST: one wrapped test does not clear its unwrapped neighbour —
  // the hole the per-file ratchet had.
  const mixed = umaskHole(
    t("wrapped", `await permissiveUmask(() => ${bare});`) + t("bare", bare),
  );
  assert(mixed?.includes('("bare")'), `missed the unwrapped test: ${mixed}`);
  assert(!mixed?.includes('("wrapped")'), `blamed the wrapped one: ${mixed}`);
  // A helper that READS bits makes its (unwrapped) caller a mode test.
  assert(
    umaskHole(
      `const modeOf = (p: string) => Deno.statSync(p).mode! & 0o777;\n` +
        t("a", "assertEquals(modeOf(p), 0o600);"),
    ),
  );
  // A marker addressed to another gate, or with no reason, is not one — and
  // a helper's marker does not cover its callers.
  assert(umaskHole(t("a", `// aio-ok(sanitizers): x\n  ${bare}`)));
  assert(umaskHole(t("a", `// aio-ok\n  ${bare}`)));
  assert(
    umaskHole(
      "function tmp() {\n  // aio-ok: a short /tmp path\n  return 1;\n}\n" +
        t("a", `tmp();\n  ${bare}`),
    ),
  );
});

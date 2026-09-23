// Every line `am` prints goes through ONE sanitizing sink (`am-output.ts`:
// `say`/`sayErr`/`sayStream`, `out`/`outError`; `sayData` for JSON a script
// parses). A raw `console.log` elsewhere in `src/am/` is how lock-file text
// (an appId, a home, a socket path) reached the terminal unfiltered in
// `am instances` after the lock stopped cleaning it on read. This makes the
// whole class red rather than each site a review comment.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { mask } from "../scripts/source-mask.ts";

const AM = join(import.meta.dirname!, "..", "src", "am");

/** Every way `am` code could reach the terminal around the sinks. Run over
 *  the MASKED source (comments, strings and template TEXT blanked; regex
 *  literals skipped whole; `${…}` holes kept as code), so generated code
 *  inside a scaffold template is not a hit and a backtick inside a regex
 *  literal cannot derail the scan — the hand-rolled tracker this replaced
 *  lost 94% of am-cmd-process.ts to one `/[`…]/`. `console` in ANY form
 *  (`console.log`, `globalThis.console.log`, `const { log } = console`,
 *  `console["log"]`) and `Deno.stdout`/`Deno.stderr` for anything but
 *  `.isTerminal()`. */
const RAW = [
  /\bconsole\b/g,
  /\bDeno\s*\.\s*std(?:out|err)\b(?!\s*\.\s*isTerminal\s*\()/g,
  // `Deno` handed on as a VALUE — `const { stdout } = Deno`, `const d =
  // Deno; d.stdout…` — nothing after it can be followed, so the alias itself
  // is the hit.
  /\bDeno\b(?!\s*(?:[.[]|\?\.))/g,
];

/** `globalThis['console']`, `Deno["stdout"]`: the NAME is a string, which the
 *  mask blanks — so the bracket is found in the masked copy (code, not text)
 *  and the name read from the original at the same offset. */
const BRACKET = /\b(?:globalThis|window|self|Deno)\s*\[\s*['"`]/g;
const BRACKET_RAW =
  /^(?:(?:globalThis|window|self)\s*\[\s*(['"`])console\1|Deno\s*\[\s*(['"`])std(?:out|err)\2)\s*\]/;

/** The raw uses in `src`, as `line  text` — pure, so its blind spots are
 *  testable (below). A line that says `aio-ok: raw` is exempt. */
export function rawUses(src: string): string[] {
  const masked = mask(src);
  const lines = src.split("\n");
  const hits = new Set<number>();
  const line = (at: number) => masked.slice(0, at).split("\n").length;
  for (const re of RAW) {
    for (const m of masked.matchAll(re)) hits.add(line(m.index));
  }
  for (const m of masked.matchAll(BRACKET)) {
    if (BRACKET_RAW.test(src.slice(m.index))) hits.add(line(m.index));
  }
  return [...hits].sort((x, y) => x - y)
    .filter((n) => !/aio-ok: raw/.test(lines[n - 1] ?? ""))
    .map((n) => `${n}  ${lines[n - 1]!.trim()}`);
}

Deno.test("am output: no raw console/stdout use outside the sanitizing sinks", () => {
  const found: string[] = [];
  for (const e of Deno.readDirSync(AM)) {
    if (!e.isFile || !e.name.endsWith(".ts") || e.name === "am-output.ts") {
      continue;
    }
    const src = Deno.readTextFileSync(join(AM, e.name));
    for (const h of rawUses(src)) found.push(`src/am/${e.name}:${h}`);
  }
  assertEquals(found, [], "route these through the sinks in am-output.ts");
});

// The scanner's own blind spots, pinned: each spelling, and each region the
// old tracker lost (after a backtick in a regex literal, a template's `${}`
// hole), must be found; template TEXT and comments must not.
Deno.test("rawUses: every spelling, in every region; never in text", () => {
  const code = [
    "const SHELL = /[`$]/;", // the regex that derailed the old tracker
    "console.log(1);",
    "globalThis.console.error(2);",
    "const { log } = console;",
    'console["log"](3);',
    "await Deno.stdout.write(b);",
    "const w = Deno.stderr.writable;",
    "const t = `x ${console.log(4)} y`;",
    'const gen = `console.log("generated")`;', // template TEXT: not code
    "// console.log in a comment",
    "if (Deno.stdout.isTerminal()) f();",
    "console.log(5); // aio-ok: raw — a reason",
    "globalThis['console'].log(6);", // 13
    'await Deno["stdout"].write(b);', // 14
    "const { stdout } = Deno;", // 15
    "const d = Deno;", // 16
    "const k = Deno['env'];", // an unrelated bracket read: not a hit
    "if (Deno?.build) f();",
    "const t2 = `globalThis['console']`;", // template TEXT: not code
    "return /x`/.test(s) ? 1 : console.log(7);", // 20: after `return`
    "if (ok) /`/.test(s); console.log(8);", // 21: after an if head
    "const h = b++ / 2; console.log(9); const j = c / 3;", // 22: postfix
  ].join("\n");
  assertEquals(rawUses(code).map((h) => Number(h.split(" ")[0])), [
    2,
    3,
    4,
    5,
    6,
    7,
    8,
    13,
    14,
    15,
    16,
    20,
    21,
    22,
  ]);
});

// …and end to end on the surface that leaked: `am instances --long` prints a
// lock's appId, home and cwd in a table. Planted escapes, bidi overrides and
// zero-width characters never reach the terminal; the table's own colours do.
Deno.test("am instances --long: lock text in the table is printable", async () => {
  const { writeLock, removeLock, lockKey } = await import(
    "../src/server/single-instance-lock.ts"
  );
  const { cmdInstances } = await import("../src/am/am-cmd-process.ts");
  const id = `pr-${crypto.randomUUID().slice(0, 8)}`;
  const home = `/tmp/h\x1b]0;pwn\x07‮​`;
  writeLock({
    appId: id,
    pid: Deno.pid,
    port: 1,
    startedAt: Date.now(),
    status: "started",
    cwd: "/c\x1b[2J",
    home,
  });
  const said: string[] = [];
  const [log, err, tty] = [console.log, console.error, Deno.stdout.isTerminal];
  console.log = (...a: unknown[]) => said.push(a.join(" "));
  console.error = (...a: unknown[]) => said.push(a.join(" "));
  Deno.stdout.isTerminal = () => true; // the pretty path — what a person sees
  try {
    cmdInstances([], { long: true });
  } finally {
    console.log = log;
    console.error = err;
    Deno.stdout.isTerminal = tty;
    removeLock(lockKey(id, home));
  }
  const text = said.join("\n");
  assert(text.includes(id), text);
  const bad = new RegExp(
    "\\x1b(?!\\[[0-9;]*m)|\\x07|[\\u202a-\\u202e\\u2066-\\u2069\\u200b-\\u200f\\ufeff]",
  );
  assert(!bad.test(text), JSON.stringify(text));
});

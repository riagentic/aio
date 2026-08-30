// Every line aio prints must say what it IS.
//
// A user pasted their app's output and asked the question the output could not
// answer:
//
//     [aio:vitals] PRESSURE — 40 broadcasts/sec (threshold: 30/sec)
//
//   "aio:vitals, what is it, should it be fixed or is it just info? It's
//    unclear."
//
// It was `console.warn` — no timestamp, no level, no category, and absent from
// app.log/warning.log entirely, because console output only reaches a file when
// something happens to be capturing stdout. Sitting in the middle of the
// framework's own levelled log, it read as neither info nor error: just text.
//
// The rule, and this test: framework runtime code writes through the LOGGER, so
// every message carries info / warn / error. Info = nothing to do. Warn =
// should be fixed. Error = must be fixed. Nothing prints without one.
import { assert, assertEquals } from "@std/assert";
import { codeText } from "../src/diagnostics/code-mask.ts";

const REPO = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

/** Server-side runtime: everything here has a logger and must use it. */
const RUNTIME_FOLDERS = [
  "server",
  "state",
  "vitals",
  "diagnostics",
  "electron",
  "protocol",
  "db",
  "sync",
];

/** The only console writers left, each for a reason that survives review. */
const ALLOWED = new Map<string, string>([
  [
    "src/diagnostics/logger-format.ts",
    "IS the console sink — the one place allowed to print directly",
  ],
  [
    "src/diagnostics/logger-core.ts",
    "the logger reporting that it cannot write its own files",
  ],
  // Same class, one level up: the last-words handler's log sink is INJECTED,
  // and the branch below only runs because that sink threw while reporting a
  // crash. Routing the fallback through a logger would be routing it through
  // the thing that just failed — and losing the crash is the one outcome this
  // file exists to prevent.
  [
    "src/diagnostics/crash-handler.ts",
    "the crash reporter reporting that the logger threw while reporting a crash",
  ],
  // The Electron trio below emit the MAIN-PROCESS script as a string. That
  // code runs in Electron's Node, which has no `log` — a bulk conversion that
  // rewrote them turned the reconnect path into a ReferenceError, so a backend
  // restart never reconnected and the window sat there empty. Generated code
  // uses the console it actually has.
]);

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory) yield* walk(path);
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) yield path;
  }
}

Deno.test("output: runtime code never prints without a level", async () => {
  const offenders: string[] = [];
  for (const folder of RUNTIME_FOLDERS) {
    for await (const path of walk(`${REPO}/src/${folder}`)) {
      const rel = path.slice(REPO.length + 1);
      if (ALLOWED.has(rel)) continue;
      const raw = await Deno.readTextFile(path);
      // Read CODE, not the strings inside it. These files GENERATE JavaScript
      // as template literals — an Electron main.cjs, a browser script tag —
      // and every `console.log` in those templates runs in the page or the
      // renderer, not here. Matching raw text could not tell them apart, so
      // five whole files were allowlisted to silence them: ~1,500 lines of
      // real Deno-side code exempted to hide 20 prints that were never this
      // process's. `codeText` preserves offsets, so line numbers still point
      // where they did.
      const text = codeText(raw);
      const lines = text.split("\n");
      const rawLines = raw.split("\n");
      lines.forEach((line, i) => {
        // A mention inside a comment is documentation, not a print.
        const code = line.replace(/^\s*(\/\/|\*).*$/, "");
        // A LINE-level opt-out, same shape as `// aio-ok: server-only`. The
        // allowlist above exempts a whole FILE, which is too blunt for a file
        // that legitimately owns one raw write among hundreds of levelled
        // ones — the stdout a machine-readable mode must not pollute, say.
        // The reason has to be written down, so the exemption is reviewable.
        const near = rawLines.slice(Math.max(0, i - 6), i + 1).join("\n");
        if (/\/\/\s*aio-ok:/.test(near)) return;
        if (
          /(?<![\w.])console\.(log|info|warn|error|debug|group)\s*\(/.test(code)
        ) {
          offenders.push(`${rel}:${i + 1}  ${line.trim().slice(0, 90)}`);
        }
      });
    }
  }
  assertEquals(
    offenders,
    [],
    `these print without a level — use log.info / log.warn / log.error so the ` +
      `reader knows whether to act, and so the line reaches app.log:\n  ` +
      offenders.join("\n  "),
  );
});

Deno.test("output: the allowlist is real — every entry still exists and still prints", async () => {
  // An allowlist that outlives its reason is a hole. Each entry must still be a
  // file that still contains a console call; otherwise it is deleted, not kept
  // "just in case".
  for (const [rel, reason] of ALLOWED) {
    const text = await Deno.readTextFile(`${REPO}/${rel}`).catch(() => null);
    assert(text !== null, `${rel} is allowlisted but does not exist`);
    assert(
      /console\.(log|info|warn|error|debug|group)\s*\(/.test(text!),
      `${rel} no longer prints to console — remove it from the allowlist (${reason})`,
    );
  }
});

Deno.test("output: the vitals pressure line says what it means", async () => {
  // The line that prompted this: a number and a threshold, with no statement of
  // whether anything is wrong. A reader has to be able to decide, from the line
  // alone, whether to act.
  const src = await Deno.readTextFile(
    `${REPO}/src/vitals/pressure-monitor.ts`,
  );
  assert(
    /advisory threshold/.test(src),
    "the pressure summary must say it is advisory, not just report a number",
  );
  assert(
    /Nothing is broken/.test(src),
    "…and say plainly that nothing is broken, since the level alone cannot",
  );
  assert(
    /log\.warn\(/.test(src),
    "…and go through the logger, so it carries a level and lands in warning.log",
  );
});

Deno.test("output: pressure is reported on the EDGES, not once a second", async () => {
  // Eighteen identical lines in a row is one condition, not eighteen findings —
  // and a line repeated every second is how a reader learns to skim past the
  // one that matters.
  const src = await Deno.readTextFile(
    `${REPO}/src/vitals/pressure-monitor.ts`,
  );
  assert(
    /_overSince/.test(src) && /rate-clear/.test(src),
    "the monitor must report entering AND leaving pressure, and stay quiet in between",
  );
});

Deno.test("output: the log API stays browser-safe", async () => {
  // The migration put `log` into modules that ship to the page (state, sync,
  // protocol). The API module must therefore reach NOTHING Deno-only: one
  // `import type { AioLogger }` was enough to pull `logger-core` — and with it
  // `@std/path`, an unmapped bare specifier — into the browser graph, which is
  // a blank screen for an app without a deno.json. `logger-api` depends on the
  // LogSink shape instead; only the server ever names the class.
  const seen = new Set<string>();
  const queue = [`${REPO}/src/diagnostics/logger-api.ts`];
  const bare: string[] = [];
  while (queue.length > 0) {
    const path = queue.pop()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const text = await Deno.readTextFile(path);
    for (const m of text.matchAll(/from\s*["']([^"']+)["']/g)) {
      const spec = m[1]!;
      if (spec.startsWith(".")) {
        queue.push(new URL(spec, `file://${path}`).pathname);
      } else if (!spec.startsWith("node:")) {
        bare.push(`${spec} (via ${path.slice(REPO.length + 1)})`);
      }
    }
  }
  assertEquals(
    bare,
    [],
    "the browser-served log API must have no bare imports",
  );
  assert(
    ![...seen].some((p) => p.endsWith("logger-core.ts")),
    "logger-api must not reach logger-core — even a type-only import counts, " +
      "because the browser-deps walker cannot tell the difference and the " +
      "bundler does not need to be wrong for the gate to be right",
  );
});

Deno.test("output: no logger call is buried in generated code", async () => {
  // The other half of the allowlist above. A file that BUILDS a script as a
  // string is two languages in one file, and a rewrite that cannot tell them
  // apart puts a `log.warn` into code that will run somewhere `log` does not
  // exist — where it is not a bad log line, it is a ReferenceError in the
  // middle of whatever the generated code was doing. This walks the template
  // literals themselves rather than trusting the reviewer's eye.
  const offenders: string[] = [];
  for (const folder of [...RUNTIME_FOLDERS, "build", "am", "browser", "air"]) {
    const dir = `${REPO}/src/${folder}`;
    if (!await Deno.stat(dir).then((s) => s.isDirectory).catch(() => false)) {
      continue;
    }
    for await (const path of walk(dir)) {
      const text = await Deno.readTextFile(path);
      if (!text.includes("log.") || !text.includes("`")) continue;
      for (const [start, end] of templateSpans(text)) {
        const seg = text.slice(start, end);
        if (/(?<![\w.])log\.(warn|error|info|debug|trace)\s*\(/.test(seg)) {
          offenders.push(
            `${path.slice(REPO.length + 1)}:${
              text.slice(0, start).split("\n").length
            }`,
          );
        }
      }
    }
  }
  assertEquals(
    offenders,
    [],
    `a logger call sits inside a generated-code template — the runtime that ` +
      `executes that string has no \`log\`:\n  ${offenders.join("\n  ")}`,
  );
});

/** Rough span scanner for top-level template literals (skips strings and
 *  comments, and does not descend into `${…}`, which IS local code). */
function templateSpans(s: string): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < s.length && s[i] !== q) i += s[i] === "\\" ? 2 : 1;
      i++;
      continue;
    }
    if (c === "/" && s[i + 1] === "/") {
      const j = s.indexOf("\n", i);
      i = j < 0 ? s.length : j + 1;
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      const j = s.indexOf("*/", i);
      i = j < 0 ? s.length : j + 2;
      continue;
    }
    if (c === "`") {
      const start = i;
      i++;
      let depth = 0;
      while (i < s.length) {
        if (s[i] === "\\") {
          i += 2;
          continue;
        }
        if (s[i] === "$" && s[i + 1] === "{") {
          depth++;
          i += 2;
          continue;
        }
        if (s[i] === "}" && depth > 0) {
          depth--;
          i++;
          continue;
        }
        if (s[i] === "`" && depth === 0) break;
        i++;
      }
      out.push([start, Math.min(i, s.length)]);
      i++;
      continue;
    }
    i++;
  }
  return out;
}

/** The CLI half of the same rule.
 *
 *  `am` and the build print to the console directly and SHOULD — a command's
 *  output is its answer, not a log line, and `am state --json` must stay
 *  machine-readable. But a DIAGNOSTIC among that output has the same duty as a
 *  log line: say whether the reader has to act. These are the markers that do
 *  it — a symbol, or the word itself.
 *
 *  `▸` and `✓` are in the set because they answer the question too, with a
 *  "no": they are this repo's established step and success markers (see
 *  `scripts/lab.ts`, `scripts/wine-pipe.ts`, `src/am/am-cmd-lab.ts`), and a
 *  long-running command writes its PROGRESS to stderr precisely so stdout
 *  stays machine-readable. A step line that says "this is a step" has told
 *  the reader what they need; what this gate exists to catch is the
 *  unmarked sentence that could equally be a failure.
 *
 *  `${NO}` / `${HEY}` / `${OK}` / `${NOTE}` count as the glyphs they ARE.
 *  They are the house glyph constants (src/diagnostics/fmt.ts) — the same
 *  `✗ ! ✓ ·`, coloured through the one decider — and the point of routing a
 *  glyph through a constant is that it stops being a literal in the source.
 *  A gate that cannot see them would push authors to write the character
 *  twice: once for the reader, once for the test. */
const CLI_MARKERS =
  /✗|✘|⚠|✖|❌|▸|✓|\$\{(NO|HEY|OK|NOTE)\}|\bmark\(|\berror\b|\bErrors?\b|\bwarn(ing)?\b|\bnote:|\bhint:|\busage:|\bfailed\b|\bcannot\b|\bnot found\b|\brefus/i;

Deno.test("output: a CLI diagnostic says whether you have to act", async () => {
  // Scanned: the first STRING LITERAL of each console.warn/error call. A call
  // whose argument is a variable is relaying something already formatted
  // (subprocess output, a message built elsewhere) and is not judged here.
  const offenders: string[] = [];
  const roots = [`${REPO}/src/am`, `${REPO}/src/build`];
  const files: string[] = [];
  for (const r of roots) for await (const p of walk(r)) files.push(p);
  for await (const e of Deno.readDir(`${REPO}/src`)) {
    if (e.isFile && e.name.endsWith(".ts")) files.push(`${REPO}/src/${e.name}`);
  }
  for (const path of files) {
    const rel = path.slice(REPO.length + 1);
    const text = await Deno.readTextFile(path);
    for (const m of text.matchAll(/(?<![\w.])console\.(warn|error)\(\s*/g)) {
      const j = m.index! + m[0].length;
      const q = text[j];
      if (q !== '"' && q !== "'" && q !== "`") continue; // relayed, not authored
      let k = j + 1;
      while (k < text.length && text[k] !== q) k += text[k] === "\\" ? 2 : 1;
      // Source-level escapes are how these symbols are written in the file
      // (`\u2717`), so decode before judging — otherwise the gate reads a
      // marked line as unmarked and everyone learns to add a second marker.
      const lit = text.slice(j + 1, k).replace(
        /\\u([0-9a-fA-F]{4})/g,
        (_, h) => String.fromCharCode(parseInt(h, 16)),
      );
      // A continuation line of a block whose head carried the marker: it is
      // indented on purpose, and re-marking every line of a paragraph is noise.
      if (/^\s{2}/.test(lit) || lit.trim() === "") continue;
      if (!CLI_MARKERS.test(lit)) {
        offenders.push(
          `${rel}:${text.slice(0, m.index).split("\n").length}  ${
            lit.slice(0, 60)
          }`,
        );
      }
    }
  }
  assertEquals(
    offenders,
    [],
    `these print a diagnostic that does not say what it is — add ✗ / ⚠ / ` +
      `"warning:" / "note:" so the reader knows whether to act:\n  ` +
      offenders.join("\n  "),
  );
});

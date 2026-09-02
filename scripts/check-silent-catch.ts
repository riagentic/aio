#!/usr/bin/env -S deno run --allow-read
// check-silent-catch.ts — the swallowed-error budget.
//
// "Fail loud, never silent" is the project's first rule, and 375 `catch {}`
// blocks in src/ whose entire body is a comment (or nothing) are the largest
// single contradiction of it. Each one is a place where a failure was decided
// to be uninteresting — sometimes correctly (a probe for a file that may not
// exist, a best-effort cleanup on a path already being torn down) and
// sometimes because writing the error handler was more work than not.
//
// There are far too many to have each been justified against that rule one at
// a time, and a sweep that "fixed" all of them would be 375 unreviewed
// behaviour changes. So they are made COUNTABLE and SHRINKING instead:
//
//   • A swallow that has been thought about carries `// aio-ok: <reason>` in
//     the catch body — the SAME convention the repo already uses for
//     `// aio-ok: server-only` (server/graph-validator.ts). It stops counting.
//   • Everything else counts against CEILING, which may only ever go DOWN.
//
// Under the ceiling is a failure too, with the new number to paste in. A
// ratchet that is allowed to sit above the real count is just a ceiling, and a
// ceiling rots.
import { codeText } from "../src/diagnostics/code-mask.ts";

/** The number of UNJUSTIFIED silent catches allowed in `src/`.
 *
 *  Only ever edit this DOWNWARD. To lower it, justify a swallow in place:
 *
 *      } catch {
 *        // aio-ok: the lock dir may already be gone — this is the teardown
 *        // path and its absence is the outcome we want.
 *      }
 *
 *  …or make the failure loud (log it with a level, or let it propagate). */
// 372 → 345 when the scan learned to read CODE only: 27 of the counted
// "silent catches" were the pattern quoted inside a string or a comment, so
// the ratchet had been permitting 27 more real ones than anybody agreed to. A
// ceiling measured on the wrong thing is a ceiling that rots upward.
const CEILING = 339;

const ROOT = new URL("../src/", import.meta.url).pathname;

async function walk(dir: string, out: string[]): Promise<string[]> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}${e.name}`;
    if (e.isDirectory) await walk(`${p}/`, out);
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

/** A catch whose body holds no STATEMENT — only comments, or nothing at all.
 *  Bodies containing braces are skipped by construction (they hold code). */
const SILENT_CATCH = /catch\s*(?:\([^)]*\))?\s*\{([^{}]*)\}/g;

/** The acknowledgement marker, matched the way graph-validator matches its
 *  own: `aio-ok` followed by a reason. A bare `aio-ok` with nothing after it
 *  is not an acknowledgement, it is a mute button. */
const JUSTIFIED = /\baio-ok\b\s*[:\-—]\s*\S/;

type Hit = { file: string; line: number };

const files = (await walk(ROOT, [])).sort();
const unjustified: Hit[] = [];
let justified = 0;

for (const file of files) {
  const raw = await Deno.readTextFile(file);
  // MATCH on code only. Four of the counted "silent catches" were prose — one
  // of them a comment explaining why a bare `catch {}` had been a bug — so the
  // ceiling permitted four more real ones than anybody had agreed to. `aiol`
  // and `am pin` already read source through this mask; a ratchet that cannot
  // tell code from a sentence about code is measuring the wrong thing.
  //
  // `codeText` preserves length and newlines, so offsets (and therefore line
  // numbers) are unchanged — and the BODY is sliced from `raw`, because the
  // `// aio-ok:` justification lives in a comment the mask blanks. Matching on
  // masked text while reading the original is what keeps both true.
  const src = codeText(raw);
  SILENT_CATCH.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SILENT_CATCH.exec(src))) {
    // The body is the capture group; locate it by its own length from the
    // match's end rather than by the first `{` — a destructured binding
    // (`catch ({ message })`) puts a `{` before the body.
    const end = m.index + m[0].length - 1;
    const body = raw.slice(end - m[1]!.length, end);
    const code = body
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "")
      .trim();
    if (code !== "") continue; // it handles something
    if (JUSTIFIED.test(body)) {
      justified++;
      continue;
    }
    unjustified.push({
      file: file.slice(ROOT.length),
      line: src.slice(0, m.index).split("\n").length,
    });
  }
}

const n = unjustified.length;
const verbose = Deno.args.includes("--list");
if (verbose) {
  for (const h of unjustified) console.log(`  src/${h.file}:${h.line}`);
}

if (n > CEILING) {
  const fresh = unjustified.slice(-(n - CEILING));
  console.error(
    `✗ ${n} unjustified silent catch blocks in src/ (ceiling ${CEILING}).\n` +
      `  A catch that swallows an error must say why it is allowed to:\n` +
      `      } catch {\n` +
      `        // aio-ok: <why this failure is uninteresting here>\n` +
      `      }\n` +
      `  …or make the failure loud (log it with a level, or let it throw).\n` +
      `  Run with --list to see all of them. Recently added, most likely:\n` +
      fresh.map((h) => `      src/${h.file}:${h.line}`).join("\n"),
  );
  Deno.exit(1);
}
if (n < CEILING) {
  console.error(
    `✗ ${n} unjustified silent catch blocks — below the ceiling of ${CEILING}.\n` +
      `  Good. Lower CEILING to ${n} in scripts/check-silent-catch.ts so the\n` +
      `  ground you just gained cannot be given back.`,
  );
  Deno.exit(1);
}
console.log(
  `✓ silent catches: ${n} unjustified (ceiling ${CEILING}), ` +
    `${justified} justified with \`aio-ok:\``,
);

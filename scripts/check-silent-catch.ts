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
// 339 → 337 when the six per-client `socket.send` swallows in the CRDT relay
// (`sync/server-handler.ts`) became one `sendTo` that names the frame it could
// not deliver, and the five harness swallows in `src/testing/` were either
// made loud or justified in place.
const CEILING = 335;

/** The budget for the PROMISE spelling, counted separately.
 *
 *  Separately because the two are one rule but not one number: folding 102
 *  pre-existing swallows into `CEILING` would move it upward, and this file's
 *  own contract is that it only ever moves down. Two ratchets, both falling. */
const HANDLER_CEILING = 95;

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

/** The SAME swallow, spelled as a promise handler: `.catch(() => {})`,
 *  `.catch((e) => {})`, `.then(ok, () => {})`.
 *
 *  The block form's regex cannot see these at all — its optional `(...)` group
 *  eats `(()` and then the required `{` lands on `=`. So 102 swallows in
 *  `src/` were outside the budget entirely, concentrated exactly where they
 *  hurt: `updates-apply.ts`, `electron-runtime-fetch.ts`, `blobs.ts`. This is
 *  the class the CRDT relay recurred in — `browser-sync.ts` records that every
 *  sync frame once ended in `.catch(() => {})`, which together meant "the CRDT
 *  layer could fail continuously while the app showed a clean console and
 *  stale data". A ratchet that cannot measure the spelling a bug came back in
 *  is not measuring the rule. */
const SILENT_HANDLER =
  /\.(?:catch|then)\s*\(\s*(?:[A-Za-z_$][\w$]*\s*,\s*)?(?:\(\s*[\w$]*\s*\)|[\w$]+)\s*=>\s*\{([^{}]*)\}\s*\)/g;

/** The acknowledgement marker, matched the way graph-validator matches its
 *  own: `aio-ok` followed by a reason. A bare `aio-ok` with nothing after it
 *  is not an acknowledgement, it is a mute button. */
const JUSTIFIED = /\baio-ok\b\s*[:\-—]\s*\S/;

export type Hit = { file: string; line: number };

/** What one file contributes to the two budgets.
 *
 *  Exported and pure so the gate can be tested on text instead of only on the
 *  repo: a scanner whose blind spot is exactly the thing it exists to find has
 *  happened here once already — the block-form regex could not see
 *  `.catch(() => {})` at all, so 102 swallows sat outside the budget. A gate
 *  with no test of its own is the "verify the instrument" trap wearing a
 *  ratchet. */
export function scanSource(
  raw: string,
): { blocks: number[]; handlers: number[]; justified: number } {
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
  const blocks: number[] = [];
  const handlers: number[] = [];
  let justified = 0;
  for (
    const [re, into] of [
      [SILENT_CATCH, blocks],
      [SILENT_HANDLER, handlers],
    ] as [RegExp, number[]][]
  ) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      // The body is the capture group; locate it by its own length from the
      // last `}` of the match rather than by the first `{` — a destructured
      // binding (`catch ({ message })`) puts a `{` before the body, and the
      // handler form ends in `})` rather than `}`.
      const end = m.index + m[0].lastIndexOf("}");
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
      into.push(src.slice(0, m.index).split("\n").length);
    }
  }
  return { blocks, handlers, justified };
}

const files = import.meta.main ? (await walk(ROOT, [])).sort() : [];
const unjustified: Hit[] = [];
const unjustifiedHandlers: Hit[] = [];
let justified = 0;

for (const file of files) {
  const raw = await Deno.readTextFile(file);
  const r = scanSource(raw);
  const rel = file.slice(ROOT.length);
  for (const line of r.blocks) unjustified.push({ file: rel, line });
  for (const line of r.handlers) unjustifiedHandlers.push({ file: rel, line });
  justified += r.justified;
}

const verbose = Deno.args.includes("--list");

/** Report one budget. Both directions are a failure: over the ceiling is a
 *  regression, under it is ground gained that must be nailed down, because a
 *  ratchet allowed to sit above the real count is just a ceiling, and a
 *  ceiling rots. */
function report(
  hits: Hit[],
  ceiling: number,
  what: string,
  name: string,
  fix: string,
): boolean {
  const n = hits.length;
  if (verbose) {
    for (const h of hits) {
      console.log(`  src/${h.file}:${h.line}`);
    }
  }
  if (n > ceiling) {
    console.error(
      `✗ ${n} unjustified ${what} in src/ (ceiling ${ceiling}).\n` +
        fix +
        `  Run with --list to see all of them. Recently added, most likely:\n` +
        hits.slice(-(n - ceiling)).map((h) => `      src/${h.file}:${h.line}`)
          .join("\n"),
    );
    return false;
  }
  if (n < ceiling) {
    console.error(
      `✗ ${n} unjustified ${what} — below the ceiling of ${ceiling}.\n` +
        `  Good. Lower ${name} to ${n} in scripts/check-silent-catch.ts so\n` +
        `  the ground you just gained cannot be given back.`,
    );
    return false;
  }
  return true;
}

if (import.meta.main) {
  const blocksOk = report(
    unjustified,
    CEILING,
    "silent catch blocks",
    "CEILING",
    `  A catch that swallows an error must say why it is allowed to:\n` +
      `      } catch {\n` +
      `        // aio-ok: <why this failure is uninteresting here>\n` +
      `      }\n` +
      `  …or make the failure loud (log it with a level, or let it throw).\n`,
  );
  const handlersOk = report(
    unjustifiedHandlers,
    HANDLER_CEILING,
    "silent promise handlers",
    "HANDLER_CEILING",
    `  \`.catch(() => {})\` swallows exactly as much as \`catch {}\` does:\n` +
      `      .catch(() => {\n` +
      `        // aio-ok: <why this failure is uninteresting here>\n` +
      `      })\n` +
      `  …or make the failure loud (log it with a level, or let it reject).\n`,
  );
  if (!blocksOk || !handlersOk) Deno.exit(1);
  console.log(
    `✓ silent catches: ${unjustified.length} block${
      unjustified.length === 1 ? "" : "s"
    } (ceiling ${CEILING}) + ${unjustifiedHandlers.length} promise handler${
      unjustifiedHandlers.length === 1 ? "" : "s"
    } (ceiling ${HANDLER_CEILING}), ${justified} justified with \`aio-ok:\``,
  );
}

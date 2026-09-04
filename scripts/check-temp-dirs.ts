#!/usr/bin/env -S deno run --allow-read
// check-temp-dirs.ts — the unswept-temp-directory budget.
//
// `src/testing/temp-dir.ts` opens with a claim: "ONE decider for 'this test
// needs a throwaway directory' … every directory made through here is
// registered, and the registry is swept when the process exits." The sweep
// works. Almost nothing goes through it — 807 direct `Deno.makeTempDir` calls
// across 348 test files the day this gate landed, most in files that never
// import `temp-dir.ts` at all. Their directories are never registered and
// never swept, which is what `deno task check:orphans` counts (and what it was
// red on, at 963 abandoned directories against a ceiling of 400).
//
// A directory removed on the happy path only is removed most of the time. The
// test that throws, the assertion that fails, the `await using` nobody wrote —
// each skips its own cleanup, and one measured developer machine had 5,612
// leftover `/tmp/aio-*` dirs holding 4.3 GB.
//
// There are far too many to convert in one sweep, and a mass rewrite of 348
// test files would be 348 unreviewed changes to test setup. So they are made
// COUNTABLE and SHRINKING instead, the shape `check-silent-catch` and
// `check-vacuous` already use:
//
//   • Use the decider — `tempDir(prefix)` / `tempDirSync(prefix)` from
//     `src/testing/temp-dir.ts`, or `keepTempDir(d)` for a directory that came
//     from somewhere else. Those do not count.
//   • A direct call that genuinely must not be registered says so in place
//     with the repo's acknowledgement convention, on the line or the one above:
//         // aio-ok: this test INSPECTS /tmp and must not see the registry's.
//   • Everything else counts against CEILING, which may only ever go DOWN.
//
// Under the ceiling is a failure too, with the new number to paste in: a
// ratchet allowed to sit above the real count is just a ceiling, and a ceiling
// rots.
//
//   deno task check:tempdirs           report (exit 1 if the budget moved)
//   deno task check:tempdirs --list    every counted call, file:line
import { codeText } from "../src/diagnostics/code-mask.ts";

/** Unregistered temp-directory creations allowed in `tests/`.
 *
 *  Only ever edit this DOWNWARD. To lower it, convert calls to
 *  `tempDir()`/`tempDirSync()` and drop the matching `Deno.remove` from the
 *  happy path (the exit sweep is the net, `dropTempDir` the polite version). */
const CEILING = 793;

const ROOT = new URL("../tests/", import.meta.url).pathname;

/** `Deno.makeTempDir(…)` and its sync twin — the calls that bypass the
 *  registry. `makeTempFile` is deliberately NOT counted: a file is not a
 *  directory tree, and `check-orphans` counts directories. */
const DIRECT_CALL = /\bDeno\.makeTempDir(?:Sync)?\s*\(/g;

/** The acknowledgement marker, matched as every other gate matches it: a bare
 *  `aio-ok` with nothing after it is not an acknowledgement, it is a mute
 *  button. */
const JUSTIFIED = /\baio-ok\b\s*[:\-—]\s*\S/;

export type Hit = { file: string; line: number };

/** What one file contributes to the budget — line numbers of the direct calls
 *  that are neither routed through the decider nor justified in place.
 *
 *  Pure and exported so the gate can be tested on TEXT rather than only on the
 *  repo. A scanner whose blind spot is exactly the thing it exists to find has
 *  happened in this repo before; a gate with no test of its own is the "verify
 *  the instrument" trap wearing a ratchet. */
export function scanSource(raw: string): { hits: number[]; justified: number } {
  // Match on CODE only — this file's own doc comment says `Deno.makeTempDir`
  // several times, and a gate that cannot tell code from a sentence about code
  // is measuring the wrong thing.
  const src = codeText(raw);
  const lines = raw.split("\n");
  const hits: number[] = [];
  let justified = 0;
  DIRECT_CALL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DIRECT_CALL.exec(src))) {
    const line = src.slice(0, m.index).split("\n").length;
    // The justification lives in a comment, which the mask blanks — so read it
    // from the ORIGINAL text, on this line or the one above it.
    const here = lines[line - 1] ?? "";
    const above = lines[line - 2] ?? "";
    if (JUSTIFIED.test(here) || JUSTIFIED.test(above)) {
      justified++;
      continue;
    }
    hits.push(line);
  }
  return { hits, justified };
}

async function walk(dir: string, out: string[]): Promise<string[]> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}${e.name}`;
    if (e.isDirectory) await walk(`${p}/`, out);
    else if (e.name.endsWith(".ts") || e.name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

if (import.meta.main) {
  const files = (await walk(ROOT, [])).sort();
  const hits: Hit[] = [];
  let justified = 0;
  for (const file of files) {
    const r = scanSource(await Deno.readTextFile(file));
    const rel = file.slice(ROOT.length);
    for (const line of r.hits) hits.push({ file: rel, line });
    justified += r.justified;
  }
  if (Deno.args.includes("--list")) {
    for (const h of hits) console.log(`  tests/${h.file}:${h.line}`);
  }
  const n = hits.length;
  const fix = `  Use the ONE decider so the directory is swept even when the ` +
    `test throws:\n` +
    `      import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";\n` +
    `      const dir = await tempDir("my-test-");   // …and dropTempDir(dir) when done\n` +
    `  A call that must NOT be registered says why in place:\n` +
    `      // aio-ok: this test reads /tmp and must not see the registry's dirs\n`;
  if (n > CEILING) {
    console.error(
      `✗ ${n} unregistered temp dirs in tests/ (ceiling ${CEILING}).\n` + fix +
        `  Run with --list to see all of them. Recently added, most likely:\n` +
        hits.slice(-(n - CEILING)).map((h) => `      tests/${h.file}:${h.line}`)
          .join("\n"),
    );
    Deno.exit(1);
  }
  if (n < CEILING) {
    console.error(
      `✗ ${n} unregistered temp dirs in tests/ — below the ceiling of ${CEILING}.\n` +
        `  Good. Lower CEILING to ${n} in scripts/check-temp-dirs.ts so the\n` +
        `  ground you just gained cannot be given back.`,
    );
    Deno.exit(1);
  }
  console.log(
    `✓ temp dirs: ${n} unregistered (ceiling ${CEILING})` +
      (justified ? `, ${justified} justified` : "") +
      `; the rest go through src/testing/temp-dir.ts`,
  );
}

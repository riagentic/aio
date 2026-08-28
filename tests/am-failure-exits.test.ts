// `am` is scripted against — `am create x && cd x`, `am health && deploy`,
// `am lab && open …` — so a command that prints `error: …` and then hands the
// shell a SUCCESS is worse than saying nothing: the `&&` proceeds.
//
// `src/am/am-output.ts` already draws the line and says why it exists: the two
// halves "used to be written separately at every call site", and while most
// wrote `outError(…); Deno.exit(1)` — correct, if verbose — `am create`,
// `am new` and `am log` wrote `outError(…); return`, printing a refusal and
// then reporting success. `am create x && cd x` cd'd into a directory that was
// never made.
//
// Nothing kept that fixed, and `am lab` had drifted back into it: the branch
// where the container's viewer never answers printed through `outError` and
// returned — ENDING the command, which is exactly what `outError` alone is not
// for — three lines below a sibling branch that used `fail`.
//
// Narrow on purpose. `outError(…); Deno.exit(1)` is the idiom throughout this
// folder and it is correct: it reports and it exits. The bug is the bare
// `return`. A `return` carrying a VALUE is also fine — that hands a result to
// a caller which decides, and `am state`'s poll loop does exactly that so a
// transient error does not kill a watch.
import { assertEquals } from "@std/assert";
import { codeText } from "../src/diagnostics/code-mask.ts";

Deno.test("am: nothing prints an error and then exits 0", async () => {
  const offenders: string[] = [];
  for await (const e of Deno.readDir("src/am")) {
    if (!e.name.endsWith(".ts")) continue;
    // Read code, not prose — am-output.ts describes this pattern in order to
    // forbid it, and a doc comment is not a call site.
    const lines = codeText(await Deno.readTextFile(`src/am/${e.name}`))
      .split("\n");
    lines.forEach((line, i) => {
      if (!/\boutError\s*\(/.test(line)) return;
      // Look only as far as the end of the enclosing block. Scanning further
      // finds the `);` of some later, unrelated call and reads whatever
      // follows THAT — which is how a first draft of this test reported three
      // correct `outError(…); Deno.exit(1)` sites as bugs.
      const indent = /^\s*/.exec(line)![0].length;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j]!;
        if (!l.trim()) continue;
        const at = /^\s*/.exec(l)![0].length;
        if (at < indent) break; // left the block
        if (/\bDeno\.exit\s*\(/.test(l) || /\bfail\s*\(/.test(l)) break; // ends
        if (/^\s*return\s*;\s*$/.test(l)) {
          offenders.push(`src/am/${e.name}:${i + 1}`);
          break;
        }
      }
    });
  }
  assertEquals(
    offenders,
    [],
    "`outError(…)` then a bare `return` ends the command with exit 0 after " +
      "printing a failure — use `fail(…)`, which does both as one act:\n  " +
      offenders.join("\n  "),
  );
});

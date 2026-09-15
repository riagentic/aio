// Every flag `am help` advertises must survive the central flag gate.
//
// `unknownFlags` refuses anything not in `VERB_FLAGS`, and it runs BEFORE the
// command. So a flag the help text documents and the command fully implements
// dies at the door with "unknown flag" — which reads as "aio does not have
// this", about a feature aio does have and tells you about.
//
// Six were in that state:
//
//   am state <path> --watch      documented at am-help-text:145, implemented
//                                in am-cmd-state.ts (with its own comment
//                                about accepting it on either side of the
//                                path), refused by the gate.
//   am shot --selector=          documented :222, implemented :117
//   am shot --update=            documented :224, implemented :134
//   am shot --check=             documented :225, implemented :131
//   am shot --threshold=         documented :227
//   am shot --max-diff=          documented :228
//
// `--update`/`--check` ARE visual regression testing; without them `shot` is a
// screenshot button. The documented `am state --watch` agent loop was
// unreachable too.
//
// The two existing tests around that table pin "every gated verb refuses
// --zzz" (`am-answers-are-true`) and "every verb appears in the table"
// (`am-surface-rects`). Neither can see the OTHER direction — a flag the
// command implements and the table omits — which is this file.
import { assertEquals } from "@std/assert";
import { HELP_TEXT } from "../src/am/am-help-text.ts";
import { unknownFlags, VERB_FLAGS } from "../src/am/am-flags.ts";

/** Every `<verb> … --flag` pair the help text advertises.
 *
 *  A help LINE starts with the verb; the lines under it, indented further, are
 *  its continuation — and that is where `--threshold` and `--max-diff` live,
 *  so a scan that only reads the first line of each block misses exactly the
 *  flags most likely to be forgotten. A line that starts a NEW verb ends the
 *  previous block, so a flag is never attributed to the wrong command. */
function advertised(): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  let current: string | null = null;
  for (const line of HELP_TEXT.split("\n")) {
    const head = /^\s{2}([a-z][a-z-]*)\b(.*)$/.exec(line);
    if (head) {
      current = head[1]! in VERB_FLAGS ? head[1]! : null;
    } else if (!/^\s{3,}\S/.test(line)) {
      // A blank line, or a heading — the block is over.
      current = null;
      continue;
    }
    if (!current) continue;
    for (const f of line.matchAll(/(--[a-z][a-z-]*)/g)) {
      let set = out.get(current);
      if (!set) out.set(current, set = new Set());
      set.add(f[1]!);
    }
  }
  return out;
}

/** Flags the help text MENTIONS under a verb without offering them to it.
 *
 *  `shot` and `eval` both explain that the app "must run with `--cdp`" — that
 *  is a flag of `am restart`, named where you need to know about it. Listed
 *  here rather than loosening the scan, so adding a prose mention is a
 *  deliberate line rather than a hole: the whole point of this gate is that a
 *  flag in the help text is reachable, and a scan that quietly drops what it
 *  cannot classify would be the same silence one level up.
 */
const PROSE_ONLY: Record<string, readonly string[]> = {
  shot: ["--cdp"],
  eval: ["--cdp"],
  // migrate's block points at aiol's rewriter; migrate itself does not take it.
  migrate: ["--safe-fix"],
};

Deno.test("am: every flag the help text offers is accepted by the gate", () => {
  const claims = advertised();
  const refused: string[] = [];
  for (const [verb, flags] of claims) {
    for (const flag of flags) {
      // Both spellings, because help writes `--out=x` and `--full` alike.
      if ((PROSE_ONLY[verb] ?? []).includes(flag)) continue;
      const bad = unknownFlags(verb, [flag, `${flag}=x`]);
      if (bad.length) refused.push(`am ${verb} ${flag}`);
    }
  }
  assertEquals(
    refused,
    [],
    "the help text offers a flag the central gate kills before the command " +
      "runs — which reads as `aio does not have this` about a feature it " +
      "documents:\n  " + refused.join("\n  "),
  );
});

// The scan is the load-bearing part: one that finds nothing passes forever,
// which is how six documented flags stayed unreachable.
Deno.test("am: the help scan actually finds the flags it is meant to check", () => {
  const claims = advertised();
  const total = [...claims.values()].reduce((n, s) => n + s.size, 0);
  assertEquals(
    total > 15,
    true,
    `the scan must see the help text's flags — it found ${total}`,
  );
  // …and the six that were refused are among them, by name.
  assertEquals(claims.get("state")?.has("--watch"), true);
  for (
    const f of [
      "--selector",
      "--update",
      "--check",
      "--threshold",
      "--max-diff",
    ]
  ) {
    assertEquals(claims.get("shot")?.has(f), true, `shot ${f}`);
  }
});

// A named constant declared in two files, at the same value, is one fact with
// two homes — and the second home is the one nobody remembers to edit.
//
// This is the repo's most-cited trap ("one fact, one spelling"), and the
// existing gate for it counts LITERALS. It cannot see this shape, because the
// duplicate is a NAME: `WS_MAX_QUEUE = 100` in protocol-types.ts and again in
// cli-client.ts, `KILL_POLL_MS = 100` in am and again in the server lock,
// `THROTTLE_MS = 2000` twice in vitals. Each pair was genuinely one fact, and
// each would have drifted the first time someone tuned one of them.
//
// Same name + DIFFERENT value is left alone: `MAX_DEPTH` is 12 for a timeline
// and 32 for a deep merge, and those are two facts that happen to share a
// noun. It is the matching values that betray a copy.
import { assertEquals } from "@std/assert";
import { codeMask } from "../src/diagnostics/code-mask.ts";

/** Pairs that really are two facts whose values coincide today. */
const ACKNOWLEDGED = new Set<string>([
  // (empty — every pair found so far was a copy)
]);

/** Every `.ts` under `src/` — a local walk, so this gate adds no dependency. */
async function* srcFiles(dir = "src"): AsyncGenerator<string> {
  for await (const e of Deno.readDir(dir)) {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory) yield* srcFiles(path);
    else if (e.name.endsWith(".ts")) yield path;
  }
}

Deno.test("no constant is declared twice at the same value", async () => {
  const decls = new Map<string, { file: string; value: string }[]>();
  const RE =
    /^(?:export\s+)?const\s+([A-Z][A-Z0-9_]{3,})\s*(?::[^=]+)?=\s*([^;\n]+);/gm;
  for await (const file of srcFiles()) {
    const src = await Deno.readTextFile(file);
    const mask = codeMask(src);
    for (const m of src.matchAll(RE)) {
      // A `const` inside a template literal belongs to generated code.
      if (mask[m.index!] !== 1) continue;
      const list = decls.get(m[1]!) ?? [];
      list.push({ file, value: m[2]!.trim() });
      decls.set(m[1]!, list);
    }
  }
  const dupes: string[] = [];
  for (const [name, list] of decls) {
    if (list.length < 2 || ACKNOWLEDGED.has(name)) continue;
    // Group by value: only the files that AGREE are a suspected copy.
    const byValue = new Map<string, string[]>();
    for (const d of list) {
      byValue.set(d.value, [...(byValue.get(d.value) ?? []), d.file]);
    }
    for (const [value, files] of byValue) {
      if (files.length > 1) {
        dupes.push(`${name} = ${value} in ${files.join(" + ")}`);
      }
    }
  }
  assertEquals(
    dupes.sort(),
    [],
    "one fact with two homes — export it from one and import it, or add the " +
      "name to ACKNOWLEDGED saying why the match is a coincidence:\n  " +
      dupes.join("\n  "),
  );
});

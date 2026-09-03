// The preset table in docs/ui/air-animation.md, checked against the presets.
//
// That table claimed `slide` was `translateY(-20px) → 0` and `scale` was
// `0.95 → 1` while src/air/transition.ts had produced `translateY(100%)` and
// `scale(0)` for releases. Prose cannot be type-checked and nothing else reads
// it, so the drift was invisible: a reader picked a preset by a description of
// an animation the framework does not play.
//
// The fix that makes the class unshippable is to derive the claim from the
// code — call each preset's own `css(t)` at both endpoints and require every
// value it produces to appear in that preset's row.
import { assert } from "@std/assert";
import { fade, scale, slide } from "../src/air/transition.ts";
import type { TransitionFn } from "../src/air/transition.ts";

const DOC = new URL("../docs/ui/air-animation.md", import.meta.url);
const PRESETS: Record<string, TransitionFn> = { fade, slide, scale };

/** The `prop: value` pairs one preset paints at `t`. */
function declarations(fn: TransitionFn, t: number): string[] {
  // deno-lint-ignore no-explicit-any
  const node = {} as any;
  const css = fn(node, {}).css;
  assert(css, "preset lost its css() — the table below describes nothing");
  return css(t, 1 - t).split(";").map((d) => d.trim()).filter(Boolean);
}

Deno.test("air-animation.md's preset table matches what the presets paint", async () => {
  const lines = (await Deno.readTextFile(DOC)).split("\n");
  // Count what was actually compared. A preset that paints nothing, or a
  // `declarations()` that stops parsing, would leave the loop below with
  // nothing to assert and this test green about a table it never read.
  let checked = 0;
  const presets = Object.entries(PRESETS);
  assert(presets.length >= 3, `only ${presets.length} presets found in code`);
  for (const [name, fn] of presets) {
    const row = lines.find((l) =>
      l.startsWith("|") && l.includes(`\`${name}\``) && l.includes("→")
    );
    assert(row, `no table row for \`${name}\` in air-animation.md`);
    for (const t of [0, 1]) {
      const decls = declarations(fn, t);
      assert(
        decls.length > 0,
        `\`${name}\` painted no CSS at t=${t} — the preset or the parser broke`,
      );
      for (const decl of decls) {
        checked++;
        const value = decl.slice(decl.indexOf(":") + 1).trim();
        assert(
          row.includes(value),
          `air-animation.md's \`${name}\` row does not mention "${value}", ` +
            `which is what \`${name}\` paints at t=${t} (\`${decl}\`). ` +
            `Rewrite the row from src/air/transition.ts.\n  row: ${row}`,
        );
      }
    }
  }

  assert(
    checked >= presets.length * 2,
    `only ${checked} declarations compared across ${presets.length} presets`,
  );

  // The defaults the same section states, also from the code.
  const text = lines.join("\n");
  const duration = fade({} as never, {}).duration;
  assert(
    text.includes(`\`duration\` (default \`${duration}\`)`),
    `the stated default duration is not ${duration}ms — the presets changed`,
  );
});

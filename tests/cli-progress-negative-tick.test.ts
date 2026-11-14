// cli-progress-negative-tick.test.ts — `progress().tick(-k)` clamps at 0.
//
// tick() clamped only the top; a negative step took n below zero and the TTY
// bar's `"#".repeat(negative)` threw a RangeError out of the progress bar.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { testIO } from "../src/cli/io.ts";
import { progress } from "../src/cli/output.ts";

Deno.test("progress: a negative tick clamps at 0 instead of throwing", () => {
  for (const tty of [true, false]) {
    const io = testIO({ tty });
    const p = progress(10, { io, label: "copy" });
    p.tick(3);
    p.tick(-5);
    p.tick(-1);
    const out = io.stderr + io.stdout;
    assertStringIncludes(out, "0/10");
    assertEquals(out.includes("-2/10"), false, out);
    p.done();
  }
});

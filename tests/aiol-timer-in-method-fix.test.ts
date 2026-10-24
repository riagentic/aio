// A timer INSIDE a cell method is the same finding as one at boot, but the
// boot-time fixes (`onStart: () => x.m()`, `schedules:`, `onInit`) are wrong
// there: `onStart` runs the action ONCE AT BOOT, not N ms after this call — a
// developer following the fix literally ships a different program. The door
// in a method is its own effect channel: `s.$do(schedule.after(…))`.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { checkTimerDispatch } from "../aiol/checks.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function issues(src: string) {
  const dir = await tempDir("aiol-timer-method-");
  try {
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1.0.0" } }),
    );
    await Deno.writeTextFile(join(dir, "src", "cell.ts"), src);
    const { ctx, report } = await buildContext(dir);
    await checkTimerDispatch(ctx);
    return report.issues.filter((i) => i.message.includes("from a timer"));
  } finally {
    await dropTempDir(dir);
  }
}

const SRC = `import { cell } from "aio";
export const other = cell("other", {
  state: { n: 0 },
  methods: { ping(s) { s.n++; } },
});
export const todo = cell("todo", {
  state: { n: 0 },
  methods: {
    clear(s) { s.n = 0; },
    tick(s) {
      setTimeout(() => todo.clear(), 100);
      s.n++;
    },
    poke(s) {
      setTimeout(() => other.ping(), 100);
      s.n++;
    },
  },
});
export function boot() {
  setTimeout(() => todo.clear(), 0);
}
`;

Deno.test("aiol timer: inside a method the fix is the method's schedule, not onStart", async () => {
  const found = await issues(SRC);
  assertEquals(found.length, 3, JSON.stringify(found));
  const [own, peer, boot] = found.sort((a, b) => a.line! - b.line!);
  assertEquals(
    own!.fix,
    `s.$do(schedule.after("todo.clear", N, self("clear")))`,
  );
  assert(!own!.message.includes("onStart"), own!.message);
  assertEquals(
    peer!.fix,
    `s.$do(schedule.after("todo.ping", N, other.ping.action()))`,
  );
  // Module code keeps the boot doors.
  assertEquals(boot!.fix, "onStart: () => todo.clear()");
});

// `connectCli().subscribe(fn)` "fires immediately if state exists" — and
// `watch()` draws the first frame itself. Scheduled, that replay was a SECOND
// identical frame: on a pipe (`todo list --watch | tee log`) every watch
// started with the list printed twice (measured on the compiled example).
import { assertEquals, assertThrows } from "@std/assert";
import { testIO, watch } from "../src/cli.ts";

/** The connectCli shape: replays current state synchronously on subscribe. */
function replaying() {
  const subs = new Set<() => void>();
  return {
    subs,
    subscribe(fn: () => void) {
      subs.add(fn);
      fn(); // "fires immediately if state exists"
      return () => subs.delete(fn);
    },
  };
}

Deno.test("cli watch: a source that replays on subscribe draws ONE first frame", async () => {
  const src = replaying();
  const io = testIO({ tty: false });
  let v = "a";
  const w = watch(src, () => v, { io });
  await Promise.resolve();
  assertEquals(io.stdout, "a\n", "one frame, not the replay too");
  v = "b";
  for (const fn of src.subs) fn();
  await Promise.resolve();
  assertEquals(io.stdout, "a\nb\n", "a real change still redraws");
  w.stop();
  assertEquals(src.subs.size, 0);
});

Deno.test("cli watch: a first frame that throws leaves nothing subscribed, cursor restored", () => {
  const src = replaying();
  const io = testIO({ tty: true });
  assertThrows(
    () =>
      watch(src, () => {
        throw new Error("render bug");
      }, { io }),
    Error,
    "render bug",
  );
  assertEquals(src.subs.size, 0);
  assertEquals(io.stdout.endsWith("\x1b[?25h"), true);
});

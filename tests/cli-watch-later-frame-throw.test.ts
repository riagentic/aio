// cli-watch-later-frame-throw.test.ts — a watch() frame after the first that
// throws restores the terminal, as a first-frame throw always did.
//
// The scheduled redraw ran in a bare queueMicrotask: the throw escaped as an
// uncaught error (the process dies) with the cursor still hidden, the SIGINT
// listener registered and the source still subscribed.
import { assert, assertEquals } from "@std/assert";
import { testIO, watch } from "../src/cli.ts";

Deno.test("a later watch() frame that throws cleans up, then rethrows", async () => {
  const io = testIO({ tty: true });
  let fire: () => void = () => {};
  let unsubscribed = 0;
  const source = {
    subscribe(fn: () => void) {
      fire = fn;
      return () => void unsubscribed++;
    },
  };
  let n = 0;
  let uncaught: unknown;
  const onErr = (e: ErrorEvent) => {
    uncaught = e.error;
    e.preventDefault();
  };
  globalThis.addEventListener("error", onErr);
  try {
    const w = watch(source, () => {
      if (n++ > 0) throw new Error("render broke on frame 2");
      return "frame 1";
    }, { io });
    fire();
    await new Promise((r) => setTimeout(r, 20));
    // Still loud: the error is not swallowed.
    assert(uncaught instanceof Error, "expected the throw to propagate");
    const out = io.stdout;
    assert(
      out.lastIndexOf("\x1b[?25h") > out.lastIndexOf("\x1b[?25l"),
      `cursor left hidden: ${JSON.stringify(out)}`,
    );
    assertEquals(unsubscribed, 1);
    // stop() after the cleanup is a no-op: no second unsubscribe, no output.
    const before = io.stdout.length;
    w.stop();
    assertEquals(unsubscribed, 1);
    assertEquals(io.stdout.length, before);
    // A change after the cleanup draws nothing.
    fire();
    await new Promise((r) => setTimeout(r, 5));
    assertEquals(io.stdout.length, before);
  } finally {
    globalThis.removeEventListener("error", onErr);
  }
});

Deno.test("watch(): unload while the view is up shows the cursor; after stop() it does not", () => {
  const io = testIO({ tty: true });
  const source = { subscribe: () => () => {} };
  const w = watch(source, () => "x", { io });
  const shown = () => io.stdout.split("\x1b[?25h").length - 1;
  assertEquals(shown(), 0);
  dispatchEvent(new Event("unload"));
  assertEquals(shown(), 1, "unload with the view up must restore the cursor");
  w.stop();
  assertEquals(shown(), 2);
  dispatchEvent(new Event("unload"));
  assertEquals(shown(), 2, "the unload listener outlived stop()");
});

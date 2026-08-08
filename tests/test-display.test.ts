// GUI tests must not open windows on the developer's desktop.
//
// A window that appears mid-keystroke and takes focus makes the suite
// unrunnable while you work — so it gets run less, which is the real cost. The
// containment is a nested X server, and the load-bearing part is that it is
// LONG-LIVED: a harness that starts and kills one per run reproduces the exact
// flicker it was built to remove. Tests never stop it; the user does.
import { assert, assertEquals } from "@std/assert";
import {
  _resetTestDisplay,
  AIO_TEST_DISPLAY,
  displayIsUp,
  testDisplay,
  testDisplayEnv,
} from "../src/testing/test-display.ts";

function withEnv(vars: Record<string, string | null>, fn: () => void): void {
  const prev = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(vars)) {
    prev.set(k, Deno.env.get(k));
    if (v === null) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
  _resetTestDisplay();
  try {
    fn();
  } finally {
    for (const [k, v] of prev) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    _resetTestDisplay();
  }
}

Deno.test("testDisplay: an explicit AIO_TEST_DISPLAY always wins", () => {
  // CI with Xvfb, a remote X display, a user who already runs their own nested
  // session — none of them want us starting a second server.
  withEnv({ AIO_TEST_DISPLAY: ":99" }, () => {
    assertEquals(testDisplay(), ":99");
    assertEquals(testDisplayEnv(), { DISPLAY: ":99" });
  });
});

Deno.test("testDisplay: cached — the answer cannot usefully change mid-run", () => {
  withEnv({ AIO_TEST_DISPLAY: ":98" }, () => {
    assertEquals(testDisplay(), ":98");
    Deno.env.set("AIO_TEST_DISPLAY", ":97");
    assertEquals(
      testDisplay(),
      ":98",
      "re-probing per window is the cost this avoids",
    );
  });
});

Deno.test("displayIsUp: reads the X socket, spawns nothing", () => {
  // A probe process per call is how a helper earns a reputation for being slow
  // and gets skipped.
  assert(!displayIsUp(":4242"), "a display nobody started is not up");
  // :0 exists on a desktop session and not in a headless container — assert the
  // SHAPE (it answers, it does not throw), never the machine's configuration.
  assertEquals(typeof displayIsUp(":0"), "boolean");
});

Deno.test("testDisplayEnv: empty when there is nothing to contain", () => {
  // A headless box has no DISPLAY at all; spreading `{}` into a child's env
  // must stay safe rather than setting DISPLAY="".
  withEnv({ AIO_TEST_DISPLAY: null, DISPLAY: null }, () => {
    if (Deno.build.os !== "linux") {
      assertEquals(testDisplayEnv(), {});
      return;
    }
    const env = testDisplayEnv();
    // Either a nested display was found/started, or we degraded to nothing —
    // never an empty-string DISPLAY, which breaks X clients in a confusing way.
    if ("DISPLAY" in env) assert(env.DISPLAY.length > 0);
  });
});

Deno.test("the test display is a FIXED number, not an allocated one", () => {
  // Stability is the feature: it is what lets a human start one Xephyr in the
  // morning and have every later run find it instead of opening its own.
  assert(/^:\d+$/.test(AIO_TEST_DISPLAY));
  assert(
    AIO_TEST_DISPLAY !== ":0" && AIO_TEST_DISPLAY !== ":1",
    "must not collide with a real session",
  );
});

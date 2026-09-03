// Teardown that eats its own failures is how a harness manufactures a green
// test.
//
// CLAUDE.md, verbatim: "Tests are the STRICTEST environment, never the most
// permissive." Three swallows in `src/testing/` broke that from the inside —
// not by letting a test pass, but by hiding the fact that the world under it
// never came down:
//
//   • `testApps.close()` caught a link's `close()` and dropped it, so a client
//     still reconnecting on a backoff timer leaked into the next test with
//     nothing said (and the app closes after it were skipped or not, depending
//     on which throw won).
//   • `testServer.close()` wrapped "flush the logger, then DETACH it" in one
//     catch, so a flush that failed also skipped the detach — re-opening the
//     exact hole ("[logger] write failed for …/.aio/logs" into a deleted
//     directory) that block exists to close.
//   • `testBrowser`'s kill swallowed everything as "already exited", so a
//     browser this harness genuinely failed to kill — the orphaned-chrome leak
//     its `unload` backstop exists to prevent — was indistinguishable from the
//     ordinary case.
//
// Each is asserted here from the OUTSIDE: force the failure, then check the
// harness says so.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { cell } from "../mod.ts";
import { testApps } from "../src/cell-test.ts";
import {
  findChromium,
  testBrowser,
  testServer,
} from "../src/testing/server-test.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";

/** Capture `console.error` for the duration of `fn`. */
async function withCapturedErrors(
  fn: () => Promise<void>,
): Promise<string[]> {
  const lines: string[] = [];
  const prev = console.error;
  console.error = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.error = prev;
  }
  return lines;
}

Deno.test("testApps.close(): a link that cannot be closed is reported, not swallowed", async () => {
  const notes = cell("teardown-notes", {
    state: { n: 0 },
    methods: {
      bump(s: { n: number }) {
        s.n++;
      },
    },
  });
  const world = await testApps({ svc: { cells: [notes] } });
  const link = world.connect("svc");
  // Close for real — the reconnect timer and the WS must still go away, or
  // this test leaks the very thing it is about — and THEN fail, the way a
  // half-broken close would.
  const realClose = link.close.bind(link);
  link.close = () => {
    realClose();
    throw new Error("link close boom");
  };

  const err = await assertRejects(
    () => world.close(),
    AggregateError,
    "teardown step(s) failed",
  );
  assertEquals(
    (err as AggregateError).errors.map((e) => (e as Error).message),
    ["link close boom"],
  );
  // The rest of the world came down anyway — a failing link must not strand a
  // booted app on a bound port.
  assertEquals(world.apps.length, 1);
  assertEquals(
    await fetch(`${world.apps[0]!.url}/`).then(() => "up").catch(() => "down"),
    "down",
    "the app was closed despite the link failure",
  );
});

Deno.test("testServer.close(): a sink whose flush rejects is reported AND still detached", async () => {
  const c = cell("teardown-counter", { state: { n: 0 }, methods: {} });
  const srv = await testServer({ cells: [c] });
  const prev = getLogger();
  const evil = {
    logDir: "/nonexistent",
    flush: () => Promise.reject(new Error("flush boom")),
  } as unknown as LogSink;
  // The app's OWN shutdown detaches the singleton (`aio-cells-bridge.ts`), so
  // the sink has to be installed after that and before the harness's detach —
  // which is exactly the window this block exists for: a logger some OTHER
  // app in the process left attached, pointed at the directory about to be
  // deleted.
  const realAppClose = srv.app.close.bind(srv.app);
  srv.app.close = async () => {
    await realAppClose();
    setLogger(evil);
  };
  try {
    const errors = await withCapturedErrors(() => srv.close());
    assertEquals(
      getLogger(),
      null,
      "the logger is detached even though the flush failed — the app's " +
        "directory has just been deleted out from under it",
    );
    assert(
      errors.some((l) => l.includes("flush boom")),
      `the flush failure was said out loud: ${JSON.stringify(errors)}`,
    );
  } finally {
    setLogger(prev);
  }
});

Deno.test({
  name:
    "testBrowser: a kill that genuinely fails is reported; an already-dead child is not",
  ignore: findChromium() === null,
  async fn() {
    // (1) The ordinary case: the tab already exited, so `kill()` throws
    //     "child process has already terminated". That is not news.
    const quiet = await testBrowser("about:blank");
    quiet.proc.kill();
    await quiet.proc.status;
    const quietErrors = await withCapturedErrors(() => quiet.close());
    assertEquals(
      quietErrors.filter((l) => l.includes("could not kill")),
      [],
      "an already-exited browser is the normal path, not a report",
    );

    // (2) The leak: `kill()` fails for any other reason. The process really is
    //     killed here (or `close()` would wait on `proc.status` forever), but
    //     the harness is told the kill did not happen — which is exactly the
    //     shape of an orphaned browser.
    const loud = await testBrowser("about:blank");
    const realKill = loud.proc.kill.bind(loud.proc);
    Object.defineProperty(loud.proc, "kill", {
      configurable: true,
      value: () => {
        realKill();
        throw new Error("EPERM: operation not permitted");
      },
    });
    const loudErrors = await withCapturedErrors(() => loud.close());
    assert(
      loudErrors.some((l) =>
        l.includes("could not kill the browser") && l.includes("EPERM")
      ),
      `a browser that could not be killed is reported: ${
        JSON.stringify(loudErrors)
      }`,
    );
  },
});

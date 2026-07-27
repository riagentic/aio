// llama.md #4 + the "Evil" section: the in-process harnesses printed
//   "[aio] own effects are ignored in standalone/test mode"
// and moved on. So a test that boots and disposes cells — precisely where a
// leaked or misfiring resource should surface — could not see one, and the
// own-key-reuse trap (#3) stayed invisible until it hit production. That breaks
// aio's own rule: tests are the STRICTEST environment, never the most permissive.
//
// Now `own` runs for real in the harness: acquire, replace-by-key, dispose on
// teardown — with a dev warning when a replace disposes a live resource.
import { assert, assertEquals } from "@std/assert";
import { cell, own } from "../mod.ts";
import { bootCells } from "../src/testing/cell-test.ts";

const events: string[] = [];

const srv = cell("own-harness", {
  state: { started: 0 },
  methods: {
    start(s: { started: number }) {
      s.started++;
      const id = `srv-${s.started}`;
      return own.set("server", () => {
        events.push(`acquire:${id}`);
        return () => events.push(`dispose:${id}`);
      });
    },
    // Same key on purpose — this is the shape that SIGTERMed a freshly started
    // server in the field report.
    restartSameKey(s: { started: number }) {
      s.started++;
      return own.set("server", () => {
        events.push("acquire:second");
        return () => events.push("dispose:second");
      });
    },
  },
});

Deno.test("own: the harness really acquires and disposes", async () => {
  events.length = 0;
  {
    await using _h = await bootCells([srv]);
    await srv.start();
    assert(
      events.includes("acquire:srv-1"),
      `the factory must run in-process, not be ignored: ${events.join(",")}`,
    );
    assertEquals(
      events.filter((e) => e.startsWith("dispose")).length,
      0,
      "nothing disposed while the handle is alive",
    );
  }
  // Handle disposed → the resource must be released. A test that leaves a
  // watcher or child process running is the bug this catches.
  assert(
    events.includes("dispose:srv-1"),
    `teardown must dispose owned resources: ${events.join(",")}`,
  );
});

Deno.test("own: re-using a key disposes the previous resource, and says so", async () => {
  events.length = 0;
  // The framework logger falls back to console; capture every level so the
  // assertion is about the MESSAGE reaching a developer, not about a sink.
  const warnings: string[] = [];
  const orig = {
    warn: console.warn,
    error: console.error,
    log: console.log,
    info: console.info,
  };
  for (const k of ["warn", "error", "log", "info"] as const) {
    console[k] = (...a: unknown[]) => warnings.push(a.map(String).join(" "));
  }
  try {
    await using _h = await bootCells([srv]);
    await srv.start();
    await srv.restartSameKey();
    assertEquals(
      events,
      ["acquire:srv-1", "dispose:srv-1", "acquire:second"],
      "same key ⇒ the previous resource is disposed BEFORE the new one is " +
        "acquired — the semantics that turned a restart into a SIGTERM",
    );
  } finally {
    Object.assign(console, orig);
  }
  const said = warnings.join("\n");
  assert(
    /own: 'server' was already held/.test(said),
    `dev must name the key being replaced; got: ${said || "(silence)"}`,
  );
});

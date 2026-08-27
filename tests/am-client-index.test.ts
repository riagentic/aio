// The "client index" is a MONOTONIC COUNTER, not a list position.
//
// `am surface 0` is taught in CLAUDE.md and three docs. After one page reload
// the app's only UI client is index 6, and `am surface 0` answers
// `client 0 not connected (connected: 6, 7)`. Before that reload index 0 was
// usually the dev server's `browser-reload` socket — connected, counted, and
// with no UI on it, so the request sat there until it timed out five seconds
// later blaming the app's "main thread". Meanwhile `am trigger` REQUIRED the
// index that `am surface` did not, so the documented observe → act → observe
// loop was wrong at every second step.
//
// The rule now: no index = the newest UI client, for both commands, and an
// index that is given is checked against the roster BEFORE anything is sent.
import { assert, assertEquals } from "@std/assert";
import { chooseUiClient } from "../src/am/am-cmd-inspect.ts";

const ROSTER = [
  { index: 0, type: "browser-reload", transport: "ws" },
  { index: 6, type: "browser", transport: "ws" },
  { index: 7, type: "browser", transport: "ws" },
];

Deno.test("chooseUiClient: no index drives the NEWEST UI client", () => {
  assertEquals(chooseUiClient(ROSTER, undefined), { index: 7 });
  // …and skips the reload socket even when it is the only thing connected.
  assertEquals(chooseUiClient([ROSTER[0]!], undefined), { index: null });
  // Nothing connected at all: a caller decides (surface renders headlessly).
  assertEquals(chooseUiClient([], undefined), { index: null });
});

Deno.test("chooseUiClient: a stale index is refused by name, not by timeout", () => {
  const r = chooseUiClient(ROSTER, 0);
  assertEquals(r.index, null);
  // The reason: it IS connected, it is just not a UI.
  assert(r.error!.includes("browser-reload"), r.error);
  assert(r.error!.includes("UI clients: 6 (browser), 7 (browser)"), r.error);
  assert(r.error!.includes("NO index"), r.error);

  const gone = chooseUiClient(ROSTER, 3);
  assertEquals(gone.index, null);
  assert(gone.error!.includes("not connected"), gone.error);
  // Names what IS there, so the caller self-corrects without another call.
  assert(gone.error!.includes("6 (browser)"), gone.error);
  // …and explains why the number they were taught is wrong.
  assert(gone.error!.includes("counter"), gone.error);
});

Deno.test("chooseUiClient: an explicit UI index is honoured", () => {
  assertEquals(chooseUiClient(ROSTER, 6), { index: 6 });
  // An electron UDS client is a UI client too.
  assertEquals(
    chooseUiClient([{ index: 2, type: "electron", transport: "uds" }], 2),
    { index: 2 },
  );
  // …and its reload twin is not.
  assertEquals(
    chooseUiClient([{ index: 2, type: "electron-reload" }], undefined),
    { index: null },
  );
});

// `am logs --lines=N` sliced the file's last N TEXT LINES, so a tail that
// happened to end inside a stack trace or an error box began mid-frame: no
// timestamp, no level, no message. The multi-line entries are exactly the ones
// worth reading, so the default view was most broken where it mattered most.
Deno.test("groupLogEvents: --lines counts EVENTS, not text lines", async () => {
  const { groupLogEvents } = await import("../src/am/am-cmd-inspect.ts");
  const lines = [
    "2026-08-26 23:31:50.755  INFO   aio         started",
    "2026-08-26 23:31:51.001  ERROR  aio         boom",
    "    at foo (file:///a.ts:1:1)",
    "    at bar (file:///b.ts:2:2)",
    "┏━━ AioError ━━",
    "┃ code: BUDGET_EFFECT",
    "┗━━",
    "2026-08-26 23:31:52.000  INFO   aio         done",
  ];
  const events = groupLogEvents(lines);
  assertEquals(events.length, 3, "three entries, not eight lines");
  // The error keeps its stack AND its box — one event.
  assertEquals(events[1]!.length, 6);
  // The last TWO events are whole: the old slice(-2) started at "at bar".
  const tail = events.slice(-2).flat();
  assert(tail[0]!.includes("ERROR"), `starts at an event: ${tail[0]}`);
  assert(tail.at(-1)!.includes("done"), tail.at(-1));
  // The client log's bracketed stamp is an event start too.
  assertEquals(
    groupLogEvents(["[t] [INFO ] [client:0] a", "[t] [ERROR] [client:0] b"])
      .length,
    2,
  );
  // A file that begins mid-event keeps that fragment rather than losing it.
  assertEquals(groupLogEvents(["    at foo", "    at bar"]).length, 1);
});

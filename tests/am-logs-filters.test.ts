// `am logs --level= --tag= --since=` — the three questions a substring cannot
// ask.
//
// Two field reports re-grepped the same throwaway Python out of one JSON blob
// dozens of times (report 7 §6, §8.8; report 4 §9.8). A substring filter cannot
// express "warnings and worse", cannot express "from this cell", and cannot
// express "since the restart" at all.
import { assert, assertEquals } from "@std/assert";
import {
  groupLogEvents,
  logEventHead,
  logEventMatches,
  parseSince,
} from "../src/am/am-cmd-inspect.ts";

/** Real lines, copied from an app log — the header shape is the contract. */
const LOG = [
  "2026-09-07 02:56:32.797+02:00  WARN   checkpoint  snapshot is old",
  "2026-09-07 02:56:32.811+02:00  INFO   aio         state (3 keys)",
  "2026-09-07 02:56:32.850+02:00  INFO   cell:notes  ready",
  "2026-09-07 03:10:00.000+02:00  ERROR  cell:notes  save failed",
  "    at save (cell.ts:12:3)",
  "2026-09-07 03:11:00.000+02:00  DEBUG  cell:todo   tick",
];

const events = () => groupLogEvents(LOG);

Deno.test("am logs: a level means that level AND above", () => {
  const warn = events().filter((e) => logEventMatches(e, { level: "warn" }));
  assertEquals(
    warn.map((e) => logEventHead(e[0]!)?.level),
    ["warn", "error"],
    "--level=warn must keep warnings and errors, and nothing quieter",
  );
  assertEquals(
    events().filter((e) => logEventMatches(e, { level: "error" })).length,
    1,
  );
  // Against a LITERAL: the fixture has five events, and comparing to
  // `events().length` would hold for any implementation, including one that
  // drops everything and one that drops nothing.
  assertEquals(events().length, 5, "the fixture is five events");
  assertEquals(
    events().filter((e) => logEventMatches(e, { level: "debug" })).length,
    5,
    "--level=debug is everything, not just DEBUG lines",
  );
});

Deno.test("am logs: an ERROR keeps its stack, because the unit is the EVENT", () => {
  const errs = events().filter((e) => logEventMatches(e, { level: "error" }));
  assertEquals(errs.length, 1);
  assert(
    errs[0]!.some((l) => l.includes("at save (cell.ts:12:3)")),
    "the stack frame was dropped — a filter that keeps the message and loses " +
      "the trace is worse than no filter",
  );
});

Deno.test("am logs: --tag matches a namespace, not a substring", () => {
  const notes = events().filter((e) =>
    logEventMatches(e, { tag: "cell:notes" })
  );
  assertEquals(notes.length, 2);
  // A namespace prefix keeps its children…
  assertEquals(
    events().filter((e) => logEventMatches(e, { tag: "cell" })).length,
    3,
    "--tag=cell must keep cell:notes and cell:todo",
  );
  // …and nothing that merely starts with the same letters.
  assertEquals(
    events().filter((e) => logEventMatches(e, { tag: "che" })).length,
    0,
    "--tag=che matched `checkpoint` — that is a substring, not a namespace",
  );
});

Deno.test("am logs: --since takes a duration or a timestamp", () => {
  const now = Date.parse("2026-09-07T03:00:00+02:00");
  assertEquals(parseSince("30s", now), now - 30_000);
  assertEquals(parseSince("15m", now), now - 900_000);
  assertEquals(parseSince("2h", now), now - 7_200_000);
  assertEquals(parseSince("1d", now), now - 86_400_000);
  assertEquals(parseSince("2026-09-07T03:00:00+02:00"), now);
  // Not a time → null, so the caller can REFUSE. A filter silently treated as
  // "no filter" turns "I could not read that" into "nothing happened".
  for (const bad of ["yesterday", "", "15", "m", "soon"]) {
    assertEquals(parseSince(bad), null, `"${bad}" was accepted as a time`);
  }
});

Deno.test("am logs: --since drops what is older, keeps what is not", () => {
  const cut = Date.parse("2026-09-07T03:00:00+02:00");
  const kept = events().filter((e) => logEventMatches(e, { sinceMs: cut }));
  assertEquals(kept.length, 2, "only the 03:10 and 03:11 events are newer");
});

Deno.test("am logs: an unparseable header passes every filter", () => {
  // Dropping what we cannot classify is how a filter comes to hide the one
  // line that mattered — a raw write, a pre-format line, a future format.
  const raw = [["some raw write with no header at all"]];
  for (
    const f of [{ level: "error" }, { tag: "cell" }, { sinceMs: Date.now() }]
  ) {
    assertEquals(
      raw.filter((e) => logEventMatches(e, f)).length,
      1,
      `an unclassifiable line was dropped by ${JSON.stringify(f)}`,
    );
  }
});

// Every aio log line is stamped by ONE function. It used to be
// `toISOString()` with the `T` swapped for a space and the `Z` sliced off:
// UTC wearing no marker at all. The terminal read 21:11 while the clock on the
// wall said 23:11 — and a line pasted into an issue carried no way to tell
// which zone it meant. Local time WITH the offset fixes both halves at once.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { now } from "../src/diagnostics/logger-types.ts";
import { formatText } from "../src/diagnostics/logger-format.ts";
import { parseLogLine } from "../amui/src/manager.ts";

const STAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/;

Deno.test("log timestamp: local wall-clock time, with the zone attached", () => {
  const d = new Date();
  const s = now(d);
  assertMatch(s, STAMP);
  // It is the LOCAL clock, not UTC — the whole complaint.
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  assertEquals(
    s.slice(0, 23),
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
      `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.` +
      `${p(d.getMilliseconds(), 3)}`,
  );
  // …and the offset it carries is this machine's, so the instant is recoverable.
  const off = -d.getTimezoneOffset();
  const sign = off < 0 ? "-" : "+";
  const abs = Math.abs(off);
  assertEquals(
    s.slice(23),
    `${sign}${p(Math.floor(abs / 60))}:${p(abs % 60)}`,
  );
  // A stamp with no zone marker is the bug. Never again.
  assert(!/\.\d{3}$/.test(s), `no zone marker: ${s}`);
});

Deno.test("log timestamp: a stamped line round-trips through every reader", () => {
  const line = formatText({
    ts: now(),
    lvl: "info",
    cat: "aio",
    msg: "started",
  });
  // amui parses the log files it shows.
  const parsed = parseLogLine(line);
  assertMatch(parsed.ts ?? "", STAMP);
  assertEquals(parsed.level, "info");
  assertEquals(parsed.scope, "aio");
  assertEquals(parsed.msg.trim(), "started");
});

Deno.test("log timestamp: `am logs` still sees a line like this as an event start", async () => {
  const { groupLogEvents } = await import("../src/am/am-cmd-inspect.ts");
  const a = formatText({ ts: now(), lvl: "info", cat: "aio", msg: "one" });
  const b = formatText({ ts: now(), lvl: "error", cat: "aio", msg: "two" });
  assertEquals(
    groupLogEvents([a, "    at foo (file:///a.ts:1:1)", b]).length,
    2,
    "two events, the stack folded into the first",
  );
});

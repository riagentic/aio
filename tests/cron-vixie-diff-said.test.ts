// A cron whose day rule reads differently from Vixie cron is SAID, once.
//
// A `*` step in a day field (`*/2`) is a restriction in aio, so with the other
// day field restricted a day matches EITHER (the OR rule); Vixie cron reads a
// `*`-led day field as unrestricted and requires BOTH. The reading is not
// changed (that would silently move existing schedules) — it is said, dev and
// prod, naming both readings and how to write the intended one.
import { assert, assertEquals } from "@std/assert";
import { schedule, validateSchedules } from "../src/state/schedule.ts";
import { captureConsole } from "./console-capture.ts";

const act = { type: "c:run", payload: { args: [] } };
const said = (lines: string[]) =>
  lines.filter((l) => l.includes("Vixie cron reads"));

Deno.test("cron: a `*` step beside a restricted day field is said once, naming both readings", () => {
  const lines = captureConsole(() => {
    schedule.cron("a", "0 0 */2 * 1", act);
    schedule.cron("b", "0 0 */2 * 1", act);
  });
  assertEquals(said(lines).length, 1, lines.join("\n"));
  const l = said(lines)[0]!;
  assert(l.includes('day-of-month "*/2"'), l);
  assert(l.includes("EITHER") && l.includes("BOTH"), l);
  assert(l.includes('"1-31/2"'), l);
});

Deno.test("cron: the declarative `schedules` path says it too (day-of-week step)", () => {
  const lines = captureConsole(() =>
    validateSchedules([{ id: "d", cron: "0 0 15 * */2", action: act }])
  );
  assertEquals(said(lines).length, 1, lines.join("\n"));
  assert(said(lines)[0]!.includes('day-of-week "*/2"'));
});

Deno.test("cron: patterns both readings agree on are not said", () => {
  const lines = captureConsole(() => {
    for (
      const p of [
        "0 0 */2 * *", // other day field unrestricted: AND either way
        "0 0 * * 1", // `*` is unrestricted in both
        "0 0 1-31/2 * 1", // explicit range: a restriction in both
        "0 0 1,15 * 1", // no `*` at all
        "*/5 */2 1 * *", // steps outside the day fields
        "0 0 */2 * 0-6", // AND either way: aio (0-6 is full), Vixie (`*`)
        "0 0 1-31 * 0-6", // both full: every day either way
      ]
    ) schedule.cron("k", p, act);
  });
  assertEquals(said(lines), [], lines.join("\n"));
});

Deno.test("cron: a full day range beside a restricted one is said once — AND here, OR in Vixie", () => {
  const lines = captureConsole(() => {
    schedule.cron("f", "0 0 1-31 * 1", act);
    schedule.cron("f", "0 0 1-31 * 1", act);
    schedule.cron("g", "0 0 13 * 0-6", act);
  });
  assertEquals(said(lines).length, 2, lines.join("\n"));
  assert(said(lines)[0]!.includes('day-of-month "1-31" covers every day'));
  assert(said(lines)[1]!.includes('day-of-week "0-6" covers every day'));
});

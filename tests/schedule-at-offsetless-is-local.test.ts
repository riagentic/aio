// `schedule.at` with an ISO date-time WITHOUT an offset (`"2026-01-01T09:00"`,
// what `<input type="datetime-local">` yields) is read the way `new Date()`
// reads it — in the MACHINE's zone. v1.0.11 armed it so and apps rely on it
// (compat is absolute; reading it as UTC is parked in future/v2.md). What
// changed: it is no longer SILENT — hosts in different zones fire the same
// schedule at different instants, so the scheduler warns once per id, naming
// the fix, identically in dev and prod.
import { assert, assertEquals } from "@std/assert";
import {
  createScheduleManager,
  createVirtualTimers,
  schedule,
} from "../src/state/schedule.ts";

const MIN = 60_000;

function withTz<T>(tz: string, f: () => Promise<T>): Promise<T> {
  const prev = Deno.env.get("TZ");
  Deno.env.set("TZ", tz);
  return f().finally(() => {
    if (prev === undefined) Deno.env.delete("TZ");
    else Deno.env.set("TZ", prev);
  });
}

/** Arm `times` (one id each) at a virtual 2025-12-31T00:00Z and report the
 *  UTC instant, to the minute, each one fires at — plus every warning. */
function run(
  tz: string,
  times: Array<[id: string, time: string]>,
  hours = 40,
): Promise<{ fired: Record<string, string>; warns: string[] }> {
  return withTz(tz, async () => {
    const start = Date.UTC(2025, 11, 31, 0, 0);
    const clock = createVirtualTimers(start);
    const fired: Record<string, string> = {};
    const warns: string[] = [];
    const log = {
      info() {},
      warn: (m: string) => void warns.push(m),
      error() {},
      debug() {},
    };
    const mgr = createScheduleManager(
      ((a: { type: string }) => {
        fired[a.type] = new Date(clock.now()).toISOString().slice(0, 16);
        return Promise.resolve();
      }) as unknown as Parameters<typeof createScheduleManager>[0],
      log,
      { timers: clock },
    );
    for (const [id, t] of times) mgr.handle(schedule.at(id, t, { type: id }));
    for (let m = 0; m < hours * 60; m++) await clock.advance(MIN);
    mgr.cancelAll();
    return { fired, warns };
  });
}

Deno.test("schedule.at: an offset-less ISO time keeps the machine-local reading in every zone", async () => {
  // 09:00 wall-clock in each zone, as UTC.
  const expected: Record<string, string> = {
    "Asia/Tokyo": "2026-01-01T00:00",
    "America/New_York": "2026-01-01T14:00",
    "UTC": "2026-01-01T09:00",
  };
  for (const [tz, utc] of Object.entries(expected)) {
    const { fired } = await run(tz, [
      ["secs", "2026-01-01T09:00:00"],
      ["mins", "2026-01-01T09:00"],
      // An explicit offset keeps its meaning everywhere.
      ["explicit", "2026-01-01T18:00:00+09:00"],
      ["zulu", "2026-01-01T09:00:00Z"],
    ]);
    assertEquals(fired, {
      secs: utc,
      mins: utc,
      explicit: "2026-01-01T09:00",
      zulu: "2026-01-01T09:00",
    }, tz);
  }
});

Deno.test("schedule.at: an offset-less time warns once per id, naming the fix; an explicit one is silent", async () => {
  const { warns } = await run("Asia/Tokyo", [
    ["a", "2026-01-01T09:00:00"],
    ["a", "2026-01-01T10:00:00"], // same id re-armed: no second warning
    ["b", "2026-01-01T09:00"],
    ["z", "2026-01-01T09:00:00Z"],
    ["o", "2026-01-01T09:00:00+09:00"],
  ], 0);
  assertEquals(warns.length, 2, warns.join("\n"));
  assert(warns[0]?.includes("'a'") && warns[1]?.includes("'b'"), warns.join());
  for (const w of warns) {
    assert(w.includes("this machine's zone"), w);
    assert(w.includes("different instants"), w);
    assert(w.includes('append "Z"'), w);
  }
});

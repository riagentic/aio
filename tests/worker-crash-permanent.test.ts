// A worker crash that is not respawned rejects the calls in flight with an
// error as permanent as every later call's: a schedule tick in flight at the
// crash must stop the schedule with ONE error, not log "dispatch failed" first
// (tests/schedule-stops-on-dead-worker.test.ts saw two lines on a slow Mac).
import { assert, assertEquals } from "@std/assert";
import { _workerCrash } from "../src/server/cell-worker.ts";
import { PERMANENT_REFUSAL } from "../src/state/schedule.ts";

const mark = (e: Error) =>
  (e as unknown as Record<symbol, unknown>)[PERMANENT_REFUSAL];

Deno.test("worker crash: no respawn marks the error permanent; a respawn does not", () => {
  // No `workerRespawn`: dead for good.
  const dead = _workerCrash("w", "boom", null);
  assertEquals(dead.respawn, false);
  assertEquals(mark(dead.err), true);
  // `workerRespawn: true`, first crash: it comes back, the error is transient.
  const times: number[] = [];
  const back = _workerCrash("w", "boom", times, 1_000);
  assertEquals(back.respawn, true);
  assertEquals(mark(back.err), undefined);
  // The crash loop's last crash is not respawned: permanent again.
  _workerCrash("w", "boom", times, 2_000);
  const loop = _workerCrash("w", "boom", times, 3_000);
  assertEquals(loop.respawn, false);
  assert(loop.err.message.includes("respawn stopped"), loop.err.message);
  assertEquals(mark(loop.err), true);
});

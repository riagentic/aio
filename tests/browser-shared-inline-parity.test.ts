// `msg`, `schedule` and `own` reach the browser bundle as RE-EXPORTS of
// src/state (src/browser/browser-shared.ts — build-bundle.ts aliases `aio` →
// src/browser-air.ts). There is no inlined twin any more.
//
// There was one, and it drifted badly: by the time the first version of this
// file was written the browser's `schedule` was missing `backoff`, `poll` and
// `next` entirely and silently dropped `every`'s `skipIfRunning`. Client-scoped
// cell methods and CRDT optimistic replay run method bodies IN THE BROWSER, so
// `schedule.next(...)` in such a method threw `is not a function` in production
// while passing every test. The mechanism then was a 300-round output
// differential over the pure effect creators. alpha70 made src/state/schedule.ts
// Deno-free and replaced the twin with a re-export — and the differential kept
// passing, comparing a function with itself, while its header still described
// two copies.
//
// What must hold now is smaller and sharper: the browser's objects ARE the
// server's (identity, so no drift is possible), and the fact that makes the
// re-export legal — none of the three modules touches a Deno API — stays
// true, or the browser bundle breaks at load.
import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { msg as serverMsg } from "../src/state/msg.ts";
import { own as serverOwn } from "../src/state/own.ts";
import { schedule as serverSchedule } from "../src/state/schedule.ts";
import {
  msg as browserMsg,
  own as browserOwn,
  schedule as browserSchedule,
} from "../src/browser/browser-shared.ts";

Deno.test("browser-shared: msg/schedule/own are the server's objects — identity, not parity", () => {
  assertStrictEquals(
    browserSchedule,
    serverSchedule,
    "the browser must export src/state/schedule.ts itself, not a copy",
  );
  assertStrictEquals(browserMsg, serverMsg);
  assertStrictEquals(browserOwn, serverOwn);
});

Deno.test("browser-shared: the surface the browser sees is the server's creator set", () => {
  assertEquals(
    Object.keys(browserSchedule).sort(),
    Object.keys(serverSchedule).sort(),
  );
  assertEquals(Object.keys(browserOwn).sort(), Object.keys(serverOwn).sort());
  // alpha70: `blocking` is the top-level, server-only export — not a schedule
  // member on either side.
  assertEquals("blocking" in browserSchedule, false);
});

Deno.test("browser-shared: the re-exported modules stay Deno-free (what makes the re-export legal)", async () => {
  const here = new URL(".", import.meta.url);
  for (const rel of ["state/schedule.ts", "state/msg.ts", "state/own.ts"]) {
    const src = await Deno.readTextFile(new URL(`../src/${rel}`, here));
    const hit = src.match(/\bDeno\.[a-zA-Z]+/);
    assert(
      !hit,
      `src/${rel} reaches for ${hit?.[0]} — it ships in the browser bundle`,
    );
    assert(
      !/from\s+["'][^"']*blocking\.ts["']/.test(src),
      `src/${rel} imports blocking.ts — that is the Deno worker pool`,
    );
  }
});

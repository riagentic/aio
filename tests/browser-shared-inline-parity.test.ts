// `msg`, `schedule` and `own` exist TWICE: once in src/state (what the server,
// standalone and every in-process test run) and once inlined in
// src/browser/browser-shared.ts (what the browser bundle exports as `aio`'s
// `msg`/`schedule`/`own` — build-bundle.ts aliases `aio` → src/browser-air.ts).
//
// CLAUDE.md carries this as a note to humans ("they must stay in sync with
// src/state/"). A note is not a mechanism: by the time this file was written the
// browser's `schedule` was missing `backoff`, `poll`, `next` and `blocking`
// entirely, and silently dropped `every`'s `skipIfRunning`. Client-scoped cell
// methods and CRDT optimistic replay both run method bodies IN THE BROWSER, so
// `schedule.next(...)` in such a method threw `is not a function` in production
// while passing every test.
//
// This file is the mechanism: key-set equality plus a randomized output
// differential over the pure effect creators.
import { assert, assertEquals } from "@std/assert";
import { msg as serverMsg } from "../src/state/msg.ts";
import { own as serverOwn } from "../src/state/own.ts";
import { schedule as serverSchedule } from "../src/state/schedule.ts";
import {
  msg as browserMsg,
  own as browserOwn,
  schedule as browserSchedule,
} from "../src/browser/browser-shared.ts";
import { fuzzEnvInt } from "./fuzz-seed.ts";

// deno-lint-ignore no-explicit-any
type AnyFn = (...a: any[]) => any;
const asFns = (o: unknown) => o as Record<string, AnyFn>;

/** Deterministic LCG — the same seed replays the same argument stream. */
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x1_0000_0000);
}

Deno.test("browser-shared: msg() is byte-identical in behaviour to src/state/msg.ts", () => {
  const r = rng(fuzzEnvInt("AIO_FUZZ_SEED", 20260805));
  for (let i = 0; i < 200; i++) {
    const type = `t${Math.floor(r() * 1000)}`;
    const payload = r() < 0.5
      ? undefined
      : { n: Math.floor(r() * 100), s: `${r()}` };
    assertEquals(
      browserMsg(type, payload),
      serverMsg(type, payload),
      `msg("${type}", ${JSON.stringify(payload)}) diverges`,
    );
  }
  // The no-payload overload is the one that silently drifts (`{}` vs undefined).
  assertEquals(browserMsg("bare"), serverMsg("bare"));
});

Deno.test("browser-shared: own effect creators match src/state/own.ts", () => {
  assertEquals(
    Object.keys(browserOwn).sort(),
    Object.keys(serverOwn).sort(),
    "the browser `own` must expose exactly the server's surface",
  );
  assertEquals(
    browserOwn.dispose("watcher:a"),
    serverOwn.dispose("watcher:a"),
    "own.dispose is plain data — it must be identical",
  );
  // own.set carries a one-shot token whose VALUE is a per-module sequence; the
  // shape must still match exactly (kind/id/token presence and types).
  const b = browserOwn.set("watcher:a", () => {}) as Record<string, unknown>;
  const s = serverOwn.set("watcher:a", () => {}) as Record<string, unknown>;
  assertEquals(Object.keys(b).sort(), Object.keys(s).sort());
  assertEquals(b.type, s.type);
  assertEquals(b.kind, s.kind);
  assertEquals(b.id, s.id);
  assertEquals(typeof b.token, typeof s.token);
});

Deno.test("browser-shared: schedule exposes exactly the server's creators", () => {
  assertEquals(
    Object.keys(browserSchedule).sort(),
    Object.keys(serverSchedule).sort(),
    "a creator missing from the browser copy is `is not a function` in the " +
      "browser ONLY — client-scoped methods and CRDT replay run method " +
      "bodies there",
  );
  // alpha70: `blocking` is NOT a schedule member on either side — it is the
  // top-level, server-only export. A browser twin that still carried it
  // would be a surface the server does not have.
  assertEquals("blocking" in browserSchedule, false);
  assertEquals("blocking" in serverSchedule, false);
});

Deno.test("browser-shared: schedule effect creators are output-identical (randomized)", () => {
  const seed = fuzzEnvInt("AIO_FUZZ_SEED", 20260805);
  const rounds = fuzzEnvInt("AIO_FUZZ_ROUNDS", 300);
  const r = rng(seed);
  const bs = asFns(browserSchedule);
  const ss = asFns(serverSchedule);
  let checked = 0;

  for (let i = 0; i < rounds; i++) {
    const id = `id-${Math.floor(r() * 50)}`;
    const ms = Math.floor(r() * 100_000) + 1;
    const action = { type: `a${Math.floor(r() * 10)}`, payload: { i } };
    const pick = Math.floor(r() * 8);
    // Outcome, not just return value: for the ambiguous 3rd-argument forms the
    // two copies could DISAGREE by one throwing and the other returning, which
    // is exactly what happened for an action CREATOR (a callable object
    // carrying a string `.type`). The browser accepted it as the action while
    // the server read the same call as the deprecated opts-third order and
    // threw `ms must be finite` — one source file, two behaviours, with the
    // permissive side being the client.
    const outcome = (fn: (...a: unknown[]) => unknown, args: unknown[]) => {
      try {
        return { ok: fn(...args) };
      } catch (e) {
        return { threw: (e as Error).message };
      }
    };
    const call = (name: string, args: unknown[]) => {
      checked++;
      assertEquals(
        outcome(bs[name]!, args),
        outcome(ss[name]!, args),
        `schedule.${name}(${JSON.stringify(args)}) diverges`,
      );
    };
    switch (pick) {
      case 0:
        call("after", [id, ms, action]);
        break;
      case 1:
        // The 4th argument is the one that vanished: the browser copy took
        // three parameters, so `{ skipIfRunning: true }` was dropped without a
        // word.
        call("every", [
          id,
          ms,
          action,
          r() < 0.5 ? { skipIfRunning: true } : undefined,
        ]);
        break;
      case 2:
        call("at", [id, new Date(1e12 + ms).toISOString(), action]);
        break;
      case 3:
        call("cron", [id, "*/5 * * * *", action]);
        break;
      case 4:
        call("backoff", [id, Math.floor(r() * 45), {
          base: Math.floor(r() * 2000) + 1,
          ...(r() < 0.5 ? { max: 60_000 } : {}),
          ...(r() < 0.5 ? { factor: 3 } : {}),
        }, action]);
        break;
      case 5:
        call("poll", [id, Math.floor(r() * 45), {
          every: Math.floor(r() * 10_000) + 1,
          ...(r() < 0.5 ? { backoff: 2 } : {}),
          ...(r() < 0.5 ? { max: 60_000 } : {}),
        }, action]);
        break;
      case 6: {
        // An action CREATOR in the action slot: `cell.method` is a FUNCTION
        // with a string `.type`, and it is what people reach for first.
        const creator = Object.assign(
          (...args: unknown[]) => ({ type: action.type, payload: { args } }),
          { type: action.type },
        );
        // THIRD argument — the ambiguous slot both copies have to read the
        // same way.
        const name = r() < 0.5 ? "backoff" : "poll";
        call(name, [
          id,
          Math.floor(r() * 45),
          creator,
          name === "backoff"
            ? { base: Math.floor(r() * 2000) + 1 }
            : { every: Math.floor(r() * 10_000) + 1 },
        ]);
        break;
      }
      default:
        call(r() < 0.5 ? "next" : "cancel", r() < 0.5 ? [id, action] : [id]);
        break;
    }
  }
  assertEquals(checked, rounds, "every round must compare one creator");
});

Deno.test("alpha70 refusal parity: the browser twin REFUSES the old backoff/poll spellings with the server's words", () => {
  const A = { type: "t:tick" };
  const refusal = (fn: () => unknown): string => {
    try {
      fn();
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };
  const cases: Array<[string, AnyFn, AnyFn]> = [
    [
      "old backoff order",
      () => (browserSchedule.backoff as AnyFn)("bh", 1, { base: 100 }, A),
      () => (serverSchedule.backoff as AnyFn)("bh", 1, { base: 100 }, A),
    ],
    [
      "old poll order",
      () => (browserSchedule.poll as AnyFn)("ph", 1, { every: 100 }, A),
      () => (serverSchedule.poll as AnyFn)("ph", 1, { every: 100 }, A),
    ],
    [
      "poll backoff key",
      () =>
        (browserSchedule.poll as AnyFn)("pk", 1, A, { every: 100, backoff: 2 }),
      () =>
        (serverSchedule.poll as AnyFn)("pk", 1, A, { every: 100, backoff: 2 }),
    ],
  ];
  for (const [what, b, s] of cases) {
    const bm = refusal(b);
    const sm = refusal(s);
    assert(
      sm.includes("removed in alpha70"),
      `${what}: server refuses by name`,
    );
    assertEquals(
      bm,
      sm,
      `${what}: the browser twin must refuse with the SAME line`,
    );
  }
  // The current spelling is silent on both sides and output-identical.
  assertEquals(
    browserSchedule.backoff("bnew", 1, A, { base: 100 }),
    serverSchedule.backoff("bnew", 1, A, { base: 100 }),
  );
  assertEquals(
    browserSchedule.poll("pnew", 1, A, { every: 100, factor: 2 }),
    serverSchedule.poll("pnew", 1, A, { every: 100, factor: 2 }),
  );
});

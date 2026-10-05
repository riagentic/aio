// test-server-port-race.test.ts — the harness does not fail a test because
// another test process won a port first.
//
// `freePort()` binds port 0, closes it, and returns the number. Between that
// close and the server's real `listen` there is a window, and under
// `scripts/test-shards.ts` every sibling process draws from the same inherited
// slice. `sliceStart` spread the siblings so they stop walking in lockstep and
// says plainly what it could not fix: the OS can still hand the same port to
// two `listen` calls. It cost cookbook recipe 14 twice — `port 24256` once,
// then `port 24325` in the v1.0.9 release check — and both times the failure
// read like a product bug in the recipe.
//
// So the race is retried, and the two ways that could go wrong are what this
// file pins: retrying a failure that was never about the port (a real bug,
// delayed and then reported three times over), and retrying for a caller who
// asked about ONE port (their fixed-port test would pass on a different one).

import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  _bootOnAFreePort,
  _isPortTakenError,
  freePort,
  testServer,
} from "../src/testing/server-test.ts";
import { cell } from "../mod.ts";

const xport = cell("xport", { state: { n: 0 }, methods: {} });

// ── the predicate, against a real doubled bind ──────────────────────────────
//
// The type is gone by the time a caller sees this (createServer catches
// Deno.errors.AddrInUse and rethrows a teachable plain Error), so the
// predicate has to read the message — which makes the wording a second
// decider. Matching it against an error a REAL collision threw is what keeps
// it one: reword the refusal in server.ts and this test fails, instead of the
// retry silently never firing again.
Deno.test("the predicate matches what a real port collision throws", async () => {
  const port = freePort();
  await using _held = await testServer({ cells: [xport], port });

  const e = await assertRejects(() => testServer({ cells: [xport], port }));
  assert(
    _isPortTakenError(e),
    `a doubled bind on ${port} must be recognised as a port collision, got: ${
      (e as Error).message
    }`,
  );
});

// A boot that loses its port throws out of a synchronous `createServer`, so
// nothing is left to wait for work it started. The dev CSS step used to start
// BEFORE the bind: its read of the project's deno.json was still running when
// the refusal was thrown, and under load it finished inside the next test —
// which then failed with "an async readTextFile started before the test".
// Every read is held open here, so "still running" is a count, not a race.
Deno.test("a boot that loses its port leaves no file read running", async () => {
  const running = new Set<string>();
  const real = Deno.readTextFile;
  Deno.readTextFile = ((path: string | URL, opts?: Deno.ReadFileOptions) => {
    const key = `${path}#${running.size}`;
    running.add(key);
    return new Promise((r) => setTimeout(r, 200))
      .then(() => real(path, opts))
      .finally(() => running.delete(key));
  }) as typeof Deno.readTextFile;
  try {
    const port = freePort();
    await using _held = await testServer({ cells: [xport], port });
    // The holder's own step is owned (its close waits for it) — let it end,
    // so what is counted below belongs to the refused boot alone.
    while (running.size > 0) await new Promise((r) => setTimeout(r, 20));
    await assertRejects(() => testServer({ cells: [xport], port }));
    assertEquals(
      [...running],
      [],
      "the refused boot must not leave a read behind",
    );
  } finally {
    Deno.readTextFile = real;
  }
});

Deno.test("the predicate does not match an unrelated failure", () => {
  assertEquals(_isPortTakenError(new Error("disk is full")), false);
  assertEquals(_isPortTakenError(new Error("port is already in use")), false);
  assertEquals(_isPortTakenError("port 80 already in use"), true);
});

// ── the retry ───────────────────────────────────────────────────────────────

const taken = (port: number) =>
  new Error(
    `port ${port} already in use — something else is listening on it.`,
  );

Deno.test("a lost port race is retried, not reported", async () => {
  const tried: number[] = [];
  const got = await _bootOnAFreePort<unknown>(undefined, (port) => {
    tried.push(port);
    if (tried.length < 3) return Promise.reject(taken(port));
    return Promise.resolve("booted" as unknown as never);
  });
  assertEquals(got.app, "booted" as unknown);
  assertEquals(
    got.port,
    tried[2],
    "the port reported back must be the one that actually bound",
  );
  assertEquals(tried.length, 3, "it must have asked for three ports");
  assertEquals(
    new Set(tried).size,
    3,
    `a retry on the SAME port would lose the same race again: ${tried}`,
  );
});

Deno.test("losing every time is reported, with the last refusal", async () => {
  let n = 0;
  const e = await assertRejects(() =>
    _bootOnAFreePort<unknown>(undefined, (port) => {
      n++;
      return Promise.reject(taken(port));
    })
  );
  assert(n >= 2 && n <= 8, `bounded attempts, got ${n}`);
  assert(
    /lost the port race/.test((e as Error).message),
    (e as Error).message,
  );
  // The reason the ports ran out must survive, or the report names a symptom
  // and buries the cause.
  assert(
    /already in use/.test((e as Error).message),
    `the last refusal must be quoted: ${(e as Error).message}`,
  );
});

Deno.test("a failure that is not about the port surfaces at once", async () => {
  let n = 0;
  const e = await assertRejects(() =>
    _bootOnAFreePort<unknown>(undefined, () => {
      n++;
      return Promise.reject(new Error("cell xfoo: boom"));
    })
  );
  assertEquals(n, 1, "a real boot failure must not be retried");
  assertEquals((e as Error).message, "cell xfoo: boom");
});

Deno.test("a caller's own port is never quietly swapped", async () => {
  const tried: number[] = [];
  const e = await assertRejects(() =>
    _bootOnAFreePort<unknown>(41234, (port) => {
      tried.push(port);
      return Promise.reject(taken(port));
    })
  );
  assertEquals(tried, [41234], "asked about one port, answered about one port");
  assert(_isPortTakenError(e), (e as Error).message);
});

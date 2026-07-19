// B5/M1 (TBD feedback): `libraryMode: true` lets a real server boot inside a
// Deno.test and close cleanly — no Deno.exit (which killed the runner), no
// SIGINT/SIGTERM handlers (leaked resources that failed the sanitizer), no
// singleton lock (so the same appId can boot twice sequentially). This unlocks
// end-to-end server tests, the gap that let the TBD persistence bugs ship.

import { assertEquals } from "jsr:@std/assert";

const PORT = 9330 + (Deno.pid % 200);

// Sanitizers ON: this is the whole point — libraryMode must not leak the signal
// handlers / exit the process. If B5 regresses, this test fails or hangs.
Deno.test("libraryMode: boot + dispatch + close cleanly inside a test", async () => {
  const { cell, aio } = await import("../mod.ts");
  const counter = cell("counter", {
    state: { count: 0 },
    methods: {
      increment(s: { count: number }, by = 1) {
        s.count += by;
      },
    },
  });

  const app = await aio.run({
    cells: [counter],
    appId: "test-library-mode",
    appVersion: "0.0.0",
    client: "server-only",
    persist: false,
    libraryMode: true,
    port: PORT,
    baseDir: await Deno.makeTempDir(),
  });

  type S = { counter: { count: number } };
  const count = () => (app.getState() as unknown as S).counter.count;
  try {
    assertEquals(count(), 0);
    counter.increment(5);
    await new Promise((r) => setTimeout(r, 30));
    assertEquals(count(), 5, "dispatch reflected in server state");
  } finally {
    await app.close(); // must resolve, leave the process alive, and not leak
  }
});

Deno.test("libraryMode: same appId boots twice (no singleton lock)", async () => {
  const { cell, aio } = await import("../mod.ts");

  const boot = async () => {
    const c = cell("counter", {
      state: { count: 0 },
      methods: { increment(s: { count: number }, by = 1) { s.count += by; } },
    });
    return await aio.run({
      cells: [c],
      appId: "test-library-mode-2",
      appVersion: "0.0.0",
      client: "server-only",
      persist: false,
      libraryMode: true,
      port: PORT + 1,
      baseDir: await Deno.makeTempDir(),
    });
  };

  // Without libraryMode (singleton lock), a second boot of the same appId would
  // refuse (Deno.exit(1)) and kill the runner. libraryMode makes it clean.
  const a = await boot();
  await a.close();
  const b = await boot();
  await b.close();
});

// B6 (TBD): calling a cell METHOD inside onStart must work — the method surface
// is now bound before onStart fires (was: "cell runtime not booted" throw).
Deno.test("onStart can call a cell method (B6) — seeding works", async () => {
  const { cell, aio } = await import("../mod.ts");
  const members = cell("members", {
    state: { roster: [] as Array<{ id: number }> },
    methods: {
      add(s: { roster: Array<{ id: number }> }, id: number) {
        s.roster.push({ id });
      },
    },
  });

  let onStartError: unknown = null;
  const app = await aio.run({
    cells: [members],
    appId: "test-onstart-seed",
    appVersion: "0.0.0",
    client: "server-only",
    persist: false,
    libraryMode: true,
    port: PORT + 2,
    baseDir: await Deno.makeTempDir(),
    onStart: () => {
      try {
        (members as unknown as { add: (id: number) => void }).add(1);
      } catch (e) {
        onStartError = e;
      }
    },
  });

  type S = { members: { roster: Array<{ id: number }> } };
  try {
    assertEquals(onStartError, null, "cell method in onStart must not throw");
    await new Promise((r) => setTimeout(r, 30));
    assertEquals(
      (app.getState() as unknown as S).members.roster,
      [{ id: 1 }],
      "onStart seeding is reflected in state",
    );
  } finally {
    await app.close();
  }
});

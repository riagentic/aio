// `serverUser()` inside an EFFECT — including the effect that is an async
// method's own body (`cell:__exec`).
//
// The identity wrap used to sit inside `onEffect ? … : …`, so an app that
// configured no `onEffect` hook — the default, and every real app — ran its
// effects OUTSIDE the AsyncLocalStorage scope: `serverUser()` was `undefined`
// inside every async method in production, while adding a no-op
// `onEffect: () => {}` made the same method see "alice". `auth-context.ts` and
// the API reference both advertise serverUser() as usable in effects.
//
// This has to be driven through a booted app, NOT `testCell`'s `t.as`: the
// harness wraps the whole `t.as` body in `runWithUser`, so the ambient is
// already set and the missing wrap is invisible. A test that cannot see the
// defect is not a test of it (verified by restoring the defect: this file goes
// red, `tests/testcell-as-user.test.ts` stays green).
import { assertEquals } from "@std/assert";
import { aio } from "../mod.ts";
import { cell } from "../src/state/cell.ts";
import { serverUser } from "../src/server/auth-context.ts";
import { freePort } from "../src/testing/server-test.ts";

const alice = { id: "alice", role: "member" };

const audited = cell("effect-identity", {
  state: { sync: "unset", async: "unset" },
  methods: {
    // Sync body: runs inside reduce, which was never in doubt.
    recordSync(s: { sync: string; async: string }) {
      s.sync = serverUser()?.id ?? "none";
    },
    // Async body: the framework runs this as an effect.
    async recordAsync(s: { sync: string; async: string }) {
      await Promise.resolve();
      s.async = serverUser()?.id ?? "none";
    },
  },
});

type Audited = { sync: string; async: string };

/** The cell's slice of the app's state, as the server holds it. */
// deno-lint-ignore no-explicit-any
const readState = (app: { getState: () => any }): Audited =>
  app.getState()["effect-identity"] as Audited;

/** An async method's body runs as an effect AFTER `dispatch()` resolves, so
 *  wait for the write rather than for a fixed delay. */
async function settled(
  // deno-lint-ignore no-explicit-any
  app: { getState: () => any },
  field: keyof Audited,
): Promise<Audited> {
  for (let i = 0; i < 100 && readState(app)[field] === "unset"; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  return readState(app);
}

async function boot() {
  return await aio.run({
    cells: [audited],
    appId: "test-effect-identity",
    appVersion: "0.0.0",
    client: "server-only",
    persist: false,
    libraryMode: true,
    port: freePort(),
    baseDir: await Deno.makeTempDir(),
  });
}

Deno.test("serverUser: an async method's body sees the acting user with NO onEffect hook", async () => {
  const app = await boot();
  try {
    await app.dispatch(
      // The trusted server-side tag — the same field the transport stamps
      // after authenticating, and strips from anything a client sends.
      {
        type: "effect-identity:recordAsync",
        payload: { args: [] },
        _user: alice,
        // deno-lint-ignore no-explicit-any
      } as any,
    );
    assertEquals(
      (await settled(app, "async")).async,
      "alice",
      "an async method IS an effect — the caller's identity must reach it",
    );
  } finally {
    await app.close();
  }
});

Deno.test("serverUser: sync and async methods agree on who is calling", async () => {
  const app = await boot();
  try {
    await app.dispatch(
      // deno-lint-ignore no-explicit-any
      {
        type: "effect-identity:recordSync",
        payload: { args: [] },
        _user: alice,
      } as any,
    );
    await app.dispatch(
      // deno-lint-ignore no-explicit-any
      {
        type: "effect-identity:recordAsync",
        payload: { args: [] },
        _user: alice,
      } as any,
    );
    const s = await settled(app, "async");
    assertEquals(
      s.async,
      s.sync,
      "sync/async parity: the same call by the same user answers the same",
    );
  } finally {
    await app.close();
  }
});

Deno.test("serverUser: an unauthenticated dispatch stays anonymous in the effect", async () => {
  const app = await boot();
  try {
    await app.dispatch(
      // deno-lint-ignore no-explicit-any
      { type: "effect-identity:recordAsync", payload: { args: [] } } as any,
    );
    assertEquals(
      (await settled(app, "async")).async,
      "none",
      "no caller ⇒ no identity — the wrap must not invent one",
    );
  } finally {
    await app.close();
  }
});

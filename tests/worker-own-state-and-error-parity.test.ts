// A `worker: true` cell reads its OWN live state, and its errors keep their
// `name`/`code` — against a REAL worker exactly as in every harness.
//
// The real worker host never bound the hosted cell, so `ownState.n` inside its
// method hit the creation-time getter and returned the DECLARED DEFAULT
// forever: set n=42, read 0 — silently, while every in-process harness read
// 42. And a thrown error crossed the thread as `{ message, stack }` only, so a
// caller branching on `e.name`/`e.code` saw a plain `Error` in the app and
// the real error in its tests.
//
// The real worker answers first; the harnesses must give the same answer.
import { assert, assertEquals } from "@std/assert";
import { testServer } from "../src/testing/server-test.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { ownState } from "./fixtures/worker-own-state-app.ts";

const ENTRY = import.meta.resolve("./fixtures/worker-own-state-app.ts");

type Own = {
  set: (n: number) => Promise<void>;
  readBoth: () => Promise<unknown>;
  readAfterAwait: () => Promise<unknown>;
  fail: () => Promise<void>;
  failAsync: () => Promise<void>;
};
const O = ownState as unknown as Own;

async function errorOf(p: () => Promise<unknown>) {
  try {
    await p();
    return "did not throw";
  } catch (e) {
    const x = e as Error & { code?: unknown };
    return {
      isError: x instanceof Error,
      name: x.name,
      code: x.code,
      message: x.message,
    };
  }
}

async function ask() {
  await O.set(42);
  return {
    readBoth: await O.readBoth(),
    readAfterAwait: await O.readAfterAwait(),
    fail: await errorOf(O.fail),
    failAsync: await errorOf(O.failAsync),
  };
}

let real: Awaited<ReturnType<typeof ask>> | undefined;

Deno.test("worker own state: a REAL worker reads its live slice and keeps error name/code", async () => {
  await using _srv = await testServer({
    cells: [ownState],
    workers: "real",
    workerEntry: ENTRY,
  });
  real = await ask();
  assertEquals(real.readBoth, { viaDraft: 42, viaCell: 42, label: "live" });
  assertEquals(real.readAfterAwait, { n: 42, label: "live" });
  // An async body's own error arrives as itself.
  assertEquals(real.failAsync, {
    isError: true,
    name: "WalletLockedError",
    code: "E_LOCKED",
    message: "wallet is locked",
  });
  // A sync throw is wrapped by dispatch on EITHER side of the thread; what
  // matters is that the wrapper's identity survives the crossing.
  assert(
    typeof real.fail === "object" && real.fail.name !== "Error" &&
      typeof real.fail.code === "string",
    `sync throw lost its name/code: ${JSON.stringify(real.fail)}`,
  );
});

Deno.test("worker own state: testServer in-isolate answers the same", async () => {
  assert(real, "runs after the real-worker case");
  await using _srv = await testServer({ cells: [ownState] });
  assertEquals(await ask(), real);
});

Deno.test("worker own state: bootCells answers the same", async () => {
  assert(real, "runs after the real-worker case");
  await using _h = await bootCells([ownState]);
  assertEquals(await ask(), real);
});

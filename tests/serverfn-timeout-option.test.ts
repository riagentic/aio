// `serverFn(ns, { timeoutMs })`: the client's 30 s reply timeout was fixed, so
// a known-long function (an export, a model call) could not be awaited past it
// and a short one could not fail fast. The option sets the window; a bad value
// is refused at the `serverFn()` call, on the server side too.
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import { setConnected } from "../src/state/state-signals.ts";
import {
  _registerSfnTransport,
  _resetSfnClient,
  handleSfnResult,
  serverFn as clientServerFn,
} from "../src/browser/server-fns-client.ts";
import { serverFn as serverServerFn } from "../src/server/server-fns.ts";

type Api = { slow: () => Promise<number> };

/** A transport that records each call's cid and never answers by itself. */
function silentServer(): string[] {
  const cids: string[] = [];
  setConnected(true);
  _registerSfnTransport((raw) => {
    cids.push((JSON.parse(raw) as { d: { cid: string } }).d.cid);
    return true;
  });
  return cids;
}

Deno.test("serverFn timeoutMs: the call waits past 30 s and gets the reply", async () => {
  using time = new FakeTime();
  _resetSfnClient();
  const cids = silentServer();
  try {
    const call = clientServerFn<Api>("t-long", { timeoutMs: 120_000 }).slow();
    await time.tickAsync(60_000);
    handleSfnResult({ cid: cids[0], ok: true, value: 7 });
    assertEquals(await call, 7);
  } finally {
    _resetSfnClient();
    setConnected(false);
  }
});

Deno.test("serverFn timeoutMs: a short window rejects naming it", async () => {
  using time = new FakeTime();
  _resetSfnClient();
  silentServer();
  try {
    const call = clientServerFn<Api>("t-short", { timeoutMs: 2_000 }).slow();
    const rejected = assertRejects(() => call, Error, "timed out after 2s");
    await time.tickAsync(2_001);
    await rejected;
  } finally {
    _resetSfnClient();
    setConnected(false);
  }
});

Deno.test("serverFn without options keeps the 30 s default", async () => {
  using time = new FakeTime();
  _resetSfnClient();
  silentServer();
  try {
    const call = clientServerFn<Api>("t-default").slow();
    const rejected = assertRejects(() => call, Error, "timed out after 30s");
    await time.tickAsync(30_001);
    await rejected;
  } finally {
    _resetSfnClient();
    setConnected(false);
  }
});

Deno.test("serverFn timeoutMs: a bad value is refused on both sides", () => {
  for (const bad of [0, -1, NaN, Infinity, "5000"]) {
    for (const make of [clientServerFn, serverServerFn]) {
      assertThrows(
        () => make<Api>("t-bad", { timeoutMs: bad as number }),
        TypeError,
        "timeoutMs must be a positive finite number",
      );
    }
  }
});

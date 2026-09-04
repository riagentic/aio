// perfect-aio B3 — serverFns: the explicit, typed server/client seam.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { enc } from "../src/protocol/envelope.ts";
import {
  _resetServerFns,
  invokeServerFn,
  serverFn,
  serverFns,
} from "../src/server/server-fns.ts";
import { setConnected } from "../src/state/state-signals.ts";
import {
  _registerSfnTransport,
  _resetSfnClient,
  handleSfnResult,
  serverFn as clientServerFn,
  serverFns as clientServerFns,
} from "../src/browser/server-fns-client.ts";

Deno.test("serverFns: register + direct call + typed lazy resolver", async () => {
  _resetServerFns();
  const api = serverFns("t-api", {
    add: (a: number, b: number) => a + b,
    async fetchName() {
      return "aio";
    },
  });
  // Direct server-side use — the returned map IS the functions.
  assertEquals(api.add(2, 3), 5);

  // Lazy resolver — same signatures, promised results.
  const fns = serverFn<typeof api>("t-api");
  assertEquals(await fns.add(4, 5), 9);
  assertEquals(await fns.fetchName(), "aio");
  _resetServerFns();
});

Deno.test("serverFns: duplicate namespace + unknown fn fail loudly", async () => {
  _resetServerFns();
  serverFns("t-dup", { x: () => 1 });
  let msg = "";
  try {
    serverFns("t-dup", { y: () => 2 });
  } catch (e) {
    msg = String(e);
  }
  assert(msg.includes("already registered"), msg);

  const missing = serverFn<{ nope: () => Promise<void> }>("t-none");
  await assertRejects(() => missing.nope(), Error, "not");
  _resetServerFns();
});

Deno.test("invokeServerFn: outcome envelope — value, error, unknown", async () => {
  _resetServerFns();
  serverFns("t-inv", {
    ok: (n: number) => n * 2,
    boom: () => {
      throw new Error("kaput");
    },
  });
  assertEquals(await invokeServerFn("t-inv", "ok", [21]), {
    ok: true,
    value: 42,
  });
  const err = await invokeServerFn("t-inv", "boom", []);
  assertEquals(err.ok, false);
  assert(!err.ok && err.error.includes("kaput"));
  const unk = await invokeServerFn("t-inv", "ghost", []);
  assert(!unk.ok && unk.error.includes("not registered"));
  _resetServerFns();
});

Deno.test("invokeServerFn: inherited Object.prototype members are NOT callable", async () => {
  _resetServerFns();
  serverFns("t-proto", { greet: () => "hi" });
  // A client-controlled `name` must not resolve inherited builtins as if they
  // were registered server functions (constructor, valueOf, hasOwnProperty…).
  for (const name of ["constructor", "valueOf", "toString", "hasOwnProperty"]) {
    const r = await invokeServerFn("t-proto", name, []);
    assert(!r.ok, `${name} must not be invocable`);
    assert(r.error.includes("not registered"), `${name}: ${r.error}`);
  }
  // The real own function still works.
  assertEquals(await invokeServerFn("t-proto", "greet", []), {
    ok: true,
    value: "hi",
  });
  // Same guard on the lazy resolver proxy.
  const fns = serverFn<{ greet: () => Promise<string> }>("t-proto");
  await assertRejects(
    () =>
      (fns as unknown as { constructor: () => Promise<unknown> })
        .constructor(),
    Error,
    "not",
  );
  _resetServerFns();
});

Deno.test("browser proxy: request/response over a fake transport, errors + parity", async () => {
  _resetSfnClient();
  _resetServerFns();
  serverFns("t-rt", {
    greet: (name: string) => `hi ${name}`,
    fail: () => {
      throw new Error("denied");
    },
  });

  // Fake transport: client "sfn" frames are served by the REAL server invoke.
  setConnected(true); // a registered transport that is not connected DROPS
  _registerSfnTransport((raw) => {
    const { d } = JSON.parse(raw) as {
      d: { cid: string; ns: string; name: string; args: unknown[] };
    };
    invokeServerFn(d.ns, d.name, d.args).then((result) => {
      handleSfnResult({ cid: d.cid, ...result });
    });
    return true;
  });

  const api = clientServerFn<{ greet: (n: string) => Promise<string> }>("t-rt");
  assertEquals(await api.greet("dev"), "hi dev");

  const failing = clientServerFn<{ fail: () => Promise<void> }>("t-rt");
  const err = await assertRejects(() => failing.fail(), Error);
  assert(err.message.includes("[server] denied"), err.message);

  _resetSfnClient();
  _resetServerFns();
});

Deno.test("browser: HOSTING server fns in the browser throws the seam error", () => {
  let msg = "";
  try {
    clientServerFns("t-host", { x: () => 1 });
  } catch (e) {
    msg = String(e);
  }
  assert(msg.includes("*.server.ts"), msg);
});

// ── The wire guard: a serverFn's RESULT and its ARGUMENTS ──
//
// Both cross the same JSON wire as a cell method's return value, which has had
// a loud guard (serializeReturn) since alpha43 — the serverFn seam had none in
// either direction. What that cost: `enc("sfnr", …)` THROWS on a BigInt or a
// cycle, and both send sites wrap it in `try { … } catch { /* client gone */ }`,
// so the reply was never sent, the throw was swallowed as a disconnect, and the
// caller sat for 30s before rejecting with "server unreachable or the function
// hung". Everything else JSON rewrote silently.

Deno.test("invokeServerFn: an unencodable result fails LOUD, never as a dropped frame", async () => {
  _resetServerFns();
  const cyc: Record<string, unknown> = {};
  cyc.self = cyc;
  serverFns("t-wire", {
    big: () => 10n,
    cycle: () => cyc,
    bare: () => () => 1,
    fine: () => ({ ok: 1 }),
  });
  for (const name of ["big", "cycle", "bare"]) {
    const r = await invokeServerFn("t-wire", name, []);
    assert(!r.ok, `${name} must not report success`);
    assert(r.error.includes("cannot"), r.error);
    assert(r.error.includes(`t-wire.${name}`), r.error);
    assert(r.error.includes("DID run"), r.error);
    // THE point: the outcome the send sites encode must never throw — that
    // throw is what silently dropped the reply.
    enc("sfnr", { cid: "c", ...r });
  }
  assertEquals(await invokeServerFn("t-wire", "fine", []), {
    ok: true,
    value: { ok: 1 },
  });
  _resetServerFns();
});

Deno.test("invokeServerFn: a lossy result is vetted at the ONE site, so both transports send the same bytes", async () => {
  _resetServerFns();
  serverFns("t-lossy", {
    when: () => new Date("2020-01-02T03:04:05Z"),
    m: () => new Map([["a", 1]]),
    n: () => ({ n: NaN }),
  });
  // The value in the envelope is already what the client will parse — no
  // send-site-specific JSON step can reintroduce a difference.
  const d = await invokeServerFn("t-lossy", "when", []);
  assertEquals(d, { ok: true, value: "2020-01-02T03:04:05.000Z" });
  assertEquals(await invokeServerFn("t-lossy", "m", []), {
    ok: true,
    value: {},
  });
  assertEquals(await invokeServerFn("t-lossy", "n", []), {
    ok: true,
    value: { n: null },
  });
  _resetServerFns();
});

Deno.test("browser proxy: an unencodable ARGUMENT is refused by name, before anything is registered", async () => {
  _resetSfnClient();
  _resetServerFns();
  serverFns("t-args", { take: (...a: unknown[]) => a.length });
  const sent: string[] = [];
  setConnected(true); // a registered transport that is not connected DROPS
  _registerSfnTransport((raw) => {
    sent.push(raw);
    const { d } = JSON.parse(raw) as {
      d: { cid: string; ns: string; name: string; args: unknown[] };
    };
    invokeServerFn(d.ns, d.name, d.args).then((r) =>
      handleSfnResult({ cid: d.cid, ...r })
    );
    return true;
  });
  const api = clientServerFn<{ take: (...a: unknown[]) => Promise<number> }>(
    "t-args",
  );
  const cyc: Record<string, unknown> = {};
  cyc.self = cyc;
  for (const bad of [1n, cyc]) {
    const err = await assertRejects(() => api.take(bad), Error);
    // Was a bare "TypeError: Do not know how to serialize a BigInt" that named
    // neither the namespace nor the function.
    assert(err.message.includes('serverFn("t-args").take'), err.message);
    assert(err.message.includes("nothing was sent"), err.message);
  }
  assertEquals(sent.length, 0, "a refused call must put nothing on the wire");
  // …and must not have consumed a cid or armed a 30s timeout: the very next
  // call is #1. (The throw used to escape AFTER _pending.set + setTimeout.)
  await api.take("ok");
  const cid = (JSON.parse(sent[0]!) as { d: { cid: string } }).d.cid;
  assert(cid.startsWith("sfn-1-"), `refused call leaked state: ${cid}`);
  _resetSfnClient();
  _resetServerFns();
});

Deno.test("browser proxy: lossy ARGUMENTS warn loudly — the other direction of the same guard", async () => {
  _resetSfnClient();
  _resetServerFns();
  let seen: unknown[] = [];
  serverFns("t-argl", {
    take: (...a: unknown[]) => {
      seen = a;
      return "ok";
    },
  });
  setConnected(true); // a registered transport that is not connected DROPS
  _registerSfnTransport((raw) => {
    const { d } = JSON.parse(raw) as {
      d: { cid: string; ns: string; name: string; args: unknown[] };
    };
    invokeServerFn(d.ns, d.name, d.args).then((r) =>
      handleSfnResult({ cid: d.cid, ...r })
    );
    return true;
  });
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
  try {
    const api = clientServerFn<{ take: (...a: unknown[]) => Promise<string> }>(
      "t-argl",
    );
    await api.take(new Date("2020-01-01T00:00:00Z"), new Map([["a", 1]]), NaN);
    // The corruption is real and unavoidable — the point is that it is NAMED.
    assertEquals(seen, ["2020-01-01T00:00:00.000Z", {}, null]);
  } finally {
    console.warn = orig;
  }
  const all = warnings.join("\n");
  assert(all.includes('serverFn("t-argl").take'), all);
  assert(all.includes("args[0]: Date → string"), all);
  assert(all.includes("args[1]: Map → Object"), all);
  assert(all.includes("args[2]: NaN → null"), all);

  // An exact call stays silent — a guard that cries wolf is a guard nobody reads.
  warnings.length = 0;
  console.warn = (...a: unknown[]) => void warnings.push(a.join(" "));
  try {
    const api = clientServerFn<{ take: (...a: unknown[]) => Promise<string> }>(
      "t-argl",
    );
    await api.take({ id: 1, tags: ["a"] }, null, true);
  } finally {
    console.warn = orig;
  }
  assertEquals(warnings, []);
  _resetSfnClient();
  _resetServerFns();
});

// ── In-flight calls must SETTLE when the connection does ─────────────
//
// Measured before the fix: `_pending` had no disconnect/teardown path at all,
// so a call whose socket died waited out the full 30s and then reported
// "server unreachable or the function hung" — about a call the client itself
// had already lost. And a call made while offline was dropped by the raw send
// with no queue, no error and no trace: the same 30s of silence.

Deno.test("browser proxy: a disconnect settles in-flight calls at once", async () => {
  _resetSfnClient();
  _resetServerFns();
  setConnected(true);
  _registerSfnTransport(
    () => true, // the frame leaves; the server just never replies
  );
  const api = clientServerFn<{ slow: () => Promise<void> }>("t-drop");
  const call = api.slow();
  // The socket dies. The frame is gone; nothing will ever answer it.
  setConnected(false);
  const err = await assertRejects(() => call, Error);
  assert(err.message.includes('serverFn("t-drop").slow'), err.message);
  assert(err.message.includes("connection"), err.message);
  assert(
    !err.message.includes("timed out"),
    `must not be reported as a timeout: ${err.message}`,
  );
  _resetSfnClient();
  _resetServerFns();
});

Deno.test("browser proxy: a call made while offline fails immediately, not in 30s", async () => {
  _resetSfnClient();
  _resetServerFns();
  const sent: string[] = [];
  setConnected(false);
  _registerSfnTransport((raw) => {
    sent.push(raw);
    return true;
  });
  const api = clientServerFn<{ go: () => Promise<void> }>("t-off");
  const started = Date.now();
  const err = await assertRejects(() => api.go(), Error);
  assert(Date.now() - started < 1000, "must not wait out the 30s ceiling");
  assert(err.message.includes('serverFn("t-off").go'), err.message);
  assert(err.message.includes("never queued"), err.message);
  assertEquals(sent.length, 0, "nothing may go on a dead wire");
  _resetSfnClient();
  _resetServerFns();
});

Deno.test("browser proxy: resetting the client settles what it drops", async () => {
  _resetSfnClient();
  _resetServerFns();
  setConnected(true);
  _registerSfnTransport(() => true);
  const api = clientServerFn<{ hang: () => Promise<void> }>("t-reset");
  const call = api.hang();
  _resetSfnClient(); // teardown: the pending entry is discarded…
  const err = await assertRejects(() => call, Error); // …so its caller hears it
  assert(err.message.includes('serverFn("t-reset").hang'), err.message);
  _resetServerFns();
});

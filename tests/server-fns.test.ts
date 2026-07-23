// perfect-aio B3 — serverFns: the explicit, typed server/client seam.
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  _resetServerFns,
  invokeServerFn,
  serverFn,
  serverFns,
} from "../src/server/server-fns.ts";
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
  _registerSfnTransport((raw) => {
    const { d } = JSON.parse(raw) as {
      d: { cid: string; ns: string; name: string; args: unknown[] };
    };
    invokeServerFn(d.ns, d.name, d.args).then((result) => {
      handleSfnResult({ cid: d.cid, ...result });
    });
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

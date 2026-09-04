// a field report CRITICAL #0 (2026-07-24): `am dispatch` (→ trojan POST /dispatch) used
// to ack ANY action type with {ok:true} and fire-and-forget, so a bogus method,
// or the `cell.method` (dot) form the reducer's `cell:method` (colon) form never
// matched, silently no-op'd under a green "ok". Now: a method-form type is
// validated against the booted cells, the separator is normalized, and the
// dispatch is awaited — `ok` means EXECUTED, unknown methods are errors.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  _nearestMethod,
  handleTrojan,
  type TrojanDeps,
} from "../src/server/server-trojan.ts";

function makeDeps() {
  const dispatched: { type: string }[] = [];
  let nextDispatch: (() => Promise<unknown>) | null = null;
  const deps = {
    dispatch: (a: unknown) => {
      dispatched.push(a as { type: string });
      return nextDispatch ? nextDispatch() : Promise.resolve();
    },
    getUIState: () => ({}),
    debug: () => {},
    prod: false,
    trojan: {
      cellMethods: () => ({
        nav: ["setStatusBarMessage"],
        counter: ["inc", "tick"],
      }),
      cellAsyncMethods: () => ({ counter: ["inc"] }),
      cellMethodArity: () => ({
        // setStatusBarMessage(s, msg) · inc(s, by) · tick(s)
        nav: { setStatusBarMessage: 1 },
        counter: { inc: 1, tick: 0 },
      }),
      getState: () => ({}),
      startedAt: Date.now(),
    },
  } as unknown as TrojanDeps;
  return {
    deps,
    dispatched,
    failNext: (fn: () => Promise<unknown>) => {
      nextDispatch = fn;
    },
  };
}

async function dispatch(deps: TrojanDeps, body: unknown) {
  const req = new Request("http://x/__aio/trojan/dispatch", {
    method: "POST",
    headers: { "content-type": "application/json", "x-aio": "1" },
    body: JSON.stringify(body),
  });
  const resp = await handleTrojan("/__aio/trojan/dispatch", req, deps)!;
  return {
    status: resp.status,
    body: await resp.json() as Record<string, unknown>,
  };
}

Deno.test("trojan dispatch: a known cell:method executes (ok means executed)", async () => {
  const { deps, dispatched } = makeDeps();
  const r = await dispatch(deps, {
    type: "nav:setStatusBarMessage",
    payload: { args: ["hi"] },
  });
  assertEquals(r.status, 200);
  assertEquals(r.body.ok, true);
  assertEquals(dispatched[0]!.type, "nav:setStatusBarMessage");
});

Deno.test("trojan dispatch: the cell.method (dot) form is normalized and runs", async () => {
  const { deps, dispatched } = makeDeps();
  const r = await dispatch(deps, {
    type: "nav.setStatusBarMessage",
    payload: { args: ["hi"] },
  });
  assertEquals(r.body.ok, true);
  assertEquals(dispatched[0]!.type, "nav:setStatusBarMessage"); // normalized
});

Deno.test("trojan dispatch: a bogus method is a 404 ERROR, not a silent ok", async () => {
  const { deps, dispatched } = makeDeps();
  const r = await dispatch(deps, { type: "nav.bogusmethod" });
  assertEquals(r.status, 404);
  assert(String(r.body.error).includes("no method"), r.body.error as string);
  assertEquals(dispatched.length, 0, "must NOT dispatch a bogus method");
});

Deno.test("trojan dispatch: an unknown cell is a 404 ERROR", async () => {
  const { deps, dispatched } = makeDeps();
  const r = await dispatch(deps, { type: "rud.bogusmethod" });
  assertEquals(r.status, 404);
  assert(String(r.body.error).includes("unknown cell"), r.body.error as string);
  assertEquals(dispatched.length, 0);
});

Deno.test("trojan dispatch: a rejecting method surfaces as an error", async () => {
  const { deps, failNext } = makeDeps();
  failNext(() => Promise.reject(new Error("method blew up")));
  const r = await dispatch(deps, {
    type: "counter:inc",
    payload: { args: [1] },
  });
  assertEquals(r.body.ok, undefined);
  assert(
    String(r.body.error).includes("method blew up"),
    r.body.error as string,
  );
});

// Every action a cell handles is `<cell>:<method>`, so in an app made of cells
// a bare type reaches nothing — and it used to do that under {"ok":true}.
Deno.test("trojan dispatch: a bare type in a cells app is refused, with the nearest method named", async () => {
  const { deps, dispatched } = makeDeps();
  const r = await dispatch(deps, { type: "inc", payload: { by: 1 } });
  assertEquals(r.status, 404);
  assertEquals(dispatched.length, 0, "nothing was dispatched into the void");
  assertStringIncludes(String(r.body.error), "Did you mean counter:inc?");
  assertStringIncludes(String(r.body.error), "nav:setStatusBarMessage");
});

Deno.test("trojan dispatch: a bare type is only refused when the server can list cells", async () => {
  const { deps, dispatched } = makeDeps();
  (deps.trojan as { cellMethods?: unknown }).cellMethods = () => ({});
  const r = await dispatch(deps, { type: "Increment", payload: { by: 1 } });
  assertEquals(r.body.ok, true);
  assertEquals(dispatched[0]!.type, "Increment");
});

// Without a correlation id `dispatch` resolves with the early reduce result,
// so an async method that throws after its first `await` was logged as
// EFFECT_ASYNC_ERROR while this route had already answered {"ok":true}.
Deno.test("trojan dispatch: the route forwards the payload and mints no id of its own", async () => {
  // The correlation id that makes an async method's THROW (and its return
  // value) reach the caller used to be stamped here, privately, by this route
  // — which is why the operator's door answered honestly while the WS and UDS
  // doors reported `{ok:true, value:undefined}` for a method that threw. It is
  // minted in `dispatchNetwork` (aio-server.ts) as of alpha76, for all three
  // doors at once, and a client-supplied one is stripped as forged.
  //
  // This test drives a FAKE dispatch, so the mint is out of its reach by
  // construction. The real path is covered end to end by
  // tests/trojan-async-rejection-reaches-caller.test.ts (this route) and
  // tests/ack-async-bare-frame.test.ts (the WS door, with a bare documented
  // frame), and the mutation ledger now points at the new line.
  const { deps, dispatched } = makeDeps();
  await dispatch(deps, { type: "counter:inc", payload: { args: [1] } });
  const pl =
    (dispatched[0] as { payload?: { _callId?: unknown; args?: unknown } })
      .payload;
  assertEquals(pl?.args, [1], "the caller's payload is kept");
  assertEquals(pl?._callId, undefined, "this route mints nothing");
});

Deno.test("trojan dispatch: the nearest method is judged on the method half, within two edits", () => {
  const all = ["counter:increment", "nav:setStatusBarMessage"];
  assertEquals(_nearestMethod("incremnt", all), "counter:increment");
  assertEquals(_nearestMethod("Increment", all), "counter:increment");
  assertEquals(_nearestMethod("frobnicate", all), null);
});

// A client INDEX where the action goes — the mistake `am`'s own vocabulary
// invites, because `am trigger 0 …` and `am surface 0` DO take one. It used to
// dispatch `{type:"0"}` into the void and answer {"ok":true}: a predictable
// user error reported as success, which is the one outcome this project treats
// as disqualifying.
Deno.test("trojan dispatch: a client index as the type is refused, not acked", async () => {
  const { deps, dispatched } = makeDeps();
  const r = await dispatch(deps, { type: "0", payload: {} });
  assertEquals(r.status, 404);
  assertEquals(r.body.ok, undefined, "must never report success");
  const msg = String(r.body.error);
  assert(msg.includes("client index"), msg); // names the actual confusion
  assert(msg.includes("nav:setStatusBarMessage"), msg); // and what to type
  assertEquals(dispatched.length, 0, "nothing may be dispatched");
});

Deno.test("trojan dispatch: the method's return value is in the reply (`result`), absent when undefined", async () => {
  const { deps, failNext } = makeDeps();
  failNext(() => Promise.resolve({ balance: 42, tags: ["a"] }));
  const r = await dispatch(deps, {
    type: "counter:inc",
    payload: { args: [1] },
  });
  assertEquals(r.status, 200);
  assertEquals(r.body, { ok: true, result: { balance: 42, tags: ["a"] } });

  failNext(() => Promise.resolve(undefined));
  const none = await dispatch(deps, {
    type: "counter:inc",
    payload: { args: [1] },
  });
  assertEquals(none.body, { ok: true });

  // A value JSON cannot carry is flagged, never silently turned into null.
  failNext(() => Promise.resolve(() => 1));
  const fn = await dispatch(deps, {
    type: "counter:inc",
    payload: { args: [1] },
  });
  assertEquals(fn.body, { ok: true, resultDropped: true });
});

// A sync method never reaches the async executor, and the reducer resolves a
// stray id as "blocked" — so one must not be minted for it. (The lab caught
// this: three `am dispatch` calls on a scaffold's sync methods answered 400.)
Deno.test("trojan dispatch: a SYNC cell:method call carries no _callId", async () => {
  const { deps, dispatched } = makeDeps();
  const r = await dispatch(deps, {
    type: "counter:tick",
    payload: { args: [] },
  });
  assertEquals(r.body.ok, true);
  const pl = (dispatched[0] as { payload?: { _callId?: unknown } }).payload;
  assertEquals(pl?._callId, undefined);
});

// 50audits §7: the route refused an unknown CELL and an unknown METHOD by
// name, and never asked how many arguments a KNOWN method takes — though the
// count was right there. `am dispatch todo:add` (for `add(s, text: string)`)
// answered `{"ok":true}`, ran `add(s, undefined)`, and put a row whose declared
// field is gone into state and onto the screen.
Deno.test("trojan dispatch: a SHORT call is refused by name, not acked", async () => {
  const { deps, dispatched } = makeDeps();
  const r = await dispatch(deps, { type: "nav:setStatusBarMessage" });
  assertEquals(r.status, 400);
  assertStringIncludes(String(r.body.error), "takes 1 argument");
  assertStringIncludes(String(r.body.error), "passes none");
  assertStringIncludes(String(r.body.error), "Dispatch does nothing");
  assertEquals(dispatched.length, 0, "nothing may reach the reducer");
});

Deno.test("trojan dispatch: a NAMED payload for a methods cell states no arguments", async () => {
  const { deps, dispatched } = makeDeps();
  // Not what `am dispatch nav:setStatusBarMessage msg=hi` sends — `am` wraps
  // named pairs into `{ args: [{…}] }` for a `cell:method` type
  // (`envelopePayload`), which is a stated argument list and passes. This is
  // the RAW shape: a direct POST (or another client) putting the named pairs
  // in the payload itself. `methodArgs` reads `payload.args`, so the method
  // receives NOTHING and the named keys are silently dropped.
  const r = await dispatch(deps, {
    type: "nav:setStatusBarMessage",
    payload: { msg: "hi" },
  });
  assertEquals(r.status, 400);
  assertStringIncludes(String(r.body.error), "positional");
  assertEquals(dispatched.length, 0);
});

// The spelling `am` actually produces for named pairs, which must keep working
// — it is in `DISPATCH_USAGE` and in docs/clients/app-manager.md.
Deno.test("trojan dispatch: `am`'s named-pair envelope still runs", async () => {
  const { deps, dispatched } = makeDeps();
  const r = await dispatch(deps, {
    type: "nav:setStatusBarMessage",
    payload: { args: [{ msg: "hi" }] }, // what envelopePayload builds
  });
  assertEquals(r.status, 200);
  assertEquals(dispatched.length, 1);
});

Deno.test("trojan dispatch: a full call and a zero-arg method still run", async () => {
  const { deps, dispatched } = makeDeps();
  assertEquals(
    (await dispatch(deps, {
      type: "nav:setStatusBarMessage",
      payload: { args: ["hi"] },
    })).status,
    200,
  );
  assertEquals((await dispatch(deps, { type: "counter:tick" })).status, 200);
  assertEquals(dispatched.length, 2);
});

Deno.test("trojan dispatch: EXTRA arguments are allowed — a default or rest ends fn.length", async () => {
  const { deps } = makeDeps();
  const r = await dispatch(deps, {
    type: "counter:inc",
    payload: { args: [1, 2, 3] },
  });
  assertEquals(r.status, 200);
});

// The compatibility line. `fn.length` stops at the first parameter with a
// default, so a method that fills its own in (`reset(s, to) { to ??= 0 }`)
// reads as requiring an argument it does not — and refusing on COUNT would
// break a call that works today. An `args` array is the caller stating their
// arguments, and is taken at its word however short.
Deno.test("trojan dispatch: a STATED argument list is never second-guessed", async () => {
  const { deps, dispatched } = makeDeps();
  // Explicitly empty: "this method fills in its own defaults."
  assertEquals(
    (await dispatch(deps, {
      type: "nav:setStatusBarMessage",
      payload: { args: [] },
    })).status,
    200,
  );
  // Short but stated, for a method whose later parameters have defaults.
  assertEquals(
    (await dispatch(deps, { type: "counter:inc", payload: { args: [] } }))
      .status,
    200,
  );
  assertEquals(dispatched.length, 2);
});

Deno.test("trojan dispatch: an app that publishes no arity map is unchanged", async () => {
  const { deps, dispatched } = makeDeps();
  (deps as unknown as { trojan: { cellMethodArity?: unknown } }).trojan
    .cellMethodArity = undefined;
  assertEquals(
    (await dispatch(deps, { type: "nav:setStatusBarMessage" })).status,
    200,
  );
  assertEquals(dispatched.length, 1);
});

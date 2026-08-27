// The gate that stops a NETWORK client dispatching a framework-internal action
// — `cell:__setMethod`, `cell:__exec`, `cell:__Destroy`, `__init` — pinned at
// every entry point that enforces it.
//
// Why this file exists: a mutation probe deleted the enforcing line in
// `server-ws.ts` and the entire suite stayed green. The predicate
// (`_isFrameworkInternalActionType`) was well tested in isolation
// (tests/audit-regression/proto-pollution.test.ts) and its CALL SITES were not
// tested at all — so the check could be removed and nothing said a word. A
// tested predicate that nothing proves is called is a decoration.
//
// What the gate protects (audit F-1): internal action types carry
// server-trusted payload shapes that bypass cell method bodies entirely. A
// `cell:__setBump` frame with `{mutations:[{path:[…],value:…}]}` writes
// straight into cell state — arbitrary state mutation from anyone who can open
// a socket, and historically a prototype-pollution vector too.
//
// ONE decider, five doors: the WS action frame, the WS sync `op` frame, the UDS
// action frame, the UDS sync `op` frame, and the trojan's POST /dispatch. Each
// one gets a test here that fails if its call to the decider is removed, plus a
// CONTROL — a legitimate action through the same door — so a test that passes
// because nothing at all reached dispatch cannot masquerade as enforcement.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { dec, enc } from "../src/protocol/envelope.ts";
import { freePort } from "../src/testing/server-test.ts";
import { createWsManager } from "../src/server/server-ws.ts";
import { createUDSListener } from "../src/server/aio.ts";
import { handleTrojan, type TrojanDeps } from "../src/server/server-trojan.ts";

/** Every shape the rule covers, each carrying the payload that makes it worth
 *  blocking. `n: 999` is the tell: the cell's only method adds ONE. */
const ATTACKS: { type: string; payload: Record<string, unknown> }[] = [
  // The write-set commit an async/transactional method publishes: a list of
  // mutations applied to cell state with no method body in the way.
  {
    type: "guard:__setBump",
    payload: { mutations: [{ path: ["n"], value: 999 }] },
  },
  // `__aioWorkerPatch` — the reducer applies these immer patches straight into
  // the named cell's slice, by design (a worker cell's commits come home this
  // way). Its own comment in `cell-compose-reduce.ts` reads "the network can
  // never inject it (_isFrameworkInternalActionType)". This is the frame that
  // makes that sentence true or false: with the gate gone it is a one-line
  // remote write of any value into any cell.
  {
    type: "__aioWorkerPatch",
    payload: {
      cell: "guard",
      ops: [{ op: "replace", path: ["n"], value: 999 }],
    },
  },
  { type: "guard:__exec", payload: { method: "bump" } },
  { type: "guard:__Destroy", payload: {} },
  { type: "__init", payload: {} },
];

/** The op-frame twin: `op.action` is turned back into `cell:action` and
 *  dispatched, so the same rule has to hold on this field too. */
const OP_ATTACKS = ["__setBump", "__exec", "__Destroy", "__aioWorkerPatch"];

/** A payload for the op tests — never applied, the op must not get that far. */
const MUTATION = { mutations: [{ path: ["n"], value: 999 }] };

const settle = () => new Promise((r) => setTimeout(r, 60));

// ── 1. WS action frame, end to end through a real booted app ────────────────

Deno.test("internal actions: a WS client cannot dispatch one (real app, real socket)", async () => {
  const { cell, aio } = await import("../mod.ts");
  const guard = cell("guard", {
    state: { n: 0 },
    visible: "all",
    methods: {
      bump(s: { n: number }) {
        s.n += 1;
      },
    },
  });
  const port = freePort();
  const app = await aio.run({
    cells: [guard],
    appId: "test-internal-action-ws",
    appVersion: "0.0.0",
    client: "server-only",
    persist: false,
    libraryMode: true,
    port,
    baseDir: await Deno.makeTempDir(),
  });
  const n = () => (app.getState() as { guard: { n: number } }).guard.n;

  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const t = setTimeout(() => reject(new Error("ws timeout")), 5000);
    s.onmessage = () => {
      clearTimeout(t);
      resolve(s);
    };
    s.onerror = () => {
      clearTimeout(t);
      reject(new Error("ws error"));
    };
  });

  try {
    // CONTROL: the door is open and actions really do reach dispatch.
    ws.send(enc("action", { type: "guard:bump", payload: {} }));
    await settle();
    assertEquals(n(), 1, "control: a normal action must dispatch");

    for (const a of ATTACKS) ws.send(enc("action", a));
    await settle();
    assertEquals(
      n(),
      1,
      "a framework-internal action from the network must never reduce",
    );
  } finally {
    ws.close();
    await app.close();
  }
});

// ── 2. WS sync `op` frame ────────────────────────────────────────────────────
//
// The op path returns BEFORE the action gate above (it is a different frame
// kind), and the sync handler turns `op.cell` + `op.action` back into
// `cell:action` and dispatches it — so the same rule has to be applied a second
// time, on `op.action`, or the whole gate is one frame kind away from useless.

Deno.test("internal actions: a WS sync op cannot smuggle one past the action gate", async () => {
  const ops: string[] = [];
  const port = freePort();
  const manager = createWsManager({
    dispatch: () => {},
    getUIState: () => ({}),
    debug: () => {},
    prod: false,
    clientCounter: { value: 0 },
    bootId: "boot",
    syncHandler: {
      handleOp: (op) => ops.push((op as { action: string }).action),
      handleSync: () => {},
    },
  });
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    (req) => manager.handleWs(req),
  );
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const t = setTimeout(() => reject(new Error("ws timeout")), 5000);
    s.onopen = () => {
      clearTimeout(t);
      resolve(s);
    };
    s.onerror = () => {
      clearTimeout(t);
      reject(new Error("ws error"));
    };
  });
  const op = (action: string) => ({
    id: `op-${action}`,
    cell: "guard",
    action,
    hlc: [1, 0, "c1"],
    payload: MUTATION,
  });
  try {
    ws.send(enc("op", op("bump"))); // CONTROL
    for (const action of OP_ATTACKS) ws.send(enc("op", op(action)));
    await settle();
    assertEquals(
      ops,
      ["bump"],
      "only the legitimate op may reach the sync handler",
    );
  } finally {
    ws.close();
    manager.shutdown();
    await server.shutdown();
  }
});

// ── 3 & 4. UDS — the desktop transport, same rule ────────────────────────────
//
// Electron's window talks over a unix socket, not a WebSocket. It decodes its
// own frames, so "the WS server checks it" protects nothing here.

async function udsRoundTrip(
  frames: string[],
  syncHandler?: unknown,
): Promise<{ actions: string[]; ops: string[] }> {
  const actions: string[] = [];
  const ops: string[] = [];
  const socketPath = join(await Deno.makeTempDir(), "fi.sock");
  const handler = syncHandler ?? {
    handleOp: (op: unknown) => ops.push((op as { action: string }).action),
    handleSync: () => {},
  };
  const uds = createUDSListener(
    socketPath,
    () => ({}),
    (a) => {
      actions.push(a.type);
    },
    () => {},
    undefined,
    // deno-lint-ignore no-explicit-any
    handler as any,
  );
  await settle();
  const conn = await Deno.connect({ path: socketPath, transport: "unix" });
  const writer = conn.writable.getWriter();
  for (const f of frames) {
    await writer.write(new TextEncoder().encode(f + "\n"));
  }
  await settle();
  writer.releaseLock();
  try {
    conn.close();
  } catch { /* already closed */ }
  uds.shutdown();
  await settle();
  return { actions, ops };
}

Deno.test("internal actions: a UDS client cannot dispatch one", async () => {
  const { actions } = await udsRoundTrip([
    enc("action", { type: "guard:bump", payload: {} }), // CONTROL
    ...ATTACKS.map((a) => enc("action", a)),
  ]);
  assertEquals(
    actions,
    ["guard:bump"],
    "only the legitimate action may reach dispatch over UDS",
  );
});

Deno.test("internal actions: a UDS sync op cannot smuggle one either", async () => {
  const op = (action: string) => ({
    id: `op-${action}`,
    cell: "guard",
    action,
    hlc: [1, 0, "c1"],
    payload: MUTATION,
  });
  const { ops } = await udsRoundTrip([
    enc("op", op("bump")), // CONTROL
    ...OP_ATTACKS.map((a) => enc("op", op(a))),
  ]);
  assertEquals(ops, ["bump"], "only the legitimate op may reach sync");
});

// ── 5. Trojan POST /dispatch ─────────────────────────────────────────────────
//
// Dev-only and loopback-only, which is a smaller blast radius and not an
// exemption: it is a network-borne HTTP route that dispatches whatever it is
// given. Its `<cell>:<method>` validation happens to reject a `__set…` method
// on a booted cell, but only when the cell is booted AND some cell exposes
// methods — so the gate, not the validator, is what makes the rule hold.

function trojanDeps(cellMethods: Record<string, string[]>) {
  const dispatched: string[] = [];
  const deps = {
    dispatch: (a: unknown) => {
      dispatched.push((a as { type: string }).type);
      return Promise.resolve();
    },
    getUIState: () => ({}),
    debug: () => {},
    prod: false,
    trojan: {
      cellMethods: () => cellMethods,
      getState: () => ({}),
      startedAt: Date.now(),
    },
  } as unknown as TrojanDeps;
  return { deps, dispatched };
}

async function trojanDispatch(deps: TrojanDeps, body: unknown) {
  const req = new Request("http://x/__aio/trojan/dispatch", {
    method: "POST",
    headers: { "content-type": "application/json", "x-aio": "1" },
    body: JSON.stringify(body),
  });
  const res = await handleTrojan("/__aio/trojan/dispatch", req, deps)!;
  return {
    status: res.status,
    body: await res.json() as Record<string, unknown>,
  };
}

Deno.test("internal actions: the trojan refuses one, loudly, and dispatches nothing", async () => {
  // No cell exposes methods → the `<cell>:<method>` validator is skipped
  // entirely, so nothing but the gate stands between this and dispatch.
  const { deps, dispatched } = trojanDeps({});
  for (const a of ATTACKS) {
    const r = await trojanDispatch(deps, a);
    assertEquals(r.status, 403, `${a.type} must be refused`);
    assert(
      String(r.body.error).includes("framework-internal"),
      `the refusal must name the cause: ${r.body.error}`,
    );
  }
  assertEquals(dispatched, [], "nothing internal may reach dispatch");

  // CONTROL: the route works.
  const ok = trojanDeps({ guard: ["bump"] });
  const r = await trojanDispatch(ok.deps, { type: "guard:bump" });
  assertEquals(r.body.ok, true);
  assertEquals(ok.dispatched, ["guard:bump"]);
});

// ── The rule is ONE predicate, and every door is known ───────────────────────

Deno.test("internal actions: no network entry point dispatches without the gate", async () => {
  // A structural backstop for the doors above: if a sixth network path grows a
  // dispatch call, this fails until it either uses the shared decider or is
  // deliberately listed. It cannot replace the behavioural tests (it would pass
  // on a call whose result is ignored) — it catches the door nobody thought of.
  const files = ["server-ws.ts", "uds.ts", "server-trojan.ts"];
  let sites = 0;
  for (const f of files) {
    const src = await Deno.readTextFile(
      new URL(
        `../src/server/${f}`,
        import.meta.url,
      ),
    );
    sites += src.split("_isFrameworkInternalActionType(").length - 1;
  }
  // 1 definition + 5 call sites (ws action, ws op, uds action, uds op, trojan).
  assertEquals(
    sites,
    6,
    "a network path was added or removed — pin it in this file, or say why it " +
      "cannot dispatch",
  );
});

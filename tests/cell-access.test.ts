// AUTH-1 — declarative cell `access`: rule matrix (pure) + real end-to-end
// enforcement over a booted server (libraryMode): a network caller without
// access is dropped BEFORE dispatch; an authorized caller mutates state;
// server-side code always bypasses.
import { assert, assertEquals } from "@std/assert";
import { cellAccessAllowed } from "../src/server/server-auth.ts";
import { enc } from "../src/protocol/envelope.ts";
import { freePort } from "../src/testing/server-test.ts";

const PORT = freePort();
const PORT2 = freePort();

Deno.test("cell access: sentinel-looking role strings fail loud at definition", async () => {
  const { cell } = await import("../mod.ts");
  // access is boolean | role | predicate — a string is a ROLE. The words that
  // look like sentinels ("none"/"all"/…) are almost always a mistake (a dev
  // meaning access: false), so they throw with the fix instead of silently
  // granting the nonexistent role.
  for (const bad of ["none", "None", "all", "true", "false", "public"]) {
    let threw = false;
    try {
      cell(`vault-${bad}`, { state: { x: 0 }, access: bad, methods: {} });
    } catch (e) {
      threw = true;
      assert((e as Error).message.includes("ROLE name"), (e as Error).message);
    }
    assert(threw, `access: "${bad}" must throw`);
  }
  // A real role name is fine.
  cell("vault-ok", { state: { x: 0 }, access: "admin", methods: {} });
});

Deno.test("cellAccessAllowed: rule matrix", () => {
  const admin = { id: "a", role: "admin" };
  const viewer = { id: "v", role: "viewer" };
  // true = any authenticated user
  assert(!cellAccessAllowed(true, undefined, "m"));
  assert(cellAccessAllowed(true, viewer, "m"));
  // string = exact role
  assert(cellAccessAllowed("admin", admin, "m"));
  assert(!cellAccessAllowed("admin", viewer, "m"));
  assert(!cellAccessAllowed("admin", undefined, "m"));
  // predicate sees (user, method)
  const rule = (u: { role?: string } | undefined, m: string) =>
    m === "read" || u?.role === "admin";
  assert(cellAccessAllowed(rule, undefined, "read"));
  assert(!cellAccessAllowed(rule, viewer, "write"));
  assert(cellAccessAllowed(rule, admin, "write"));

  // predicate ALSO sees the method's call args → row-level authz (realitio):
  // "edit only your own row". The args are forwarded from payload.args.
  const ownRow = (
    u: { id?: string } | undefined,
    _m: string,
    ownerId?: unknown,
  ) => u?.id === ownerId;
  assert(cellAccessAllowed(ownRow, viewer, "edit", ["v"]), "owner may edit");
  assert(!cellAccessAllowed(ownRow, viewer, "edit", ["a"]), "not your row");
  // no args (e.g. sync path) → predicate still callable, args are undefined
  assert(!cellAccessAllowed(ownRow, viewer, "edit"));
  // false = server-side only
  assert(!cellAccessAllowed(false, admin, "m"));
});

/** Open a WS with a token and wait until the first state frame (connected). */
function connect(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
    const t = setTimeout(() => {
      ws.close();
      reject(new Error("ws timeout"));
    }, 3000);
    ws.onmessage = () => {
      clearTimeout(t);
      resolve(ws);
    };
    ws.onerror = () => {
      clearTimeout(t);
      reject(new Error("ws error"));
    };
  });
}

Deno.test("cell access: network callers gated, server code bypasses (e2e)", async () => {
  const { cell, aio } = await import("../mod.ts");
  const vault = cell("vault", {
    state: { writes: 0 },
    access: "admin",
    methods: {
      bump(s: { writes: number }) {
        s.writes += 1;
      },
    },
  });

  const app = await aio.run({
    cells: [vault],
    appId: "test-cell-access",
    appVersion: "0.0.0",
    client: "server-only",
    persist: false,
    libraryMode: true,
    port: PORT,
    baseDir: await Deno.makeTempDir(),
    users: {
      "tok-admin": { id: "root", role: "admin" },
      "tok-view": { id: "eve", role: "viewer" },
    },
  });

  type S = { vault: { writes: number } };
  const writes = () => (app.getState() as unknown as S).vault.writes;
  const send = (ws: WebSocket) =>
    ws.send(enc("action", { type: "vault:bump", payload: {} }));
  const settle = () => new Promise((r) => setTimeout(r, 80));

  try {
    // Viewer's network action must be dropped by the access gate.
    const eve = await connect("tok-view");
    send(eve);
    await settle();
    assertEquals(writes(), 0, "viewer action must be dropped");
    eve.close();

    // Admin's network action passes.
    const root = await connect("tok-admin");
    send(root);
    await settle();
    assertEquals(writes(), 1, "admin action must dispatch");
    root.close();

    // Server-side call bypasses the gate entirely.
    vault.bump();
    await settle();
    assertEquals(writes(), 2, "server-side call must bypass access");
  } finally {
    await app.close();
  }
});

Deno.test("cell access: row-level predicate sees method args over the wire (e2e)", async () => {
  const { cell, aio } = await import("../mod.ts");
  // "edit only your OWN doc": the predicate reads the method's first arg (docId)
  // and compares to the doc's owner. This is the realitio row-level ask, proven
  // end to end — the args must survive the wire and reach the predicate.
  const owners: Record<string, string> = { d1: "alice", d2: "bob" };
  const docs = cell("docs", {
    state: { edited: [] as string[] },
    access: (u: { id?: string } | undefined, _m: string, docId?: unknown) =>
      typeof docId === "string" && owners[docId] === u?.id,
    methods: {
      edit(s: { edited: string[] }, docId: string) {
        s.edited.push(docId);
      },
    },
  });

  const port = PORT2;
  const app = await aio.run({
    cells: [docs],
    appId: "test-cell-access-row",
    appVersion: "0.0.0",
    client: "server-only",
    persist: false,
    libraryMode: true,
    port,
    baseDir: await Deno.makeTempDir(),
    users: {
      "tok-alice": { id: "alice", role: "user" },
      "tok-bob": { id: "bob", role: "user" },
    },
  });

  const edited = () =>
    (app.getState() as unknown as { docs: { edited: string[] } }).docs.edited;
  const connectP = (token: string) =>
    new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
      const t = setTimeout(
        () => (ws.close(), reject(new Error("timeout"))),
        3000,
      );
      ws.onmessage = () => (clearTimeout(t), resolve(ws));
      ws.onerror = () => (clearTimeout(t), reject(new Error("ws error")));
    });
  const editDoc = (ws: WebSocket, docId: string) =>
    ws.send(enc("action", { type: "docs:edit", payload: { args: [docId] } }));
  const settle = () => new Promise((r) => setTimeout(r, 80));

  try {
    const alice = await connectP("tok-alice");
    // alice edits her own doc → allowed
    editDoc(alice, "d1");
    await settle();
    assertEquals(edited(), ["d1"], "owner edit passes");
    // alice edits bob's doc → denied by the row-level predicate
    editDoc(alice, "d2");
    await settle();
    assertEquals(edited(), ["d1"], "non-owner edit dropped");
    alice.close();
  } finally {
    await app.close();
  }
});

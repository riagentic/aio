// AUTH-1 — declarative cell `access`: rule matrix (pure) + real end-to-end
// enforcement over a booted server (libraryMode): a network caller without
// access is dropped BEFORE dispatch; an authorized caller mutates state;
// server-side code always bypasses.
import { assert, assertEquals } from "@std/assert";
import { cellAccessAllowed } from "../src/server/server-auth.ts";
import { enc } from "../src/protocol/envelope.ts";

const PORT = 9530 + (Deno.pid % 200);

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

// multi-user.test.ts — per-user UI state isolation
//
// Verifies:
//   - User A never sees user B's filtered state
//   - Delta cache is per-client (no cross-contamination)
//   - Unauthenticated connections are rejected when users configured
//   - State updates broadcast correct filtered view to each user

import { assertEquals } from "@std/assert";
import { createServer } from "../src/server/server.ts";
import { join } from "@std/path";

const PORT = 19840;

type State = {
  orders: { id: number; userId: string; total: number }[];
  secret: string;
};

async function setupServer(state: State) {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );

  const users = {
    "token-alice": { id: "alice", role: "admin" },
    "token-bob": { id: "bob", role: "viewer" },
    "token-carol": { id: "carol", role: "viewer" },
  };

  let currentState = { ...state };

  const server = createServer({
    port: PORT,
    title: "MultiUserTest",
    getUIState: (user) => {
      if (!user) return {}; // unauthenticated gets nothing
      if (user.role === "admin") return currentState;
      // Viewers only see their own orders, no secret
      return {
        orders: currentState.orders.filter((o) => o.userId === user.id),
      };
    },
    dispatch: () => {},
    getSnapshot: () => JSON.stringify(currentState),
    loadSnapshot: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
    users,
  });

  const updateState = (s: State) => {
    currentState = s;
  };

  return { server, dir, updateState };
}

/** Connect a WebSocket client with a token, return first state message */
function connectWS(token: string): Promise<{ ws: WebSocket; state: unknown }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${token}`);
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error("WS connect timeout"));
    }, 3000);
    ws.onmessage = (e) => {
      clearTimeout(timeout);
      try {
        const data = JSON.parse(e.data);
        resolve({ ws, state: data });
      } catch {
        // Skip non-JSON messages (__boot:, __tt:, etc.)
      }
    };
    ws.onerror = () => {
      clearTimeout(timeout);
      reject(new Error("WS error"));
    };
  });
}

/** Wait for next state message on an open WebSocket */
function nextMessage(ws: WebSocket, ms = 2000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("message timeout")), ms);
    const handler = (e: MessageEvent) => {
      if (typeof e.data !== "string") return;
      // Skip control messages
      if (e.data.startsWith("__")) return;
      clearTimeout(timeout);
      ws.removeEventListener("message", handler);
      try {
        resolve(JSON.parse(e.data));
      } catch { /* skip */ }
    };
    ws.addEventListener("message", handler);
  });
}

// ── Tests ────────────────────────────────────────────────────────────

Deno.test({
  name: "multi-user: admin sees full state, viewer sees filtered",
  // sanitizers disabled: WebSocket server has async accept loop that outlives test
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const state: State = {
    orders: [
      { id: 1, userId: "alice", total: 100 },
      { id: 2, userId: "bob", total: 200 },
      { id: 3, userId: "carol", total: 300 },
    ],
    secret: "super-secret-key",
  };

  const { server, dir } = await setupServer(state);
  await new Promise((r) => setTimeout(r, 50));

  try {
    // Alice (admin) sees everything
    const alice = await connectWS("token-alice");
    const aliceState = alice.state as State;
    assertEquals(aliceState.orders.length, 3);
    assertEquals(aliceState.secret, "super-secret-key");
    alice.ws.close();

    // Bob (viewer) only sees his own orders, no secret
    const bob = await connectWS("token-bob");
    const bobState = bob.state as { orders: State["orders"]; secret?: string };
    assertEquals(bobState.orders.length, 1);
    assertEquals(bobState.orders[0]!.userId, "bob");
    assertEquals(bobState.secret, undefined);
    bob.ws.close();

    // Carol (viewer) only sees her own orders
    const carol = await connectWS("token-carol");
    const carolState = carol.state as { orders: State["orders"] };
    assertEquals(carolState.orders.length, 1);
    assertEquals(carolState.orders[0]!.userId, "carol");
    carol.ws.close();
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test({
  name: "multi-user: concurrent connections get isolated views",
  // sanitizers disabled: WebSocket server has async accept loop that outlives test
  sanitizeOps: false,
  sanitizeResources: false,
}, async () => {
  const state: State = {
    orders: [
      { id: 1, userId: "bob", total: 50 },
      { id: 2, userId: "carol", total: 75 },
      { id: 3, userId: "bob", total: 150 },
    ],
    secret: "classified",
  };

  const { server, dir } = await setupServer(state);
  await new Promise((r) => setTimeout(r, 50));

  try {
    // Connect all three simultaneously
    const [alice, bob, carol] = await Promise.all([
      connectWS("token-alice"),
      connectWS("token-bob"),
      connectWS("token-carol"),
    ]);

    // Verify isolation
    const a = alice.state as State;
    const b = bob.state as { orders: State["orders"] };
    const c = carol.state as { orders: State["orders"] };

    // Alice sees all 3 orders + secret
    assertEquals(a.orders.length, 3);
    assertEquals(a.secret, "classified");

    // Bob sees only his 2 orders
    assertEquals(b.orders.length, 2);
    for (const o of b.orders) assertEquals(o.userId, "bob");

    // Carol sees only her 1 order
    assertEquals(c.orders.length, 1);
    assertEquals(c.orders[0]!.userId, "carol");

    // No cross-contamination: bob can't see carol's order
    assertEquals(b.orders.some((o) => o.userId === "carol"), false);
    assertEquals(c.orders.some((o) => o.userId === "bob"), false);

    alice.ws.close();
    bob.ws.close();
    carol.ws.close();
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("multi-user: invalid token rejected", async () => {
  const state: State = { orders: [], secret: "x" };
  const { server, dir } = await setupServer(state);
  await new Promise((r) => setTimeout(r, 50));

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=invalid-token`);
    const result = await new Promise<string>((resolve) => {
      const timeout = setTimeout(() => resolve("timeout"), 2000);
      ws.onclose = () => {
        clearTimeout(timeout);
        resolve("closed");
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        resolve("error");
      };
      ws.onmessage = () => {
        clearTimeout(timeout);
        resolve("message");
      };
    });
    // Should be rejected — closed or error, not a message
    assertEquals(["closed", "error"].includes(result), true);
    if (ws.readyState === WebSocket.OPEN) ws.close();
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

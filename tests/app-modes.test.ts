// Verify all 8 app modes work: local/remote × browser/electron/cli/service
// Tests use createServer + createUDSListener directly (no GUI windows)
// Each mode: boot → connect client → exchange state → verify → shutdown

import { assertEquals } from "@std/assert";
import { createServer } from "../src/server.ts";
import { createUDSListener } from "../src/aio.ts";
import { connectCli, connectCliUDS } from "../src/cli-client.ts";
import { join } from "@std/path";

// ── Helpers ──────────────────────────────────────────────────────────

async function waitFor(fn: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Create temp dir with minimal dist stub (required by createServer in prod mode) */
async function makeTempBase(): Promise<string> {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );
  return dir;
}

/** Minimal stateful server — reduce/broadcast/getState wired together */
function createApp(initial: Record<string, unknown>) {
  let state = { ...initial };
  let _broadcast: (() => void) | null = null;
  return {
    getState: () => state,
    dispatch: (action: unknown) => {
      const a = action as { type: string; payload?: Record<string, unknown> };
      if (a.type === "SET") state = { ...state, ...a.payload };
      if (a.type === "INC") {
        state = { ...state, count: (state.count as number) + 1 };
      }
      _broadcast?.();
    },
    setBroadcast: (fn: () => void) => {
      _broadcast = fn;
    },
  };
}

// Each test gets a unique port to avoid conflicts
const P = 19900;

// =====================================================================
// MODE 1: Browser Local — HTTP + WS on localhost, no auth
// =====================================================================

Deno.test("mode: browser local — serve HTML + WS state sync", async () => {
  const dir = await makeTempBase();
  const app = createApp({ count: 0, label: "browser-local" });

  const server = createServer({
    port: P + 1,
    title: "Browser Local",
    getUIState: () => app.getState(),
    dispatch: (a) => app.dispatch(a),
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
  });
  app.setBroadcast(server.broadcast);
  await new Promise((r) => setTimeout(r, 50));

  try {
    // HTTP serves HTML
    const html = await fetch(`http://127.0.0.1:${P + 1}`);
    assertEquals(html.status, 200);
    const body = await html.text();
    assertEquals(body.includes("<!DOCTYPE html>"), true);
    assertEquals(body.includes("Browser Local"), true);

    // WS connects and receives initial state
    const ws = new WebSocket(`ws://127.0.0.1:${P + 1}/ws`);
    const messages: string[] = [];
    ws.onmessage = (e) => {
      if (typeof e.data === "string") messages.push(e.data);
    };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("WS failed"));
    });
    await waitFor(() => messages.some((m) => !m.startsWith("__")));
    const initial = JSON.parse(messages.find((m) => !m.startsWith("__"))!);
    assertEquals(initial.count, 0);
    assertEquals(initial.label, "browser-local");

    // Send action via WS
    ws.send(JSON.stringify({ type: "INC" }));
    await new Promise((r) => setTimeout(r, 100));
    assertEquals(app.getState().count, 1);

    ws.close();
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

// =====================================================================
// MODE 2: Electron Local — UDS transport
// =====================================================================

Deno.test({
  name: "mode: electron local — UDS transport + state sync",
  // sanitizers disabled: UDS listener has async accept loop that outlives test
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const dir = await makeTempBase();
    const socketPath = join(dir, "electron.sock");
    const app = createApp({ count: 0, label: "electron-local" });

    const uds = createUDSListener(
      socketPath,
      () => app.getState(),
      (a) => app.dispatch(a),
      () => {},
    );

    try {
      const cli = connectCliUDS<{ count: number; label: string }>(socketPath);
      const state = await cli.ready;
      assertEquals(state.count, 0);
      assertEquals(state.label, "electron-local");

      cli.send({ type: "INC" });
      await new Promise((r) => setTimeout(r, 50));
      assertEquals(app.getState().count, 1);

      // Broadcast and verify client receives update
      uds.broadcast(JSON.stringify(app.getState()));
      await waitFor(() => cli.state?.count === 1);
      assertEquals(cli.state?.count, 1);

      cli.close();
    } finally {
      uds.shutdown();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// =====================================================================
// MODE 3: CLI Local — headless server + connectCli
// =====================================================================

Deno.test("mode: cli local — headless server + connectCli state sync", async () => {
  const dir = await makeTempBase();
  const app = createApp({ count: 0, label: "cli-local" });

  const server = createServer({
    port: P + 3,
    title: "CLI Local",
    getUIState: () => app.getState(),
    dispatch: (a) => app.dispatch(a),
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
  });
  app.setBroadcast(server.broadcast);
  await new Promise((r) => setTimeout(r, 50));

  try {
    const cli = connectCli<{ count: number; label: string }>(
      `http://127.0.0.1:${P + 3}`,
    );
    const state = await cli.ready;
    assertEquals(state.count, 0);
    assertEquals(state.label, "cli-local");

    cli.send({ type: "INC" });
    await waitFor(() => cli.state?.count === 1);
    assertEquals(cli.state?.count, 1);

    cli.send({ type: "SET", payload: { label: "updated" } });
    await waitFor(() => cli.state?.label === "updated");
    assertEquals(cli.state?.label, "updated");

    cli.close();
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

// =====================================================================
// MODE 4: Service Local — headless, trojan API
// =====================================================================

Deno.test("mode: service local — headless server + trojan API", async () => {
  const dir = await makeTempBase();
  const app = createApp({ count: 10, label: "service-local" });

  const server = createServer({
    port: P + 4,
    title: "Service Local",
    getUIState: () => app.getState(),
    dispatch: (a) => app.dispatch(a),
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
    trojan: {
      getState: () => app.getState(),
      getSchedules: () => [],
      startedAt: Date.now() - 5000,
    },
  });
  app.setBroadcast(server.broadcast);
  await new Promise((r) => setTimeout(r, 50));

  try {
    const stateResp = await fetch(
      `http://127.0.0.1:${P + 4}/__aio/trojan/state`,
    );
    assertEquals(stateResp.status, 200);
    const state = await stateResp.json();
    assertEquals(state.count, 10);

    const dispatchResp = await fetch(
      `http://127.0.0.1:${P + 4}/__aio/trojan/dispatch`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-AIO": "1" },
        body: JSON.stringify({ type: "INC" }),
      },
    );
    assertEquals(dispatchResp.status, 200);
    await dispatchResp.text(); // consume body
    assertEquals(app.getState().count, 11);

    const configResp = await fetch(
      `http://127.0.0.1:${P + 4}/__aio/trojan/config`,
    );
    assertEquals(configResp.status, 200);
    const config = await configResp.json();
    assertEquals(config.port, P + 4);
    assertEquals(config.title, "Service Local");

    const metricsResp = await fetch(
      `http://127.0.0.1:${P + 4}/__aio/trojan/metrics`,
    );
    assertEquals(metricsResp.status, 200);
    const metrics = await metricsResp.json();
    assertEquals(typeof metrics.uptime, "number");
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

// =====================================================================
// MODE 5: Browser Remote — expose + single token auth
// =====================================================================

Deno.test("mode: browser remote — expose + token auth", async () => {
  const dir = await makeTempBase();
  const token = "test-browser-remote";
  const app = createApp({ count: 0, label: "browser-remote" });

  const server = createServer({
    port: P + 5,
    title: "Browser Remote",
    getUIState: () => app.getState(),
    dispatch: (a) => app.dispatch(a),
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
    expose: true,
    token,
  });
  app.setBroadcast(server.broadcast);
  await new Promise((r) => setTimeout(r, 50));

  try {
    // No token → 401
    const noAuth = await fetch(`http://127.0.0.1:${P + 5}`);
    assertEquals(noAuth.status, 401);
    await noAuth.body?.cancel();

    // Token via query → 200
    const withToken = await fetch(`http://127.0.0.1:${P + 5}?token=${token}`);
    assertEquals(withToken.status, 200);
    const body = await withToken.text();
    assertEquals(body.includes("<!DOCTYPE html>"), true);

    // Token via header → 200
    const withHeader = await fetch(`http://127.0.0.1:${P + 5}`, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    assertEquals(withHeader.status, 200);
    await withHeader.body?.cancel();

    // Wrong token → 401
    const wrongToken = await fetch(`http://127.0.0.1:${P + 5}?token=wrong`);
    assertEquals(wrongToken.status, 401);
    await wrongToken.body?.cancel();

    // WS with token
    const ws = new WebSocket(`ws://127.0.0.1:${P + 5}/ws?token=${token}`);
    const messages: string[] = [];
    ws.onmessage = (e) => {
      if (typeof e.data === "string") messages.push(e.data);
    };
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("WS auth failed"));
    });
    await waitFor(() => messages.some((m) => !m.startsWith("__")));
    const initial = JSON.parse(messages.find((m) => !m.startsWith("__"))!);
    assertEquals(initial.label, "browser-remote");

    ws.close();
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

// =====================================================================
// MODE 6: Electron Remote — thin client via WS + token
// =====================================================================

Deno.test("mode: electron remote — expose + token, thin client via WS", async () => {
  const dir = await makeTempBase();
  const token = "test-electron-remote";
  const app = createApp({ count: 5, label: "electron-remote" });

  const server = createServer({
    port: P + 6,
    title: "Electron Remote",
    getUIState: () => app.getState(),
    dispatch: (a) => app.dispatch(a),
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
    expose: true,
    token,
  });
  app.setBroadcast(server.broadcast);
  await new Promise((r) => setTimeout(r, 50));

  try {
    const cli = connectCli<{ count: number; label: string }>(
      `http://127.0.0.1:${P + 6}`,
      { token },
    );
    const state = await cli.ready;
    assertEquals(state.count, 5);
    assertEquals(state.label, "electron-remote");

    cli.send({ type: "INC" });
    await waitFor(() => cli.state?.count === 6);
    assertEquals(cli.state?.count, 6);
    assertEquals(app.getState().count, 6);

    cli.close();
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

// =====================================================================
// MODE 7: CLI Remote — expose + token + connectCli
// =====================================================================

Deno.test("mode: cli remote — expose + token auth + connectCli", async () => {
  const dir = await makeTempBase();
  const token = "test-cli-remote";
  const app = createApp({ count: 0, label: "cli-remote" });

  const server = createServer({
    port: P + 7,
    title: "CLI Remote",
    getUIState: () => app.getState(),
    dispatch: (a) => app.dispatch(a),
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
    expose: true,
    token,
  });
  app.setBroadcast(server.broadcast);
  await new Promise((r) => setTimeout(r, 50));

  try {
    const cli = connectCli<{ count: number; label: string }>(
      `http://127.0.0.1:${P + 7}`,
      { token },
    );
    const state = await cli.ready;
    assertEquals(state.count, 0);

    cli.send({ type: "INC" });
    cli.send({ type: "INC" });
    cli.send({ type: "INC" });
    await waitFor(() => cli.state?.count === 3);
    assertEquals(cli.state?.count, 3);

    cli.send({ type: "SET", payload: { label: "remote-updated" } });
    await waitFor(() => cli.state?.label === "remote-updated");
    assertEquals(cli.state?.label, "remote-updated");

    cli.close();
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

// =====================================================================
// MODE 8: Service Remote — expose + token + trojan API
// =====================================================================

Deno.test("mode: service remote — expose + token + trojan API", async () => {
  const dir = await makeTempBase();
  const token = "test-service-remote";
  const app = createApp({ count: 42, label: "service-remote" });

  const server = createServer({
    port: P + 8,
    title: "Service Remote",
    getUIState: () => app.getState(),
    dispatch: (a) => app.dispatch(a),
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
    expose: true,
    token,
    trojan: {
      getState: () => app.getState(),
      getSchedules: () => ["heartbeat"],
      startedAt: Date.now() - 60_000,
    },
  });
  app.setBroadcast(server.broadcast);
  await new Promise((r) => setTimeout(r, 50));

  try {
    // Trojan through main server requires token when exposed
    const stateResp = await fetch(
      `http://127.0.0.1:${P + 8}/__aio/trojan/state?token=${token}`,
    );
    assertEquals(stateResp.status, 200);
    const state = await stateResp.json();
    assertEquals(state.count, 42);

    // Main HTTP requires auth
    const noAuth = await fetch(`http://127.0.0.1:${P + 8}`);
    assertEquals(noAuth.status, 401);
    await noAuth.body?.cancel();

    // Dispatch via trojan (with token)
    const dispatchResp = await fetch(
      `http://127.0.0.1:${P + 8}/__aio/trojan/dispatch?token=${token}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-AIO": "1" },
        body: JSON.stringify({ type: "INC" }),
      },
    );
    assertEquals(dispatchResp.status, 200);
    await dispatchResp.text();
    assertEquals(app.getState().count, 43);

    // Schedules (with token)
    const schedResp = await fetch(
      `http://127.0.0.1:${P + 8}/__aio/trojan/schedules?token=${token}`,
    );
    assertEquals(schedResp.status, 200);
    const schedules = await schedResp.json();
    assertEquals(schedules, ["heartbeat"]);

    // WS client with token
    const cli = connectCli<{ count: number }>(`http://127.0.0.1:${P + 8}`, {
      token,
    });
    const s = await cli.ready;
    assertEquals(s.count, 43);
    cli.close();
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

// =====================================================================
// BONUS: Multi-user auth — per-user state filtering
// =====================================================================

Deno.test("mode: multi-user — different users see different state", async () => {
  const dir = await makeTempBase();
  const app = createApp({
    count: 100,
    secret: "admin-only",
    label: "multi-user",
  });

  // Keys are tokens (resolveUser matches token against object keys)
  const users: Record<string, { id: string; token: string; role: string }> = {
    "admin-tok": { id: "admin", token: "admin-tok", role: "admin" },
    "viewer-tok": { id: "viewer", token: "viewer-tok", role: "viewer" },
  };

  const server = createServer({
    port: P + 9,
    title: "Multi-User",
    getUIState: (user) => {
      const s = app.getState();
      if (user?.role === "admin") return s;
      return { count: s.count, label: s.label };
    },
    dispatch: (a) => app.dispatch(a),
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
    users,
  });
  app.setBroadcast(server.broadcast);
  await new Promise((r) => setTimeout(r, 50));

  try {
    // Admin sees everything
    const adminCli = connectCli<{ count: number; secret?: string }>(
      `http://127.0.0.1:${P + 9}`,
      { token: "admin-tok" },
    );
    const adminState = await adminCli.ready;
    assertEquals(adminState.count, 100);
    assertEquals(adminState.secret, "admin-only");

    // Viewer sees filtered state
    const viewerCli = connectCli<{ count: number; secret?: string }>(
      `http://127.0.0.1:${P + 9}`,
      { token: "viewer-tok" },
    );
    const viewerState = await viewerCli.ready;
    assertEquals(viewerState.count, 100);
    assertEquals(viewerState.secret, undefined);

    // No token → 401
    const noAuth = await fetch(`http://127.0.0.1:${P + 9}`);
    assertEquals(noAuth.status, 401);
    await noAuth.body?.cancel();

    adminCli.close();
    viewerCli.close();
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

// =====================================================================
// BONUS: Full aio.run() with cells — end-to-end boot
// =====================================================================

Deno.test({
  name: "mode: full aio.run with cell — boot + dispatch + shutdown",
  // sanitizers disabled: aio.run() starts server + internal timers that outlive test
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const { cell, aio } = await import("../mod.ts");

    const counter = cell("counter", {
      state: { count: 0 },
      methods: {
        increment(s: { count: number }, by = 1) {
          s.count += by;
        },
        decrement(s: { count: number }, by = 1) {
          s.count -= by;
        },
        reset(s: { count: number }) {
          s.count = 0;
        },
      },
    });

    const app = await aio.run({
      cells: [counter],
      appId: "test-app-modes",
      appVersion: "0.0.0",
      client: "server-only",
      persist: false,
      singleton: false,
      port: P + 10,
      baseDir: await Deno.makeTempDir(),
    });

    type AppState = { counter: { count: number } };
    const getCount = () =>
      (app.getState() as unknown as AppState).counter.count;

    try {
      assertEquals(getCount(), 0);

      counter.increment(5);
      await new Promise((r) => setTimeout(r, 50));
      assertEquals(getCount(), 5);

      counter.decrement(2);
      await new Promise((r) => setTimeout(r, 50));
      assertEquals(getCount(), 3);

      counter.reset();
      await new Promise((r) => setTimeout(r, 50));
      assertEquals(getCount(), 0);

      // connectCli against the live server
      const cli = connectCli<{ counter: { count: number } }>(
        `http://127.0.0.1:${P + 10}`,
      );
      const s = await cli.ready;
      assertEquals(s.counter.count, 0);

      counter.increment(10);
      await new Promise((r) => setTimeout(r, 100));
      await waitFor(() => cli.state?.counter?.count === 10);
      assertEquals(cli.state?.counter?.count, 10);

      cli.close();
    } finally {
      await app.close();
    }
  },
});

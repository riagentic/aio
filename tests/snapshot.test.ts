import { assertEquals, assertThrows } from "@std/assert";
import { createDispatch } from "../src/state/dispatch.ts";
import { createServer } from "../src/server/server.ts";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const noop = { debug: () => {}, warn: () => {}, error: () => {} };

// ── Unit: snapshot / loadSnapshot on app-like object ─────────────────

Deno.test("snapshot: returns JSON string of current state", () => {
  const state = { count: 5, name: "test" };
  const json = JSON.stringify(state);
  assertEquals(json, '{"count":5,"name":"test"}');
  assertEquals(JSON.parse(json), state);
});

Deno.test("loadSnapshot: replaces state and triggers broadcast", () => {
  type S = { count: number; label: string };
  type A = { type: string };
  let state: S = { count: 0, label: "init" };
  let broadcasts = 0;

  const dispatch = createDispatch<S, A, never>({
    reduce: (s, a) => {
      if (a.type === "INC") {
        return { state: { ...s, count: s.count + 1 }, effects: [] };
      }
      return { state: s, effects: [] };
    },
    execute: () => {},
    getState: () => state,
    setState: (s) => {
      state = s;
    },
    onDone: () => {
      broadcasts++;
    },
    log: noop,
    debug: false,
  });

  dispatch({ type: "INC" });
  assertEquals(state.count, 1);
  const snap = JSON.stringify(state);

  dispatch({ type: "INC" });
  dispatch({ type: "INC" });
  assertEquals(state.count, 3);

  // Restore snapshot
  state = JSON.parse(snap);
  assertEquals(state.count, 1);
  assertEquals(state.label, "init");

  // Can keep dispatching after restore
  dispatch({ type: "INC" });
  assertEquals(state.count, 2);

  dispatch.close();
});

Deno.test("loadSnapshot: invalid JSON throws", () => {
  assertThrows(() => JSON.parse("not json{{{"), SyntaxError);
});

// ── Integration: HTTP endpoints ─────────────────────────────────────

const PORT = freePort();

async function waitFor(fn: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > ms) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

Deno.test("snapshot HTTP: GET /__aio/snapshot returns state JSON", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );

  const state = { count: 42, items: ["a", "b"] };

  const server = createServer({
    port: PORT,
    title: "SnapshotTest",
    getUIState: () => state,
    dispatch: () => {},
    getSnapshot: () => JSON.stringify(state),
    loadSnapshot: () => {},
    baseDir: dir,
    debug: () => {},
    // Dev, because the snapshot route is dev-only since the state-leak fix
    // (it serves the RAW, unfiltered state tree). `prod: true` here was
    // scaffolding for the static server, never an assertion about which mode
    // the route belongs in — see tests/prod-leaks-no-state.test.ts.
    prod: false,
    distDir: join(dir, "dist"),
  });

  await new Promise((r) => setTimeout(r, 50));

  try {
    const resp = await fetch(`http://127.0.0.1:${PORT}/__aio/snapshot`);
    assertEquals(resp.status, 200);
    assertEquals(resp.headers.get("content-type"), "application/json");
    assertEquals(
      resp.headers.get("content-disposition"),
      'attachment; filename="snapshot.json"',
    );
    const body = await resp.json();
    assertEquals(body, state);
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("snapshot HTTP: POST /__aio/snapshot loads state", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );

  let loaded = "";

  const server = createServer({
    port: PORT,
    title: "SnapshotTest",
    getUIState: () => ({}),
    dispatch: () => {},
    getSnapshot: () => "{}",
    loadSnapshot: (json) => {
      loaded = json;
    },
    baseDir: dir,
    debug: () => {},
    // Dev, because the snapshot route is dev-only since the state-leak fix
    // (it serves the RAW, unfiltered state tree). `prod: true` here was
    // scaffolding for the static server, never an assertion about which mode
    // the route belongs in — see tests/prod-leaks-no-state.test.ts.
    prod: false,
    distDir: join(dir, "dist"),
  });

  await new Promise((r) => setTimeout(r, 50));

  try {
    // `{ cellName: {…} }` — a cell's state is always an object, and both
    // snapshot doors now refuse anything else (see snapshotShapeError).
    const snapshot = JSON.stringify({ counter: { count: 99, restored: true } });
    const resp = await fetch(`http://127.0.0.1:${PORT}/__aio/snapshot`, {
      method: "POST",
      body: snapshot,
      headers: { "Content-Type": "application/json", "X-AIO": "1" },
    });
    assertEquals(resp.status, 200);
    await resp.body?.cancel();
    assertEquals(loaded, snapshot);
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("snapshot HTTP: POST /__aio/snapshot rejects invalid JSON", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );

  const server = createServer({
    port: PORT,
    title: "SnapshotTest",
    getUIState: () => ({}),
    dispatch: () => {},
    getSnapshot: () => "{}",
    loadSnapshot: () => {},
    baseDir: dir,
    debug: () => {},
    // Dev, because the snapshot route is dev-only since the state-leak fix
    // (it serves the RAW, unfiltered state tree). `prod: true` here was
    // scaffolding for the static server, never an assertion about which mode
    // the route belongs in — see tests/prod-leaks-no-state.test.ts.
    prod: false,
    distDir: join(dir, "dist"),
  });

  await new Promise((r) => setTimeout(r, 50));

  try {
    const resp = await fetch(`http://127.0.0.1:${PORT}/__aio/snapshot`, {
      method: "POST",
      body: "not json{{{",
      headers: { "X-AIO": "1" },
    });
    assertEquals(resp.status, 400);
    const text = await resp.text();
    assertEquals(text, "Invalid JSON");
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("snapshot HTTP: clients receive broadcast after POST", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );

  let state: Record<string, unknown> = { counter: { count: 0, pad: "" } };
  let broadcast: (() => void) | null = null;

  const server = createServer({
    port: PORT,
    title: "SnapshotBroadcast",
    getUIState: () => state,
    dispatch: () => {},
    getSnapshot: () => JSON.stringify(state),
    loadSnapshot: (json) => {
      state = JSON.parse(json);
      broadcast?.();
    },
    baseDir: dir,
    debug: () => {},
    // Dev, because the snapshot route is dev-only since the state-leak fix
    // (it serves the RAW, unfiltered state tree). `prod: true` here was
    // scaffolding for the static server, never an assertion about which mode
    // the route belongs in — see tests/prod-leaks-no-state.test.ts.
    prod: false,
    distDir: join(dir, "dist"),
  });
  broadcast = server.broadcast;

  await new Promise((r) => setTimeout(r, 50));

  try {
    // Connect WS client
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const msgs: string[] = [];
    ws.addEventListener("message", (e) => {
      const d = e.data as string;
      if (d.includes('"t":"state"') || d.includes('"t":"patches"')) {
        msgs.push(d);
      }
    });
    await new Promise<void>((r) => {
      ws.onopen = () => r();
    });
    await waitFor(() => msgs.length >= 1); // initial state

    // POST snapshot → client should receive broadcast
    const resp = await fetch(`http://127.0.0.1:${PORT}/__aio/snapshot`, {
      method: "POST",
      body: JSON.stringify({ counter: { count: 77, pad: "restored" } }),
      headers: { "X-AIO": "1" },
    });
    assertEquals(resp.status, 200);
    await resp.body?.cancel();

    await waitFor(() => msgs.length >= 2);
    const update = JSON.parse(msgs[msgs.length - 1]!);
    // Could be a full "state" frame or a "patches" delta
    const count = update.t === "patches"
      ? (update.d as { path: unknown[]; value: unknown }[])
        .find((op) => op.path[1] === "count")?.value
      : update.d.counter.count;
    assertEquals(count, 77);

    ws.close();
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

// ── the gate itself, end to end ──────────────────────────────────────────────

const PROD_PORT = freePort();

Deno.test("snapshot HTTP: a PROD server does not serve the route at all", async () => {
  // 🔓 The regression this exists for. `getSnapshot` returns the RAW state
  // tree — no `ui`/`visible` filter, no `forUser` pass — and the route used to
  // be mounted in every mode, so every field an app excluded from its client
  // projection was served in prod, unauthenticated. In a packaged Electron app
  // that includes the page itself, because the `aio://` handler proxies
  // unknown paths to the app socket.
  //
  // Verified this way because the mount is the thing that was wrong: the
  // handler cannot tell you which modes it is reachable in.
  const dir = await tempDir("aio-prod-snapshot-");
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );
  const secret = { encSecKey: "v3:MUST-NOT-LEAK" };
  const server = createServer({
    port: PROD_PORT,
    title: "ProdSnapshotTest",
    getUIState: () => secret,
    dispatch: () => {},
    getSnapshot: () => JSON.stringify(secret),
    loadSnapshot: () => {
      throw new Error("a prod server must never load a snapshot over HTTP");
    },
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
  });
  await new Promise((r) => setTimeout(r, 50));
  try {
    const get = await fetch(`http://127.0.0.1:${PROD_PORT}/__aio/snapshot`);
    const body = await get.text();
    assertEquals(get.status, 404);
    assertEquals(
      body.includes("MUST-NOT-LEAK"),
      false,
      "a 404 body must not carry the state it refused to serve",
    );
    // The WRITE half matters as much: `?force=1` replaces whole state, and
    // for a wallet that is an address substitution needing no passphrase.
    const post = await fetch(
      `http://127.0.0.1:${PROD_PORT}/__aio/snapshot?force=1`,
      {
        method: "POST",
        body: '{"x":{"y":1}}',
        headers: { "Content-Type": "application/json", "x-aio": "1" },
      },
    );
    // Consumed, not just status-checked: an unread body is a leaked stream,
    // and the sanitizer fails the test for it.
    await post.text();
    assertEquals(post.status, 404);
    // That this is a gate on STATE and not a blanket shutdown of /__aio/* is
    // asserted where it belongs — against the route table, in
    // tests/prod-leaks-no-state.test.ts. Re-checking it here would need this
    // fixture to wire every diagnostics dep just to prove a negative it does
    // not own.
  } finally {
    await server.shutdown();
    await dropTempDir(dir);
  }
});

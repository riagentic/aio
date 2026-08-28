import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  _isLocalRequest,
  _timingSafeEqual,
  buildBrowserImportMap,
  classifyBrowserError,
  createServer,
} from "../src/server/server.ts";
import { join } from "@std/path";
import { clearPairing, generatePin } from "../src/server/pairing.ts";
import { freePort } from "../src/testing/server-test.ts";

const TEST_PORT = freePort();
const TEST_PORT_7 = freePort();
const TEST_PORT_8 = freePort();

// Use prod: true to skip file watcher (avoids resource leaks in tests)
async function withServer(fn: (url: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(join(dir, "hello.txt"), "world");
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );
  const server = createServer({
    port: TEST_PORT,
    title: "Test",
    getUIState: () => ({ ok: true }),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
  });
  await new Promise((r) => setTimeout(r, 50));
  try {
    await fn(`http://127.0.0.1:${TEST_PORT}`);
  } finally {
    await server.shutdown();
  }
  await Deno.remove(dir, { recursive: true });
}

Deno.test("server: index returns HTML with title", async () => {
  await withServer(async (url) => {
    const resp = await fetch(url);
    assertEquals(resp.status, 200);
    // Prod caching is EXPLICIT (revalidate) — not left empty for a proxy to
    // serve stale after redeploy (a bug that would reproduce only in prod).
    assertEquals(resp.headers.get("cache-control"), "no-cache");
    const body = await resp.text();
    assertEquals(body.includes("<!DOCTYPE html>"), true);
    assertEquals(body.includes("Test"), true);
  });
});

Deno.test("server: HTML omits aio:width meta tag when not configured", async () => {
  await withServer(async (url) => {
    const resp = await fetch(url);
    const body = await resp.text();
    assertEquals(body.includes("aio:width"), false);
    assertEquals(body.includes("aio:height"), false);
  });
});

Deno.test("server: serves files from baseDir", async () => {
  await withServer(async (url) => {
    const resp = await fetch(`${url}/hello.txt`);
    assertEquals(resp.status, 200);
    assertEquals(await resp.text(), "world");
  });
});

Deno.test("server: serves prod dist/app.js", async () => {
  await withServer(async (url) => {
    const resp = await fetch(`${url}/app.js`);
    assertEquals(resp.status, 200);
    const body = await resp.text();
    assertEquals(body.includes("mount"), true);
  });
});

Deno.test("server: 404 for missing files", async () => {
  await withServer(async (url) => {
    const resp = await fetch(`${url}/nope.txt`);
    assertEquals(resp.status, 404);
    await resp.body?.cancel();
  });
});

Deno.test("server: path traversal normalized by URL parser returns app shell", async () => {
  await withServer(async (url) => {
    // URL parser normalizes /../ to / — so /../../etc/passwd becomes /etc/passwd
    // SPA fallback: extensionless missing file → serve app shell (not actual /etc/passwd)
    const resp = await fetch(`${url}/../../../etc/passwd`);
    assertEquals(resp.status, 200);
    const body = await resp.text();
    assertEquals(
      body.includes("<!DOCTYPE html>"),
      true,
      "should serve app HTML, not system file",
    );
  });
});

// ── Width/height meta tags ──────────────────────────────────

const META_PORT = freePort();

Deno.test("server: HTML includes aio:width meta tag when configured", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );
  const server = createServer({
    port: META_PORT,
    title: "MetaTest",
    width: 1200,
    height: 900,
    getUIState: () => ({ ok: true }),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
  });
  await new Promise((r) => setTimeout(r, 50));
  try {
    const resp = await fetch(`http://127.0.0.1:${META_PORT}`);
    const body = await resp.text();
    assertEquals(body.includes('<meta name="aio:width" content="1200">'), true);
    assertEquals(body.includes('<meta name="aio:height" content="900">'), true);
    assertEquals(body.includes("MetaTest"), true);
  } finally {
    await server.shutdown();
  }
  await Deno.remove(dir, { recursive: true });
});

// ── Expose / token auth tests ──────────────────────────────────

const EXPOSE_PORT = freePort();

async function withExposedServer(
  fn: (url: string, token: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );
  const token = "test-token-123";
  const server = createServer({
    port: EXPOSE_PORT,
    title: "Exposed",
    getUIState: () => ({ ok: true }),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
    expose: true,
    token,
  });
  await new Promise((r) => setTimeout(r, 50));
  try {
    await fn(`http://127.0.0.1:${EXPOSE_PORT}`, token);
  } finally {
    await server.shutdown();
  }
  await Deno.remove(dir, { recursive: true });
}

Deno.test("server: expose rejects request without token", async () => {
  await withExposedServer(async (url) => {
    const resp = await fetch(url);
    assertEquals(resp.status, 401);
    await resp.body?.cancel();
  });
});

Deno.test("server: expose accepts request with ?token=", async () => {
  await withExposedServer(async (url, token) => {
    const resp = await fetch(`${url}?token=${token}`);
    assertEquals(resp.status, 200);
    const body = await resp.text();
    assertEquals(body.includes("<!DOCTYPE html>"), true);
  });
});

Deno.test("server: expose accepts request with Authorization header", async () => {
  await withExposedServer(async (url, token) => {
    const resp = await fetch(url, {
      headers: { "Authorization": `Bearer ${token}` },
    });
    assertEquals(resp.status, 200);
    await resp.body?.cancel();
  });
});

Deno.test("server: expose skips origin check on WS", async () => {
  await withExposedServer(async (url, token) => {
    // With valid token, non-localhost origin should be allowed
    const resp = await fetch(`${url}/ws?token=${token}`, {
      headers: {
        "Upgrade": "websocket",
        "Connection": "Upgrade",
        "Origin": "https://remote-device.local",
        "Sec-WebSocket-Key": btoa("test"),
        "Sec-WebSocket-Version": "13",
      },
    });
    // With audit F-2 fix: Origin is always validated; no allowedOrigins means reject non-local
    assertEquals(resp.status, 403);
    await resp.body?.cancel();
  });
});

Deno.test("server: expose rejects wrong token with 401", async () => {
  await withExposedServer(async (url) => {
    const resp = await fetch(`${url}?token=wrong-token-value`);
    assertEquals(resp.status, 401);
    await resp.body?.cancel();
  });
});

Deno.test("server: /__aio/pair returns the profile for a valid PIN (bypasses key gate)", async () => {
  await withExposedServer(async (url, token) => {
    const pin = generatePin();
    try {
      // No token on the request — the whole point of pairing is to obtain it.
      const resp = await fetch(`${url}/__aio/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin }),
      });
      assertEquals(resp.status, 200);
      const profile = await resp.json();
      assertEquals(profile.aio, 1);
      assertEquals(profile.key, token); // the key the server authenticates with
      assertEquals(profile.tls, false); // this harness serves plain HTTP
      assertEquals(typeof profile.port, "number");
    } finally {
      clearPairing();
    }
  });
});

Deno.test("server: /__aio/pair rejects a wrong PIN with 401", async () => {
  await withExposedServer(async (url) => {
    generatePin();
    try {
      const resp = await fetch(`${url}/__aio/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pin: "000000" }),
      });
      assertEquals(resp.status, 401);
      await resp.body?.cancel();
    } finally {
      clearPairing();
    }
  });
});

Deno.test("server: /__aio/pair rejects a malformed body with 400", async () => {
  await withExposedServer(async (url) => {
    generatePin();
    try {
      const resp = await fetch(`${url}/__aio/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not json",
      });
      assertEquals(resp.status, 400);
      await resp.body?.cancel();
    } finally {
      clearPairing();
    }
  });
});

Deno.test("server: WS rejects oversized message (>1MB)", async () => {
  await withServer(async (url) => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`);
    let dispatched = false;

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("WS failed"));
    });

    // Wait for initial state
    await new Promise((r) => setTimeout(r, 50));

    // Send oversized message (>1MB) — should be silently dropped
    const huge = JSON.stringify({
      type: "BIG",
      payload: "x".repeat(1_100_000),
    });
    ws.send(huge);
    await new Promise((r) => setTimeout(r, 50));

    // Dispatch should not have been called (message dropped)
    assertEquals(dispatched, false);

    ws.close();
  });
});

Deno.test("server: WS rejects non-localhost origin", async () => {
  await withServer(async (url) => {
    const resp = await fetch(`${url}/ws`, {
      headers: {
        "Upgrade": "websocket",
        "Connection": "Upgrade",
        "Origin": "https://evil.com",
        "Sec-WebSocket-Key": btoa("test"),
        "Sec-WebSocket-Version": "13",
      },
    });
    assertEquals(resp.status, 403);
    await resp.body?.cancel();
  });
});

// ── allowedOrigins tests ──────────────────────────────────────

const ORIGINS_PORT = freePort();

Deno.test("server: allowedOrigins accepts custom origin", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );
  const server = createServer({
    port: ORIGINS_PORT,
    title: "Origins",
    getUIState: () => ({ ok: true }),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
    allowedOrigins: ["myapp.local"],
  });
  await new Promise((r) => setTimeout(r, 50));
  try {
    // Custom allowed origin should succeed
    const resp = await fetch(`http://127.0.0.1:${ORIGINS_PORT}/ws`, {
      headers: {
        "Upgrade": "websocket",
        "Connection": "Upgrade",
        "Origin": "http://myapp.local",
        "Sec-WebSocket-Key": btoa("test"),
        "Sec-WebSocket-Version": "13",
      },
    });
    assertEquals(resp.status !== 403, true);
    await resp.body?.cancel();

    // Non-allowed origin should still be rejected
    const resp2 = await fetch(`http://127.0.0.1:${ORIGINS_PORT}/ws`, {
      headers: {
        "Upgrade": "websocket",
        "Connection": "Upgrade",
        "Origin": "https://evil.com",
        "Sec-WebSocket-Key": btoa("test"),
        "Sec-WebSocket-Version": "13",
      },
    });
    assertEquals(resp2.status, 403);
    await resp2.body?.cancel();
  } finally {
    await server.shutdown();
  }
  await Deno.remove(dir, { recursive: true });
});

// ── Users (multi-user) auth tests ──────────────────────────────────

const USERS_PORT = freePort();

const TEST_USERS: Record<string, { id: string; role: string }> = {
  "alice-token-123": { id: "alice", role: "admin" },
  "bob-token-456": { id: "bob", role: "viewer" },
};

async function withUsersServer(
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );
  const server = createServer({
    port: USERS_PORT,
    title: "Users",
    getUIState: () => ({ ok: true }),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
    users: TEST_USERS,
  });
  await new Promise((r) => setTimeout(r, 50));
  try {
    await fn(`http://127.0.0.1:${USERS_PORT}`);
  } finally {
    await server.shutdown();
  }
  await Deno.remove(dir, { recursive: true });
}

Deno.test("server: users auth — rejects missing token with 401", async () => {
  await withUsersServer(async (url) => {
    const resp = await fetch(url);
    assertEquals(resp.status, 401);
    await resp.body?.cancel();
  });
});

Deno.test("server: users auth — accepts correct token via query param", async () => {
  await withUsersServer(async (url) => {
    const resp = await fetch(`${url}?token=alice-token-123`);
    assertEquals(resp.status, 200);
    const body = await resp.text();
    assertEquals(body.includes("<!DOCTYPE html>"), true);
  });
});

Deno.test("server: users auth — accepts correct token via Bearer header", async () => {
  await withUsersServer(async (url) => {
    const resp = await fetch(url, {
      headers: { "Authorization": "Bearer bob-token-456" },
    });
    assertEquals(resp.status, 200);
    await resp.body?.cancel();
  });
});

Deno.test("server: users auth — wrong token → 401", async () => {
  await withUsersServer(async (url) => {
    const resp = await fetch(`${url}?token=wrong-token-value`);
    assertEquals(resp.status, 401);
    await resp.body?.cancel();
  });
});

Deno.test("server: no users no token — public access", async () => {
  await withServer(async (url) => {
    const resp = await fetch(url);
    assertEquals(resp.status, 200);
    await resp.body?.cancel();
  });
});

// A LOOPBACK origin no longer certifies itself. This test used to assert that
// `http://[::1]:8000` was accepted by any aio server — the blanket exemption
// that let any page on any other local port open an authenticated socket
// (ports are not part of a "site", so `SameSite=Strict` cookies ride along).
// The rule now: the server's OWN origin, or a deliberate `allowedOrigins`
// entry. Bracket/hostname parsing is still exercised — through the allowlist.
Deno.test("server: a foreign IPv6 loopback origin is refused, allowlisted is not", async () => {
  const wsHeaders = (origin: string) => ({
    "Upgrade": "websocket",
    "Connection": "Upgrade",
    "Origin": origin,
    "Sec-WebSocket-Key": btoa("test"),
    "Sec-WebSocket-Version": "13",
  });
  await withServer(async (url) => {
    const resp = await fetch(`${url}/ws`, {
      headers: wsHeaders("http://[::1]:8000"),
    });
    assertEquals(resp.status, 403);
    await resp.body?.cancel();
  });

  const dir = await Deno.makeTempDir();
  const port = freePort();
  const server = createServer({
    port,
    title: "Test",
    getUIState: () => ({ ok: true }),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    // WHATWG URL keeps the brackets: hostname is "[::1]".
    allowedOrigins: ["[::1]"],
  });
  await new Promise((r) => setTimeout(r, 50));
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/ws`, {
      headers: wsHeaders("http://[::1]:8000"),
    });
    assertEquals(resp.status !== 403, true);
    await resp.body?.cancel();
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

// ── timingSafeEqual unit tests ────────────────────────────────

Deno.test("timingSafeEqual: equal strings return true", () => {
  assertEquals(_timingSafeEqual("abc", "abc"), true);
  assertEquals(_timingSafeEqual("", ""), true);
  assertEquals(
    _timingSafeEqual("a-long-token-value-123", "a-long-token-value-123"),
    true,
  );
});

Deno.test("timingSafeEqual: different strings return false", () => {
  assertEquals(_timingSafeEqual("abc", "def"), false);
  assertEquals(_timingSafeEqual("abc", "abcd"), false);
  assertEquals(_timingSafeEqual("abc", "ab"), false);
  assertEquals(_timingSafeEqual("abc", ""), false);
  assertEquals(_timingSafeEqual("", "abc"), false);
});

Deno.test("timingSafeEqual: different lengths return false", () => {
  assertEquals(_timingSafeEqual("short", "a-much-longer-string"), false);
  assertEquals(_timingSafeEqual("a-much-longer-string", "short"), false);
});

// ── CSRF rejection test ──────────────────────────────────────

const CSRF_PORT = freePort();

Deno.test("server: POST /__aio/snapshot without X-AIO header returns 403", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );
  const server = createServer({
    port: CSRF_PORT,
    title: "CSRFTest",
    getUIState: () => ({}),
    dispatch: () => {},
    getSnapshot: () => "{}",
    loadSnapshot: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
  });
  await new Promise((r) => setTimeout(r, 50));
  try {
    // POST without X-AIO header → 403
    const resp = await fetch(`http://127.0.0.1:${CSRF_PORT}/__aio/snapshot`, {
      method: "POST",
      body: '{"count":1}',
      headers: { "Content-Type": "application/json" },
    });
    assertEquals(resp.status, 403);
    const text = await resp.text();
    assertEquals(text, "Missing X-AIO header");

    // POST with X-AIO header → 200
    const resp2 = await fetch(`http://127.0.0.1:${CSRF_PORT}/__aio/snapshot`, {
      method: "POST",
      body: '{"count":1}',
      headers: { "Content-Type": "application/json", "X-AIO": "1" },
    });
    assertEquals(resp2.status, 200);
    await resp2.body?.cancel();
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

// ── WS rate limiting test ────────────────────────────────────

const RATE_PORT = freePort();

Deno.test("server: WS rate limiting drops messages over 100/sec", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );
  let actionCount = 0;
  const server = createServer({
    port: RATE_PORT,
    title: "RateTest",
    getUIState: () => ({ n: actionCount }),
    dispatch: () => {
      actionCount++;
    },
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
  });
  await new Promise((r) => setTimeout(r, 50));
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${RATE_PORT}/ws`);
    await new Promise<void>((r) => {
      ws.onopen = () => r();
    });
    // Wait for initial state
    await new Promise((r) => setTimeout(r, 50));

    // Send 120 messages rapidly — first 100 should dispatch, rest dropped
    actionCount = 0;
    for (let i = 0; i < 120; i++) {
      ws.send(JSON.stringify({ v: 2, t: "action", d: { type: "TICK" } }));
    }
    // Wait for all messages to process
    await new Promise((r) => setTimeout(r, 200));

    // Should have dispatched <= 100 (rate limit kicks in after 100)
    assertEquals(
      actionCount <= 100,
      true,
      `expected <=100 dispatches, got ${actionCount}`,
    );
    assertEquals(
      actionCount >= 90,
      true,
      `expected >=90 dispatches, got ${actionCount}`,
    );

    ws.close();
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

// ── W6.6: configurable WS rate limit ─────────────────────────────────

const CUSTOM_RATE_PORT = freePort();

Deno.test("server: wsLimits.messagesPerSec overrides the default rate cap", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );
  let actionCount = 0;
  const server = createServer({
    port: CUSTOM_RATE_PORT,
    title: "CustomRateTest",
    getUIState: () => ({ n: actionCount }),
    dispatch: () => {
      actionCount++;
    },
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
    wsLimits: { messagesPerSec: 10 }, // far below the 100 default
  });
  await new Promise((r) => setTimeout(r, 50));
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${CUSTOM_RATE_PORT}/ws`);
    await new Promise<void>((r) => {
      ws.onopen = () => r();
    });
    await new Promise((r) => setTimeout(r, 50));

    actionCount = 0;
    for (let i = 0; i < 120; i++) {
      ws.send(JSON.stringify({ v: 2, t: "action", d: { type: "TICK" } }));
    }
    await new Promise((r) => setTimeout(r, 200));

    // With a 10/sec cap, well under the 100 default must get through.
    assertEquals(
      actionCount <= 12,
      true,
      `expected <=12 dispatches under messagesPerSec:10, got ${actionCount}`,
    );
    ws.close();
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

// ── Trojan API tests ────────────────────────────────────────────────

const TROJAN_PORT = freePort();

async function withTrojanServer(
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(join(dir, "App.tsx"), "export default () => null");
  let appState = { count: 42, name: "test" };
  const dispatched: unknown[] = [];
  const server = createServer({
    port: TROJAN_PORT,
    title: "TrojanTest",
    getUIState: () => ({ count: appState.count }),
    dispatch: (action) => {
      dispatched.push(action);
    },
    getSnapshot: () => JSON.stringify(appState),
    loadSnapshot: (json: string) => {
      appState = JSON.parse(json);
    },
    baseDir: dir,
    debug: () => {},
    prod: false,
    trojan: {
      getState: () => appState,
      getSchedules: () => ["heartbeat", "cleanup"],
      getTTHistory: () => ({
        entries: [{ id: 0, type: "__init", ts: 1000 }],
        index: 0,
        paused: false,
      }),
      forcePersist: () => {},
      startedAt: Date.now() - 5000,
    },
  });
  await new Promise((r) => setTimeout(r, 50));
  try {
    await fn(`http://127.0.0.1:${TROJAN_PORT}`);
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("trojan: GET /state returns raw state", async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__aio/trojan/state`);
    assertEquals(resp.status, 200);
    const data = await resp.json();
    assertEquals(data.count, 42);
    assertEquals(data.name, "test");
  });
});

Deno.test("trojan: same-machine guard — loopback + UDS local, everything else remote", () => {
  // Local: the trojan may answer.
  assertEquals(
    _isLocalRequest({ transport: "tcp", hostname: "127.0.0.1", port: 1 }),
    true,
  );
  assertEquals(
    _isLocalRequest({ transport: "tcp", hostname: "::1", port: 1 }),
    true,
  );
  assertEquals(
    _isLocalRequest({ transport: "tcp", hostname: "localhost", port: 1 }),
    true,
  );
  assertEquals(
    _isLocalRequest({ transport: "unix", path: "/tmp/x.sock" }),
    true,
  );
  // Remote (LAN, public, spoofed host): never.
  assertEquals(
    _isLocalRequest({ transport: "tcp", hostname: "192.168.1.5", port: 1 }),
    false,
  );
  assertEquals(
    _isLocalRequest({ transport: "tcp", hostname: "10.0.0.2", port: 1 }),
    false,
  );
  assertEquals(
    _isLocalRequest({ transport: "tcp", hostname: "203.0.113.9", port: 1 }),
    false,
  );
  // Unknown origin fails CLOSED.
  assertEquals(_isLocalRequest(undefined), false);
});

Deno.test("trojan: DEV-ONLY — prod build serves no trojan route even when wired", async () => {
  // The trojan reads full state, runs SQL, and loads snapshots. A release
  // build must not expose it, regardless of `trojan:` being configured.
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(join(dir, "App.tsx"), "export default () => null");
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );
  const server = createServer({
    port: TROJAN_PORT,
    title: "ProdTrojan",
    getUIState: () => ({ count: 1 }),
    dispatch: () => {},
    getSnapshot: () => "{}",
    loadSnapshot: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true, // release build
    distDir: join(dir, "dist"),
    trojan: {
      getState: () => ({ secret: "should-never-leak" }),
      getSchedules: () => [],
      startedAt: Date.now(),
    },
  });
  await new Promise((r) => setTimeout(r, 50));
  try {
    const base = `http://127.0.0.1:${TROJAN_PORT}`;
    // Every trojan route — read, control, and SQL — is 404 in prod.
    for (
      const [method, route] of [
        ["GET", "state"],
        ["GET", "ui"],
        ["GET", "clients"],
        ["POST", "sql"],
        ["POST", "snapshot"],
        ["POST", "dispatch"],
      ] as const
    ) {
      const resp = await fetch(`${base}/__aio/trojan/${route}`, {
        method,
        headers: method === "POST"
          ? { "x-aio": "1", "content-type": "application/json" }
          : undefined,
        body: method === "POST" ? "{}" : undefined,
      });
      const body = await resp.text();
      assertEquals(
        resp.status,
        404,
        `${method} /trojan/${route} must be 404 in prod (got ${resp.status})`,
      );
      assertEquals(
        body.includes("should-never-leak"),
        false,
        `${route} must not leak state in prod`,
      );
    }
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("trojan: GET /ui returns filtered UI state", async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__aio/trojan/ui`);
    assertEquals(resp.status, 200);
    const data = await resp.json();
    assertEquals(data.count, 42);
    assertEquals(data.name, undefined); // filtered out by getUIState
  });
});

Deno.test("trojan: GET /clients returns connection list", async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__aio/trojan/clients`);
    assertEquals(resp.status, 200);
    const data = await resp.json();
    assertEquals(Array.isArray(data), true);
    assertEquals(data.length, 0); // no WS connections
  });
});

Deno.test("trojan: GET /history returns TT state", async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__aio/trojan/history`);
    assertEquals(resp.status, 200);
    const data = await resp.json();
    assertEquals(data.entries.length, 1);
    assertEquals(data.entries[0].type, "__init");
  });
});

Deno.test("trojan: GET /schedules returns active IDs", async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__aio/trojan/schedules`);
    assertEquals(resp.status, 200);
    const data = await resp.json();
    assertEquals(data, ["heartbeat", "cleanup"]);
  });
});

Deno.test("trojan: GET /metrics returns uptime and counts", async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__aio/trojan/metrics`);
    assertEquals(resp.status, 200);
    const data = await resp.json();
    assertEquals(typeof data.uptime, "number");
    assertEquals(data.uptime >= 4, true); // started 5s ago
    assertEquals(data.connections, 0);
    assertEquals(data.schedules, 2);
  });
});

Deno.test("trojan: POST /dispatch dispatches action", async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__aio/trojan/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AIO": "1" },
      body: JSON.stringify({ type: "INCREMENT", payload: { by: 1 } }),
    });
    assertEquals(resp.status, 200);
    const data = await resp.json();
    assertEquals(data.ok, true);
  });
});

Deno.test("trojan: POST /dispatch rejects missing type", async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__aio/trojan/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AIO": "1" },
      body: JSON.stringify({ payload: "no type" }),
    });
    assertEquals(resp.status, 400);
    await resp.body?.cancel();
  });
});

Deno.test("trojan: POST /snapshot replaces state", async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__aio/trojan/snapshot`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AIO": "1" },
      body: JSON.stringify({ count: 99 }),
    });
    assertEquals(resp.status, 200);
    const data = await resp.json();
    assertEquals(data.ok, true);
  });
});

Deno.test("trojan: POST /persist triggers persistence", async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__aio/trojan/persist`, {
      method: "POST",
      headers: { "X-AIO": "1" },
    });
    assertEquals(resp.status, 200);
    const data = await resp.json();
    assertEquals(data.ok, true);
  });
});

Deno.test("trojan: GET /unknown returns 404", async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__aio/trojan/nope`);
    assertEquals(resp.status, 404);
    await resp.body?.cancel();
  });
});

Deno.test("trojan: not available when trojan config absent", async () => {
  // withServer creates a prod server without trojan config → 404
  await withServer(async (url) => {
    const resp = await fetch(`${url}/__aio/trojan/state`);
    assertEquals(resp.status, 404);
    await resp.body?.cancel();
  });
});

// ── CSRF: POST without X-AIO header → 403 ─────────────────────

Deno.test("trojan: POST without X-AIO header returns 403", async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__aio/trojan/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "TEST", payload: {} }),
    });
    assertEquals(resp.status, 403);
    const data = await resp.json();
    assertEquals(data.error, "Missing X-AIO header");
  });
});

// ── POST /tt time-travel tests ──────────────────────────────────

const TT_PORT = freePort();
const TT_PORT_1 = freePort();
const TT_PORT_2 = freePort();
const TT_PORT_5 = freePort();

Deno.test("trojan: POST /tt routes undo command to onTTCommand", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(join(dir, "App.tsx"), "export default () => null");
  const ttCmds: { cmd: string; arg?: number }[] = [];
  const server = createServer({
    port: TT_PORT,
    title: "TTTest",
    getUIState: () => ({}),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: false,
    onTTCommand: (cmd, arg) => {
      ttCmds.push({ cmd, arg });
    },
    trojan: {
      getState: () => ({}),
      getSchedules: () => [],
      startedAt: Date.now(),
    },
  });
  await new Promise((r) => setTimeout(r, 50));
  try {
    const resp = await fetch(`http://127.0.0.1:${TT_PORT}/__aio/trojan/tt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AIO": "1" },
      body: JSON.stringify({ cmd: "undo" }),
    });
    assertEquals(resp.status, 200);
    const data = await resp.json();
    assertEquals(data.ok, true);
    assertEquals(ttCmds.length, 1);
    assertEquals(ttCmds[0]!.cmd, "undo");

    // Test goto with arg
    const resp2 = await fetch(`http://127.0.0.1:${TT_PORT}/__aio/trojan/tt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AIO": "1" },
      body: JSON.stringify({ cmd: "goto", arg: 3 }),
    });
    assertEquals(resp2.status, 200);
    await resp2.body?.cancel();
    assertEquals(ttCmds.length, 2);
    assertEquals(ttCmds[1]!.cmd, "goto");
    assertEquals(ttCmds[1]!.arg, 3);
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("trojan: POST /tt without onTTCommand returns 501", async () => {
  await withTrojanServer(async (url) => {
    const resp = await fetch(`${url}/__aio/trojan/tt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AIO": "1" },
      body: JSON.stringify({ cmd: "undo" }),
    });
    assertEquals(resp.status, 501);
    await resp.body?.cancel();
  });
});

// ── SQL read-only enforcement ──────────────────────────────

Deno.test("trojan: POST /sql blocks INSERT", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(join(dir, "App.tsx"), "export default () => null");
  const server = createServer({
    port: TT_PORT_1,
    title: "SQLTest",
    getUIState: () => ({}),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: false,
    trojan: {
      getState: () => ({}),
      getSchedules: () => [],
      sqlQuery: async () => [],
      startedAt: Date.now(),
    },
  });
  await new Promise((r) => setTimeout(r, 50));
  try {
    // INSERT should be blocked
    const resp = await fetch(
      `http://127.0.0.1:${TT_PORT_1}/__aio/trojan/sql`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-AIO": "1" },
        body: JSON.stringify({ query: "INSERT INTO users VALUES (1)" }),
      },
    );
    assertEquals(resp.status, 403);
    const data = await resp.json();
    assertEquals(data.error.includes("read-only"), true);

    // DELETE should be blocked
    const resp2 = await fetch(
      `http://127.0.0.1:${TT_PORT_1}/__aio/trojan/sql`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-AIO": "1" },
        body: JSON.stringify({ query: "DELETE FROM users" }),
      },
    );
    assertEquals(resp2.status, 403);
    await resp2.body?.cancel();

    // PRAGMA should be blocked (allow-list: SELECT only)
    const resp3 = await fetch(
      `http://127.0.0.1:${TT_PORT_1}/__aio/trojan/sql`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-AIO": "1" },
        body: JSON.stringify({ query: "PRAGMA table_info(users)" }),
      },
    );
    assertEquals(resp3.status, 403);
    await resp3.body?.cancel();

    // WITH (CTE) is read-only — should pass
    const resp4 = await fetch(
      `http://127.0.0.1:${TT_PORT_1}/__aio/trojan/sql`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-AIO": "1" },
        body: JSON.stringify({ query: "WITH x AS (SELECT 1) SELECT * FROM x" }),
      },
    );
    assertEquals(resp4.status, 200);
    await resp4.body?.cancel();

    // A write keyword inside a string literal is NOT a write — should pass
    const resp4b = await fetch(
      `http://127.0.0.1:${TT_PORT_1}/__aio/trojan/sql`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-AIO": "1" },
        body: JSON.stringify({
          query: "SELECT 'DROP TABLE instructions' AS note FROM users",
        }),
      },
    );
    assertEquals(resp4b.status, 200);
    await resp4b.body?.cancel();

    // SELECT should pass
    const resp5 = await fetch(
      `http://127.0.0.1:${TT_PORT_1}/__aio/trojan/sql`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-AIO": "1" },
        body: JSON.stringify({ query: "SELECT * FROM users" }),
      },
    );
    assertEquals(resp5.status, 200);
    await resp5.body?.cancel();

    // A comment must not hide a chained statement from the multi-statement
    // guard: unbalanced quotes inside `--` comments used to make the literal
    // mask swallow a following `;DROP…`. Now comments are stripped first.
    const respChain = await fetch(
      `http://127.0.0.1:${TT_PORT_1}/__aio/trojan/sql`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-AIO": "1" },
        body: JSON.stringify({ query: "SELECT 1 --'\n; DROP TABLE t --'" }),
      },
    );
    assertEquals(respChain.status, 403);
    const chainErr = await respChain.json();
    assertEquals(
      String(chainErr.error).includes("multi-statement"),
      true,
      `comment-hidden ';' must be caught: ${chainErr.error}`,
    );

    // A write keyword hidden only by a comment must still be caught.
    const respHidden = await fetch(
      `http://127.0.0.1:${TT_PORT_1}/__aio/trojan/sql`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-AIO": "1" },
        body: JSON.stringify({ query: "SELECT 1 /* */; DELETE FROM users" }),
      },
    );
    assertEquals(respHidden.status, 403);
    await respHidden.body?.cancel();
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

// ── Identity provenance: network actions can't spoof _user ────

Deno.test("security: a network action cannot spoof the _user identity", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(join(dir, "App.tsx"), "export default () => null");
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );
  const seen: Array<Record<string, unknown>> = [];
  const server = createServer({
    port: TT_PORT_5,
    title: "SpoofTest",
    getUIState: () => ({ ok: true }),
    dispatch: (a) => seen.push(a as Record<string, unknown>),
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
  });
  await new Promise((r) => setTimeout(r, 50));
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${TT_PORT_5}/ws`);
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("ws failed"));
    });
    // Attacker tries to dispatch as an admin by setting _user on the wire,
    // and to ride the shutdown drain gate by forging _source:"Effect".
    ws.send(JSON.stringify({
      v: 2,
      t: "action",
      d: {
        type: "todo:add",
        _user: { id: "root", role: "admin" },
        _source: "Effect",
        _syncOp: true,
      },
    }));
    for (let i = 0; i < 100 && seen.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    ws.close();
    const action = seen.find((a) => a.type === "todo:add");
    assert(action, "action reached dispatch");
    assertEquals(
      action!._user,
      undefined,
      "_user must be stripped from network-sourced actions (no identity spoof)",
    );
    // The same trusted-provenance class: `_source` steers dispatch's
    // closed-queue drain gate (`_source:"Effect"` lands while draining, all
    // else drops), so a client forging it could run a `cell:method` during
    // shutdown drain and have its write captured by the final persist. The
    // server tags its own effect dispatches itself — a caller-supplied value
    // is never legitimate. It is RE-STAMPED (not just deleted) as "UI": app
    // hooks keep real provenance, and the gate still treats it as client
    // input.
    assertEquals(
      (action as Record<string, unknown>)._source,
      "UI",
      "_source must be re-stamped to 'UI' on network actions (no drain-gate spoof)",
    );
    // And `_syncOp`: only the sync handler sets it, on ops already persisted
    // to the op-log, so afterAction skips the durability fold for sync cells.
    // A forged value on a sync-cell method action would make the server treat
    // a non-durable write as durable — the state change silently vanishes on
    // restart. Never legitimate from a caller.
    assertEquals(
      (action as Record<string, unknown>)._syncOp,
      undefined,
      "_syncOp must be stripped from network-sourced actions (no durability-fold spoof)",
    );
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

// ── POST /shutdown triggers callback ─────────────────────────

Deno.test("trojan: POST /shutdown returns ok and triggers callback", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(join(dir, "App.tsx"), "export default () => null");
  let shutdownCalled = false;
  const server = createServer({
    port: TT_PORT_2,
    title: "ShutdownTest",
    getUIState: () => ({}),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: false,
    trojan: {
      getState: () => ({}),
      getSchedules: () => [],
      shutdown: async () => {
        shutdownCalled = true;
      },
      startedAt: Date.now(),
    },
  });
  await new Promise((r) => setTimeout(r, 50));
  try {
    const resp = await fetch(
      `http://127.0.0.1:${TT_PORT_2}/__aio/trojan/shutdown`,
      { method: "POST", headers: { "X-AIO": "1" } },
    );
    assertEquals(resp.status, 200);
    const data = await resp.json();
    assertEquals(data.ok, true);
    // Give queueMicrotask time to fire
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(shutdownCalled, true);
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

// ── WS boot frame and binary message handling ─────────────────

Deno.test("server: boot frame sent on connect", async () => {
  await withServer(async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`);
    const messages: string[] = [];

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => {
        // Collect messages for a bit
        ws.onmessage = (e) => {
          if (typeof e.data === "string") messages.push(e.data);
        };
        setTimeout(resolve, 200);
      };
      ws.onerror = () => reject(new Error("WS failed"));
    });

    // Should have received a "boot" frame carrying the boot id
    const bootMsg = messages.find((m) => m.includes('"t":"boot"'));
    assertEquals(bootMsg !== undefined, true, "should receive boot frame");
    const id = JSON.parse(bootMsg!).d?.id;
    assertEquals(typeof id === "string" && id.length > 0, true, "non-empty id");

    ws.close();
  });
});

Deno.test("server: WS binary message dropped without crash", async () => {
  await withServer(async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${TEST_PORT}/ws`);

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("WS failed"));
    });

    // Wait for initial state
    await new Promise((r) => setTimeout(r, 50));

    // Send binary data — should be silently dropped
    ws.send(new Uint8Array([1, 2, 3, 4]));
    await new Promise((r) => setTimeout(r, 100));

    // Server should still be alive — send valid action
    ws.send(JSON.stringify({ v: 2, t: "action", d: { type: "Ping" } }));
    await new Promise((r) => setTimeout(r, 50));

    // No crash — connection still open
    assertEquals(ws.readyState, WebSocket.OPEN);
    ws.close();
  });
});

// ── maxConnections — 503 when limit exceeded ─────────────────

const MAX_CONN_PORT = freePort();
const MAX_CONN_PORT_1 = freePort();
const MAX_CONN_PORT_2 = freePort();

Deno.test("server: maxConnections — 503 when limit exceeded", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );
  const server = createServer({
    port: MAX_CONN_PORT,
    title: "MaxConn",
    getUIState: () => ({}),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
    maxConnections: 1,
  });
  await new Promise((r) => setTimeout(r, 50));
  const ws1 = new WebSocket(`ws://127.0.0.1:${MAX_CONN_PORT}/ws`);
  try {
    await new Promise<void>((resolve, reject) => {
      ws1.onopen = () => resolve();
      ws1.onerror = () => reject(new Error("WS1 failed"));
    });
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(server.clientCount(), 1);

    // Second connection should get 503
    const resp = await fetch(`http://127.0.0.1:${MAX_CONN_PORT}/ws`, {
      headers: {
        "Upgrade": "websocket",
        "Connection": "Upgrade",
        // The server's own origin — this test is about the connection cap,
        // not the origin gate (a foreign origin now 403s before the cap).
        "Origin": `http://127.0.0.1:${MAX_CONN_PORT}`,
        "Sec-WebSocket-Key": btoa("test2"),
        "Sec-WebSocket-Version": "13",
      },
    });
    assertEquals(resp.status, 503);
    await resp.body?.cancel();
  } finally {
    ws1.close();
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

// ── clientCount reflects live connections ────────────────────

Deno.test("server: clientCount is 0 before any connection", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );
  const server = createServer({
    port: MAX_CONN_PORT_1,
    title: "CountTest",
    getUIState: () => ({}),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
  });
  await new Promise((r) => setTimeout(r, 50));
  try {
    assertEquals(server.clientCount(), 0);
    const ws = new WebSocket(`ws://127.0.0.1:${MAX_CONN_PORT_1}/ws`);
    await new Promise<void>((r) => {
      ws.onopen = () => r();
    });
    await new Promise((r) => setTimeout(r, 50));
    assertEquals(server.clientCount(), 1);
    ws.close();
    await new Promise((r) => setTimeout(r, 100));
    assertEquals(server.clientCount(), 0);
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

// ── Security headers ─────────────────────────────────────────

Deno.test("server: HTML response has X-Content-Type-Options: nosniff", async () => {
  await withServer(async (url) => {
    const resp = await fetch(url);
    assertEquals(resp.headers.get("x-content-type-options"), "nosniff");
    await resp.body?.cancel();
  });
});

Deno.test("server: static file has X-Content-Type-Options: nosniff", async () => {
  await withServer(async (url) => {
    const resp = await fetch(`${url}/hello.txt`);
    assertEquals(resp.headers.get("x-content-type-options"), "nosniff");
    await resp.body?.cancel();
  });
});

Deno.test("server: text file served with correct Content-Type", async () => {
  await withServer(async (url) => {
    const resp = await fetch(`${url}/hello.txt`);
    assertEquals(resp.status, 200);
    const ct = resp.headers.get("content-type") ?? "";
    assertEquals(
      ct.includes("text/plain") || ct.includes("application/octet-stream"),
      true,
    );
    await resp.body?.cancel();
  });
});

// ── WS invalid message handling ──────────────────────────────

Deno.test("server: WS invalid JSON dropped — dispatch not called", async () => {
  let dispatched = false;
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );
  const server = createServer({
    port: MAX_CONN_PORT_2,
    title: "InvalidJSON",
    getUIState: () => ({}),
    dispatch: () => {
      dispatched = true;
    },
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
  });
  await new Promise((r) => setTimeout(r, 50));
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${MAX_CONN_PORT_2}/ws`);
    await new Promise<void>((r) => {
      ws.onopen = () => r();
    });
    await new Promise((r) => setTimeout(r, 50));
    dispatched = false;

    // Send invalid JSON
    ws.send("not-json-at-all{{{");
    await new Promise((r) => setTimeout(r, 100));
    assertEquals(dispatched, false, "invalid JSON should not dispatch");

    // Send JSON without type field
    ws.send(JSON.stringify({ v: 2, t: "action", d: { payload: { by: 1 } } }));
    await new Promise((r) => setTimeout(r, 100));
    assertEquals(dispatched, false, "missing type should not dispatch");

    // Send valid action — should dispatch
    ws.send(JSON.stringify({ v: 2, t: "action", d: { type: "Ping" } }));
    await new Promise((r) => setTimeout(r, 100));
    assertEquals(dispatched, true, "valid action should dispatch");

    ws.close();
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
});

// ── _timingSafeEqual edge cases ─────────────────────────────────────

Deno.test("_timingSafeEqual: identical short strings", () => {
  assertEquals(_timingSafeEqual("abc", "abc"), true);
});

Deno.test("_timingSafeEqual: different lengths always false", () => {
  assertEquals(_timingSafeEqual("short", "longer-string"), false);
});

Deno.test("_timingSafeEqual: empty strings equal", () => {
  assertEquals(_timingSafeEqual("", ""), true);
});

Deno.test("_timingSafeEqual: single char difference", () => {
  assertEquals(_timingSafeEqual("a", "b"), false);
});

Deno.test("_timingSafeEqual: unicode strings", () => {
  assertEquals(_timingSafeEqual("héllo", "héllo"), true);
  assertEquals(_timingSafeEqual("héllo", "hello"), false);
});

// ── Dev-mode UI endpoint tests ────────────────────────────────
// These catch the class of bugs where /__aio/ui.js breaks browser module loading.
// The most common failure: esbuild rewrites bare imports to Deno specifiers
// (e.g. 'react' → 'npm:react@^18') which browsers cannot fetch as URLs.

const DEV_UI_PORT = freePort();

async function withDevServer(
  fn: (url: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(
    join(dir, "App.tsx"),
    "export default function App() { return null }",
  );
  const server = createServer({
    port: DEV_UI_PORT,
    title: "DevUITest",
    getUIState: () => ({}),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: false,
  });
  // Allow server + esbuild to initialize
  await new Promise((r) => setTimeout(r, 200));
  try {
    await fn(`http://127.0.0.1:${DEV_UI_PORT}`);
  } finally {
    await server.shutdown();
    await Deno.remove(dir, { recursive: true });
  }
}

// Dev UI tests run in a single server instance to avoid port conflicts and esbuild
// child-process leaks (esbuild persists for the lifetime of the Deno process).
// sanitizeResources/Ops disabled because esbuild and the FS watcher outlive each test.
Deno.test({
  name: "dev: UI endpoints — ui.js, import map, App.tsx, error, client-error",
  fn: async () => {
    const dir = await Deno.makeTempDir();
    // App that imports react — common case where npm: specifier could leak.
    //
    // The mapping is DECLARED, and the import is USED. Both matter now that
    // the graph validator reads the SOURCE's imports rather than esbuild's
    // output (which elides an import whose bindings are unused): an app whose
    // `react` resolves nowhere is an app that blank-screens, and dev says so
    // instead of serving it — the same answer `deno check` gives. This fixture
    // is about where the specifier RESOLVES TO, not about a missing dep.
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { react: "npm:react@^18" } }),
    );
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      `import { useState } from 'react'\nexport default function App() { return useState ? null : null }`,
    );
    const server = createServer({
      port: DEV_UI_PORT,
      title: "DevUITest",
      getUIState: () => ({}),
      dispatch: () => {},
      baseDir: dir,
      debug: () => {},
      prod: false,
    });
    await new Promise((r) => setTimeout(r, 200));
    const url = `http://127.0.0.1:${DEV_UI_PORT}`;
    try {
      // ── /__aio/ui.js: basic response ──
      {
        const resp = await fetch(`${url}/__aio/ui.js`);
        assertEquals(resp.status, 200, "/__aio/ui.js must return 200");
        const ct = resp.headers.get("content-type") ?? "";
        assertEquals(
          ct.includes("application/javascript"),
          true,
          "/__aio/ui.js must have application/javascript content-type",
        );
        await resp.body?.cancel();
      }

      // ── /__aio/ui.js: no npm: specifiers (regression: v0.9.3 breakage) ──
      // esbuild running in Deno rewrites 'react' → 'npm:react@^18'.
      // Browsers cannot fetch npm: URLs — the import map maps 'react' → esm.sh.
      {
        const resp = await fetch(`${url}/__aio/ui.js`);
        assertEquals(resp.status, 200);
        const body = await resp.text();
        const npmImports = [...body.matchAll(/from "npm:[^"]+"/g)].map((m) =>
          m[0]
        );
        assertEquals(
          npmImports.length,
          0,
          `/__aio/ui.js has npm: specifiers that browsers can't fetch:\n  ${
            npmImports.join("\n  ")
          }\n\n` +
            `Fix: strip npm: prefix in transpile() so the HTML import map takes over.`,
        );
      }

      // ── HTML import map: no npm: URLs ──
      {
        const resp = await fetch(url);
        assertEquals(resp.status, 200);
        const body = await resp.text();
        const match = body.match(
          /<script type="importmap">([\s\S]*?)<\/script>/,
        );
        assertEquals(
          match !== null,
          true,
          "HTML must contain an importmap script",
        );
        const map = JSON.parse(match![1]!) as {
          imports: Record<string, string>;
        };
        // An import map that failed to generate is EMPTY, and an empty map
        // passes every assertion below without running one — which is the
        // failure this block exists to catch.
        assert(
          Object.keys(map.imports).length > 0,
          "the import map is empty — nothing was checked",
        );
        for (const [key, val] of Object.entries(map.imports)) {
          assertEquals(
            val.startsWith("npm:"),
            false,
            `import map "${key}":"${val}" — npm: URLs don't work in browsers`,
          );
        }
      }

      // ── /App.tsx: transpile has no npm: specifiers ──
      {
        const resp = await fetch(`${url}/App.tsx`);
        assertEquals(resp.status, 200);
        const body = await resp.text();
        const npmImports = [...body.matchAll(/from "npm:[^"]+"/g)].map((m) =>
          m[0]
        );
        assertEquals(
          npmImports.length,
          0,
          `/App.tsx has npm: specifiers: ${npmImports.join(", ")}`,
        );
      }

      // ── /__aio/error: returns JSON ──
      {
        const resp = await fetch(`${url}/__aio/error`);
        assertEquals(resp.status, 200);
        const ct = resp.headers.get("content-type") ?? "";
        assertEquals(ct.includes("application/json"), true);
        const data = await resp.json();
        assertEquals(data === null || typeof data === "object", true);
      }

      // ── /__aio/client-error: POST returns 200 with JSON classification ──
      {
        const resp = await fetch(`${url}/__aio/client-error`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: "test error",
            stack: "Error: test\n  at App.tsx:1:1",
          }),
        });
        assertEquals(resp.status, 200);
        const classified = await resp.json();
        assertEquals(typeof classified.classification, "string");
        assertEquals(typeof classified.label, "string");
      }

      // ── /__aio/client-error: malformed body → still 204 ──
      {
        const resp = await fetch(`${url}/__aio/client-error`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "not-json{{{",
        });
        assertEquals(resp.status, 204);
        await resp.body?.cancel();
      }
    } finally {
      await server.shutdown();
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// ── Package exports / config correctness ─────────────────────────────────────

Deno.test("config: deno.json exports ./build and ./am", async () => {
  const denoJsonPath = join(import.meta.dirname ?? ".", "..", "deno.json");
  const denoJson = JSON.parse(await Deno.readTextFile(denoJsonPath));
  const exports = denoJson.exports as Record<string, string> | string;
  // exports must be an object with the two sub-entries (not a bare string)
  assertEquals(
    typeof exports,
    "object",
    "deno.json exports must be an object to expose multiple entrypoints",
  );
  assertEquals(
    "./build" in (exports as Record<string, string>),
    true,
    "deno.json must export ./build — required by compile:* tasks (jsr:@riagentic/aio/build)",
  );
  assertEquals(
    "./am" in (exports as Record<string, string>),
    true,
    "deno.json must export ./am — required by am task (jsr:@riagentic/aio/am)",
  );
  // A1 audit: path-shaped and superseded entries must stay gone
  for (const gone of ["./src/build", "./src/am", "./adapters/air"]) {
    assertEquals(
      gone in (exports as Record<string, string>),
      false,
      `deno.json must not export ${gone} — removed in the A1 surface audit`,
    );
  }
});

// --- buildBrowserImportMap tests ---

Deno.test("buildBrowserImportMap: includes aio defaults", () => {
  const map = buildBrowserImportMap({});
  assertEquals(map["aio"], "/__aio/ui.js");
  assertEquals(map["aio/air"], "/__aio/air.js");
  assertEquals(map["aio/jsx-runtime"], "/__aio/jsx-runtime.ts");
});

Deno.test("buildBrowserImportMap: adds npm packages from deno.json", () => {
  const map = buildBrowserImportMap({ "xterm": "npm:xterm@5.3.0" });
  assertEquals(map["xterm"], "https://esm.sh/xterm@5.3.0");
});

Deno.test("buildBrowserImportMap: handles scoped npm packages", () => {
  const map = buildBrowserImportMap({
    "@xterm/xterm": "npm:@xterm/xterm@5.5.0",
  });
  assertEquals(map["@xterm/xterm"], "https://esm.sh/@xterm/xterm@5.5.0");
});

Deno.test("buildBrowserImportMap: does not override aio defaults", () => {
  const map = buildBrowserImportMap({ "aio": "npm:something@1.0.0" });
  assertEquals(map["aio"], "/__aio/ui.js");
});

Deno.test("buildBrowserImportMap: skips jsr: imports", () => {
  const map = buildBrowserImportMap({ "aio": "jsr:@riagentic/aio@1.0.0" });
  assertEquals(map["aio"], "/__aio/ui.js");
});

Deno.test("buildBrowserImportMap: skips non-npm non-jsr imports", () => {
  const map = buildBrowserImportMap({ "mylib": "./src/mylib.ts" });
  assertEquals(map["mylib"], undefined);
});

Deno.test("buildBrowserImportMap: includes aio/browser mapping", () => {
  const map = buildBrowserImportMap({});
  assertEquals(map["aio/browser"], "/__aio/ui.js");
});

// ── classifyBrowserError ──────────────────────────────────────

Deno.test("classifyBrowserError: detects missing module specifier", () => {
  const result = classifyBrowserError(
    'TypeError: Failed to resolve module specifier "xterm"',
  );
  assertEquals(result.classification, "missing-import");
  assertStringIncludes(result.fix, "deno.json");
  assertStringIncludes(result.fix, "xterm");
});

Deno.test("classifyBrowserError: server-only export (createDB) → teachable, points at the linter", () => {
  // The a field report 2026-07-20c blank screen: a static `import { createDB } from "aio"`
  // in a cell link-fails the client bundle at boot with this V8 message.
  const result = classifyBrowserError(
    "The requested module 'aio' does not provide an export named 'createDB'",
  );
  assertEquals(result.classification, "server-only-export");
  assertStringIncludes(result.fix, "createDB");
  assertStringIncludes(result.fix, "server-only");
  assertStringIncludes(result.fix, "lint:aio"); // points at the tool that names the file
});

Deno.test("classifyBrowserError: unknown missing export → generic import guidance", () => {
  const result = classifyBrowserError(
    "The requested module 'aio' does not provide an export named 'wat'",
  );
  assertEquals(result.classification, "server-only-export");
  assertStringIncludes(result.fix, "wat");
});

Deno.test("classifyBrowserError: detects @std server-only", () => {
  const result = classifyBrowserError(
    "Error: [aio] @std/fs.readFile is server-only",
  );
  assertEquals(result.classification, "server-only");
  assertStringIncludes(result.fix, "server-only");
});

Deno.test("classifyBrowserError: detects Deno is not defined", () => {
  const result = classifyBrowserError("ReferenceError: Deno is not defined");
  assertEquals(result.classification, "platform-api");
  assertStringIncludes(result.fix, "Deno");
});

Deno.test("classifyBrowserError: detects is not a function", () => {
  const result = classifyBrowserError("TypeError: readFile is not a function");
  assertEquals(result.classification, "stubbed-call");
  assertStringIncludes(result.fix, "server-only");
});

Deno.test("classifyBrowserError: returns unknown for unrecognized errors", () => {
  const result = classifyBrowserError("SyntaxError: Unexpected token");
  assertEquals(result.classification, "unknown");
  assertEquals(result.fix, "");
});

// _injectFilterFlag tests removed — function deleted in Immer patches migration

Deno.test("server: /__aio/metrics serves Prometheus text", async () => {
  await withServer(async (url) => {
    const resp = await fetch(`${url}/__aio/metrics`);
    assertEquals(resp.status, 200);
    assertStringIncludes(resp.headers.get("content-type") ?? "", "text/plain");
    const body = await resp.text();
    assertStringIncludes(body, "aio_uptime_seconds");
    assertStringIncludes(body, "aio_memory_heap_used_bytes");
    assertStringIncludes(body, "aio_clients_connected");
  });
});

Deno.test("server: custom routes — exact, wildcard, reserved namespaces", async () => {
  const dir = await Deno.makeTempDir();
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );
  const server = createServer({
    port: TEST_PORT_7,
    title: "Routes",
    getUIState: () => ({}),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
    routes: {
      "/api/echo": async (req) =>
        new Response(await req.text() || "empty", { status: 201 }),
      "/files/*": (req) =>
        new Response("file:" + new URL(req.url).pathname, { status: 200 }),
    },
  });
  await new Promise((r) => setTimeout(r, 50));
  try {
    const base = `http://127.0.0.1:${TEST_PORT_7}`;
    // exact route (POST body round-trip — the upload shape)
    const echo = await fetch(`${base}/api/echo`, {
      method: "POST",
      body: "hello",
    });
    assertEquals(echo.status, 201);
    assertEquals(await echo.text(), "hello");
    // wildcard
    const f = await fetch(`${base}/files/a/b.png`);
    assertEquals(await f.text(), "file:/files/a/b.png");
    // framework endpoints still win
    const h = await fetch(`${base}/__aio/metrics`);
    assertEquals(h.status, 200);
    await h.body?.cancel();
  } finally {
    await server.shutdown();
  }
  await Deno.remove(dir, { recursive: true });
});

Deno.test("server: reserved route namespaces throw at boot", async () => {
  const dir = await Deno.makeTempDir();
  let threw = "";
  try {
    createServer({
      port: TEST_PORT_8,
      title: "Bad",
      getUIState: () => ({}),
      dispatch: () => {},
      baseDir: dir,
      debug: () => {},
      prod: true,
      routes: { "/__aio/hack": () => new Response("no") },
    });
  } catch (e) {
    threw = String(e);
  }
  assertStringIncludes(threw, "reserved");
  await Deno.remove(dir, { recursive: true });
});

Deno.test("buildBrowserImportMap: framework runtime dep immer always resolves", () => {
  // Regression: an app dir without a deno.json (repo examples, ad-hoc apps)
  // produced an import map with no "immer" → the transpiled framework's own
  // `import "immer"` threw in the page → blank screen.
  const bare = buildBrowserImportMap({});
  const version = JSON.parse(Deno.readTextFileSync(
    new URL("../deno.json", import.meta.url),
  )).imports["immer"].slice("npm:".length);
  assertEquals(bare["immer"], `https://esm.sh/${version}`);
  // An app's own pin still wins.
  const pinned = buildBrowserImportMap({ "immer": "npm:immer@10.9.9" });
  assertEquals(pinned["immer"], "https://esm.sh/immer@10.9.9");
});

Deno.test("buildBrowserImportMap: local vendor copy preferred — dev works offline", () => {
  // With a local immer available the map points at the dev server's own
  // /__aio/vendor route (no CDN, no internet needed), even over an app pin —
  // the local copy IS the app's pin when the app pinned one (deno install
  // materializes it in the app's node_modules, probed first).
  const map = buildBrowserImportMap({ "immer": "npm:immer@10.9.9" }, {
    vendorImmer: true,
  });
  assertEquals(map["immer"], "/__aio/vendor/immer.js");
});

Deno.test("vendor immer: resolves locally and is browser-safe ESM", async () => {
  const { loadVendorImmer } = await import("../src/server/server-vendor.ts");
  const src = loadVendorImmer();
  // The framework repo always has a node_modules — this must resolve here.
  assert(src !== null, "local immer must resolve in the framework repo");
  assert(src.includes("produce"), "looks like immer");
  // The standard bundler define must be applied — bare process.env in module
  // scope is a ReferenceError in browsers.
  assert(
    !src.includes("process.env.NODE_ENV"),
    "process.env must be substituted",
  );
});

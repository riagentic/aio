// Regression: WebSocket Origin check must run unconditionally on browser
// upgrades — audit F-2.
//
// Previous logic: `if (!deps.expose || deps.allowedOrigins?.length) { check }`
// meant `--expose` without `allowedOrigins` skipped the check entirely,
// accepting any cross-origin WS upgrade — Cross-Site WebSocket Hijacking
// (CSWSH) surface. Token-in-URL auth doesn't help here: a leaked token from
// referrer/screen share lets an attacker page connect from any origin.
//
// Correct behavior: a submitted Origin must be this server's OWN origin (the
// page it served — Origin === Host) or a declared `allowedOrigins` entry (or
// `*`). Loopback is NOT self-certifying: that exemption was itself a CSWSH
// hole, since any other local port's page carries the SameSite=Strict cookie.
// Origin-less requests (server-side tools, curl) are accepted.

import { assertEquals } from "jsr:@std/assert@1.0.19";
import { createWsManager } from "../../src/server/server-ws.ts";

function makeDeps(extra: Partial<Parameters<typeof createWsManager>[0]> = {}) {
  return {
    dispatch: () => {},
    getUIState: () => ({}),
    debug: () => {},
    prod: false,
    clientCounter: { value: 0 },
    bootId: "test-boot",
    ...extra,
  };
}

function wsRequest(origin?: string): Request {
  // Minimal RFC 6455 upgrade request — Deno.upgradeWebSocket validates these
  // headers, but we only need to reach the origin check before the upgrade.
  const headers = new Headers({
    // A real upgrade carries Host; the origin gate compares against it.
    "host": "localhost",
    "upgrade": "websocket",
    "connection": "upgrade",
    "sec-websocket-key": btoa(crypto.randomUUID().slice(0, 16)),
    "sec-websocket-version": "13",
  });
  if (origin) headers.set("origin", origin);
  return new Request("http://localhost/ws", { headers });
}

Deno.test("F-2: cross-origin WS upgrade rejected with expose=true and no allowedOrigins", () => {
  const mgr = createWsManager(makeDeps({ expose: true }));
  const res = mgr.handleWs(wsRequest("https://evil.example.com"));
  assertEquals(res.status, 403);
});

Deno.test("F-2: cross-origin WS upgrade rejected with expose=false (regression check)", () => {
  const mgr = createWsManager(makeDeps({ expose: false }));
  const res = mgr.handleWs(wsRequest("https://evil.example.com"));
  assertEquals(res.status, 403);
});

// The server's OWN origin is the one a submitted Origin can prove: a page this
// server served has Origin === our Host header.
Deno.test("F-2: the server's own origin is accepted regardless of expose", () => {
  for (const expose of [false, true]) {
    const mgr = createWsManager(makeDeps({ expose }));
    // wsRequest() targets http://localhost/ws, so Host is "localhost".
    const res = mgr.handleWs(wsRequest("http://localhost"));
    // 101 Switching Protocols on success, NOT 403.
    // (Other failure modes — e.g. invalid WS handshake — are out of scope.)
    assertEquals(res.status === 403, false, `expose=${expose}`);
  }
});

// A SUBMITTED origin cannot self-certify. This used to exempt every loopback
// hostname unconditionally — so `http://localhost:1234` (another local dev
// server, a local tool's UI) walked past the gate, under `--expose` included.
// A port is not part of a "site", so the `SameSite=Strict` session cookie is
// sent: that page could open an AUTHENTICATED socket as the victim and
// dispatch. Loopback is not a trust boundary; the Host header is.
Deno.test("F-2: a foreign loopback origin is refused", () => {
  for (const expose of [false, true]) {
    const mgr = createWsManager(makeDeps({ expose }));
    for (
      const origin of [
        "http://localhost:1234",
        "http://127.0.0.1:8000",
        "http://[::1]:8000",
      ]
    ) {
      const res = mgr.handleWs(wsRequest(origin));
      assertEquals(res.status, 403, `origin ${origin} expose=${expose}`);
    }
  }
});

// …and the escape hatch stays: a genuinely trusted local port is declared.
Deno.test("F-2: a foreign loopback origin in allowedOrigins is accepted", () => {
  const mgr = createWsManager(
    makeDeps({ allowedOrigins: ["http://localhost:1234"] }),
  );
  assertEquals(
    mgr.handleWs(wsRequest("http://localhost:1234")).status === 403,
    false,
  );
});

Deno.test("F-2: explicit allowedOrigins entry accepted", () => {
  const mgr = createWsManager(
    makeDeps({ expose: true, allowedOrigins: ["app.example.com"] }),
  );
  const res = mgr.handleWs(wsRequest("https://app.example.com"));
  assertEquals(res.status === 403, false);
});

Deno.test("F-2: wildcard '*' allowedOrigins entry accepts any origin (opt-in)", () => {
  const mgr = createWsManager(
    makeDeps({ expose: true, allowedOrigins: ["*"] }),
  );
  const res = mgr.handleWs(wsRequest("https://anywhere.example.com"));
  assertEquals(res.status === 403, false);
});

Deno.test("F-2: Origin-less request accepted (curl, server-side tools)", () => {
  for (const expose of [false, true]) {
    const mgr = createWsManager(makeDeps({ expose }));
    const res = mgr.handleWs(wsRequest());
    assertEquals(res.status === 403, false, `expose=${expose}`);
  }
});

Deno.test("F-2: malformed Origin returns 400, never bypasses", () => {
  const mgr = createWsManager(makeDeps({ expose: true }));
  const res = mgr.handleWs(wsRequest("not-a-url"));
  assertEquals(res.status, 400);
});

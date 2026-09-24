// The WS Origin check reads the name the client reached us as through
// `requestHost` — THE reader of that fact (v1.0.11 hunt). It read
// `req.headers.get("host")`, so a request with no Host header (HTTP/2's
// `:authority`, which Deno surfaces only in `req.url`) had its OWN origin
// judged cross-origin — the same bug the HTTP gates had, left in the one
// place that kept a private copy of the read.

import { assertEquals, assertNotEquals } from "@std/assert";
import { createWsManager } from "../src/server/server-ws.ts";

Deno.test("ws origin check: with no Host header, the URL's authority is this server's own origin", () => {
  const mgr = createWsManager({
    dispatch: () => {},
    getUIState: () => ({}),
    debug: () => {},
    prod: true,
    clientCounter: { value: 0 },
    bootId: "b",
    secure: true,
  });
  const status = (origin: string): number | "upgrade-attempted" => {
    const req = new Request("https://app.test:8443/ws", {
      headers: { origin, upgrade: "websocket" },
    });
    assertEquals(req.headers.get("host"), null, "no Host — the h2 shape");
    try {
      return mgr.handleWs(req).status;
    } catch {
      // Past the Origin gate: a constructed Request cannot be upgraded.
      return "upgrade-attempted";
    }
  };
  try {
    assertNotEquals(status("https://app.test:8443"), 403);
    assertEquals(status("https://evil.test:8443"), 403);
  } finally {
    mgr.shutdown();
  }
});

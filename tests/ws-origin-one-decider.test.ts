// The WebSocket upgrade's Origin gate IS `originVerdict` — one decider, not a
// hand-kept copy of it.
//
// server-ws.ts carried its own inline spelling of the own-origin + scheme +
// `allowedOrigins` rules while the HTTP CSRF gate read `originVerdict`
// (server-auth.ts). Two spellings of one rule drift: the shared decider had
// learned `aio://app` — the privileged scheme only aio's Electron shell
// registers, which no web page can put in an Origin header — and the socket
// gate still refused it with 403.
//
// Differential over the whole table, so any future divergence in either
// direction is red here rather than a socket that cannot connect.
import { assertEquals } from "@std/assert";
import { createWsManager } from "../src/server/server-ws.ts";
import { originVerdict } from "../src/server/server-auth.ts";

const ORIGINS = [
  "http://localhost",
  "https://localhost",
  "http://localhost:8000",
  "http://LOCALHOST:8000",
  "http://127.0.0.1:8000",
  "https://evil.example.com",
  "null",
  "not a url",
  "aio://app",
  "aio://evil",
  "https://dash.corp:8443",
  "https://dash.corp",
  "http://dash.corp:8443",
  "http://[::1]:8000",
];
const HOSTS = ["localhost", "localhost:8000", "dash.corp:8443", null];
const ALLOWS: (string[] | undefined)[] = [
  undefined,
  ["*"],
  ["dash.corp"],
  ["https://dash.corp:8443"],
  [" LOCALHOST:8000 "],
];

function upgrade(origin: string, host: string | null): Request {
  const headers = new Headers({
    upgrade: "websocket",
    connection: "upgrade",
    "sec-websocket-key": btoa("0123456789abcdef"),
    "sec-websocket-version": "13",
    origin,
  });
  if (host !== null) headers.set("host", host);
  return new Request("http://x/ws", { headers });
}

Deno.test("ws origin: the upgrade gate answers exactly what originVerdict answers — aio://app included", () => {
  let admittedAio = 0;
  for (const secure of [false, true]) {
    for (const allowedOrigins of ALLOWS) {
      const mgr = createWsManager({
        dispatch: () => {},
        getUIState: () => ({}),
        debug: () => {},
        prod: true,
        clientCounter: { value: 0 },
        bootId: "b",
        secure,
        expose: true,
        allowedOrigins,
      });
      for (const host of HOSTS) {
        for (const origin of ORIGINS) {
          const want = originVerdict(origin, {
            hostHeader: host,
            secure,
            allowedOrigins,
          })?.status ?? "admitted";
          let got: number | "admitted";
          try {
            const r = mgr.handleWs(upgrade(origin, host));
            got = r.status === 400 || r.status === 403 ? r.status : "admitted";
          } catch {
            // Past the gate: `Deno.upgradeWebSocket` refuses a Request that did
            // not come from a live connection. The gate admitted it.
            got = "admitted";
          }
          assertEquals(
            got,
            want,
            `secure=${secure} allowed=${
              JSON.stringify(allowedOrigins)
            } host=${host} origin=${origin}`,
          );
          if (origin === "aio://app" && got === "admitted") admittedAio++;
        }
      }
    }
  }
  // Non-vacuous: the case the inline copy got wrong was exercised and admitted.
  assertEquals(admittedAio > 0, true, "aio://app must reach the upgrade");
});

// The server closes a socket with 1008 for three reasons: its per-connection
// budget ("Rate limit exceeded"), a revoked login session ("session revoked")
// and a revoked `users:`/`resolveUser` credential ("credential revoked"). The
// browser transport answered every 1008 as the first one — "the server's
// per-connection message budget was exceeded; it may refuse reconnects
// briefly" — so a user signed out elsewhere, or whose session expired, sent
// the developer to raise `wsLimits` for a budget nobody had crossed.
import { assert, assertEquals } from "@std/assert";
import { enc } from "../src/protocol/envelope.ts";
import { protoHello } from "../src/protocol/protocol-version.ts";
import { freePort } from "../src/testing/server-test.ts";
import {
  diagSubscribe,
  initDiagnosticBus,
} from "../src/diagnostics/diagnostic-bus.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("browser transport: a 1008 'session revoked' close is not reported as a message-budget breach", async () => {
  const port = freePort();
  let conn = 0;
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      if (new URL(req.url).pathname !== "/ws") {
        return new Response("not here", { status: 404 });
      }
      const { socket, response } = Deno.upgradeWebSocket(req);
      const n = ++conn;
      socket.onopen = () => {
        socket.send(enc("proto", protoHello()));
        socket.send(enc("state", {}));
        if (n === 1) {
          setTimeout(() => socket.close(1008, "session revoked"), 50);
        }
      };
      return response;
    },
  );
  const g = globalThis as Record<string, unknown>;
  g.location = {
    protocol: "http:",
    host: `127.0.0.1:${port}`,
    search: "",
    origin: `http://127.0.0.1:${port}`,
  };
  initDiagnosticBus(true); // the bus is dev-only; this is a dev page
  const hints: string[] = [];
  const unDiag = diagSubscribe((e) => {
    if (e.type === "browser-air-transport:closed-by-policy") {
      hints.push(`${e.message} ${e.hint ?? ""}`);
    }
  });
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => {
    errors.push(a.map(String).join(" "));
  };
  await import("../src/browser/browser-air-transport.ts");
  const { ensureConnected } = await import(
    "../src/browser/browser-protocol.ts"
  );
  const sub = await import("../src/browser/protocol-subscription.ts");
  const unsub = sub._subscribe(() => {});
  try {
    ensureConnected();
    for (let i = 0; i < 100 && hints.length === 0; i++) await sleep(20);
    assertEquals(hints.length, 1, "the policy close was reported once");
    assert(
      !/budget/i.test(hints[0]!),
      `a revoked session was blamed on the message budget: ${hints[0]}`,
    );
    const line = errors.find((l) => l.includes("(1008)")) ?? "";
    assert(line.includes("session revoked"), `console names it: ${line}`);
    assert(!/budget|refused \(429\)/i.test(line), `console: ${line}`);
  } finally {
    console.error = origError;
    unDiag();
    unsub();
    await sleep(400);
    await server.shutdown();
  }
});

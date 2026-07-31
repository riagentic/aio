// Browser degraded() escalations are visible in /__aio/health.
//
// Each runtime keeps its own degraded registry, so before the `cdiag` frame a
// browser subsystem could fail forever (sync retries, an app's own guard())
// while the SERVER's health endpoint reported "healthy" — the exact
// looks-fine-while-dead failure the endpoint exists to prevent. The transport
// relays escalation/recovery frames; the server records them per client,
// aggregates them in health output, and drops them when the client goes away.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";
import { enc } from "../src/protocol/envelope.ts";
import {
  _recordClientDegraded,
  _resetDegraded,
  clientDegradedReport,
} from "../src/diagnostics/degraded.ts";

Deno.test("cdiag: a client escalation flips /__aio/health to degraded; disconnect clears it", async () => {
  _resetDegraded();
  const c = cell("cdiag-cell", { state: { n: 0 }, methods: {} });
  await using srv = await testServer({ cells: [c] });
  const wsUrl = srv.url.replace("http", "ws") + "/ws";

  const ws = new WebSocket(wsUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(e);
  });
  try {
    ws.send(enc("cdiag", {
      name: "nft-cache",
      kind: "down",
      failures: 41,
      since: 1,
      lastError: "fetch failed",
    }));
    // The frame is processed on the server's event loop — poll briefly.
    let health: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      health = await (await fetch(`${srv.url}/__aio/health`)).json();
      if (health.status === "degraded") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assertEquals(health.status, "degraded", JSON.stringify(health));
    const rows = health.clientDegraded as {
      name: string;
      clients: number;
      lastError: string;
    }[];
    assertEquals(rows.length, 1);
    assertEquals(rows[0]!.name, "nft-cache");
    assertEquals(rows[0]!.clients, 1);
    assertEquals(rows[0]!.lastError, "fetch failed");

    // Recovery frame clears it.
    ws.send(
      enc("cdiag", {
        name: "nft-cache",
        kind: "up",
        failures: 0,
        since: 1,
        lastError: "",
      }),
    );
    for (let i = 0; i < 50; i++) {
      health = await (await fetch(`${srv.url}/__aio/health`)).json();
      if (health.status === "healthy") break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assertEquals(health.status, "healthy", "recovery frame cleared it");
  } finally {
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  }

  // Disconnect clears any remaining records for that client.
  assertEquals(clientDegradedReport(), []);
  _resetDegraded();
});

Deno.test("cdiag: server-side caps — names, errors and per-client entry count", () => {
  _resetDegraded();
  for (let i = 0; i < 40; i++) {
    _recordClientDegraded("c1", {
      name: `op-${i}-${"x".repeat(100)}`,
      kind: "down",
      failures: 1,
      since: 0,
      lastError: "e".repeat(1000),
    });
  }
  const rows = clientDegradedReport();
  assertEquals(rows.length, 16, "per-client cap");
  assert(rows.every((r) => r.name.length <= 64), "name cap");
  assert(rows.every((r) => r.lastError.length <= 200), "error cap");
  _resetDegraded();
});

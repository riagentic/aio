// A "transport frozen" alert names the client (aipro §11).
//
// `onClientFrozen` dropped the id (`void clientId`), so with six clients
// connected (a panel, its reload socket, three `peer()` apps) the alert said
// nothing about which one — and on loopback its "Network connection stalled"
// pointed the wrong way: no network lies between them, a missed ping there is
// the client's own busy main thread. ~1 h to find it was the panel.
//
// Real server, real sockets; the watchdog tick is driven by hand.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createServer } from "../src/server/server.ts";
import { describeWsClient } from "../src/server/server-ws.ts";
import { createVitalsSystem } from "../src/vitals/mod.ts";
import { DEFAULT_THRESHOLDS, type VitalAlert } from "../src/vitals/types.ts";
import { enc } from "../src/protocol/envelope.ts";
import { protoHello } from "../src/protocol/protocol-version.ts";
import { _connectCli, _connectCliUDS } from "../src/server/cli-client.ts";
import { listenLocal } from "../src/server/local-listen.ts";
import { peer } from "../src/server/peer.ts";
import { localEndpoint, localIdle } from "./local-endpoint-helper.ts";
import { freePort } from "../src/testing/server-test.ts";
import { AppLock } from "../src/server/single-instance-lock.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const FROZEN_MS = 150;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("vitals: a frozen client is named — id, kind, and loopback means a busy main thread", async () => {
  const dir = await tempDir("aio-frozen-names-");
  await Deno.mkdir(join(dir, "dist"), { recursive: true });
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );
  const alerts: VitalAlert[] = [];
  const vitals = createVitalsSystem({
    thresholds: {
      transport: { ...DEFAULT_THRESHOLDS.transport, frozen: FROZEN_MS },
    },
    pressure: false,
    onVitalAlert: (a) => void alerts.push(a),
  });
  const port = freePort();
  const server = createServer({
    port,
    title: "FrozenNames",
    getUIState: () => ({}),
    dispatch: () => {},
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
    syncIntervalMs: 10,
    vitalsSystem: vitals,
  });
  const open = async (first: string) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    ws.send(first);
    ws.send(enc("vitals-ping", { t1: Date.now() }));
    return ws;
  };
  const page = await open(enc("type", { kind: "browser" }));
  const peer = await open(enc("proto", protoHello("1.0.0")));
  // A `peer()` says which app is calling (its hello's `appId`).
  const named = await open(
    enc("proto", { ...protoHello("1.0.0"), appId: "broker" }),
  );
  try {
    await sleep(FROZEN_MS + 100);
    vitals.checkAndAlert();
    const frozen = alerts.filter((a) => a.status === "frozen");
    assertEquals(frozen.length, 3, JSON.stringify(alerts));
    const causes = frozen.map((a) => a.hint?.cause ?? "");
    const ids = vitals.getEndpointData().clients.map((c) => c.id.slice(0, 8));
    assertEquals(ids.length, 3, ids.join(","));
    for (const id of ids) {
      assert(
        causes.some((c) => c.includes(`client ${id}`)),
        `${id}: ${causes}`,
      );
    }
    assert(causes.some((c) => /, browser\)/.test(c)), causes.join("\n"));
    assert(causes.some((c) => /, peer\)/.test(c)), causes.join("\n"));
    assert(causes.some((c) => /, peer:broker\)/.test(c)), causes.join("\n"));
    assertEquals(causes.length, 3);
    for (const c of causes) {
      assert(c.includes("main thread was busy"), c);
      assert(!c.includes("Network"), c);
    }
  } finally {
    page.close();
    peer.close();
    named.close();
    await sleep(50);
    await server.shutdown();
    vitals.destroy();
    await dropTempDir(dir);
  }
});

Deno.test("cli client: a peer()'s hello names the calling app", async () => {
  // What `peer()` passes (`appId`, peer.ts) reaches the wire; an older
  // server's `parseProtoHello` keeps it and its `meta.peer` ignores it.
  const port = freePort();
  let hello: Record<string, unknown> | undefined;
  const srv = Deno.serve({ port, onListen: () => {} }, (req) => {
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("no", { status: 404 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onmessage = (e) => {
      const f = JSON.parse(String(e.data));
      if (f.t === "proto") hello ??= f.d;
    };
    return response;
  });
  const link = _connectCli(`http://127.0.0.1:${port}`, { appId: "broker" });
  try {
    for (let i = 0; i < 300 && !hello; i++) await sleep(10);
    assertEquals(hello?.appId, "broker");
  } finally {
    link.close();
    await srv.shutdown();
  }
});

Deno.test("cli client over the local socket: the hello names the calling app", async () => {
  const dir = await tempDir("aio-uds-hello-");
  const l = listenLocal(localEndpoint(join(dir, "h.sock")));
  let hello: Record<string, unknown> | undefined;
  const served = (async () => {
    for await (const conn of l) {
      const r = conn.readable.getReader();
      let acc = "";
      const td = new TextDecoder();
      while (!hello) {
        const { value, done } = await r.read();
        if (done) break;
        acc += td.decode(value);
        for (const line of acc.split("\n")) {
          const f = line ? JSON.parse(line) : null;
          if (f?.t === "proto") hello = f.d;
        }
      }
      r.releaseLock();
      conn.close();
      return;
    }
  })();
  const link = _connectCliUDS(l.path, { appId: "broker" });
  try {
    for (let i = 0; i < 300 && !hello; i++) await sleep(10);
    assertEquals(hello?.appId, "broker");
  } finally {
    link.close();
    l.close();
    await served.catch(() => {});
    await localIdle();
    await dropTempDir(dir);
  }
});

Deno.test("peer() with a token still names the calling app", async () => {
  // The token path carries no identity proof — the name is a diagnostic
  // claim, so it goes on every door anyway.
  // This process runs app `callerapp` (a live lock), as a real caller does.
  const lock = new AppLock("callerapp");
  assertEquals((await lock.acquire(1)).ok, true);
  const port = freePort();
  let hello: Record<string, unknown> | undefined;
  const srv = Deno.serve({ port, onListen: () => {} }, (req) => {
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("no", { status: 404 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onmessage = (e) => {
      const f = JSON.parse(String(e.data));
      if (f.t === "proto") hello ??= f.d;
    };
    return response;
  });
  const got = peer(`http://127.0.0.1:${port}`, {
    token: "t",
    readyTimeoutMs: 300,
  }).catch(() => null);
  try {
    for (let i = 0; i < 300 && !hello; i++) await sleep(10);
    assertEquals(hello?.appId, "callerapp");
  } finally {
    (await got)?.close();
    await srv.shutdown();
    lock.release();
  }
});

Deno.test("describeWsClient: kind, user, and loopback by address", () => {
  const base = {
    id: "0123456789abcdef",
    index: 4,
    clientType: "browser-reload" as const,
  };
  const remote = (ip: string, headers: HeadersInit = {}) =>
    ({ ip, headers: new Headers(headers) }) as never;
  assertEquals(
    describeWsClient({
      ...base,
      protocolVersion: 2,
      peer: { aio: "1.0.25-beta", app: "2.1.0" },
      user: { id: "broker", role: "peer" },
      request: remote("::ffff:127.0.0.1"),
    }),
    { label: "client 01234567 (#4, peer@2.1.0, user=broker)", loopback: true },
  );
  assertEquals(
    describeWsClient({
      ...base,
      protocolVersion: 2,
      peer: { app: "2.1.0", appId: "broker" },
    }).label,
    "client 01234567 (#4, peer:broker)",
  );
  assertEquals(
    describeWsClient({
      ...base,
      clientType: "electron",
      request: remote("::1"),
    })
      .label,
    "client 01234567 (#4, electron)",
  );
  assertEquals(
    describeWsClient({ ...base, request: remote("10.0.0.7") }),
    { label: "client 01234567 (#4, browser-reload)", loopback: false },
  );
  // A local reverse proxy: loopback address, a network behind it — no
  // "not the network" claim.
  assertEquals(
    describeWsClient({
      ...base,
      clientType: "browser",
      request: remote("127.0.0.1", { "x-forwarded-for": "203.0.113.9" }),
    }),
    { label: "client 01234567 (#4, browser, via proxy)", loopback: false },
  );
});

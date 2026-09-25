// A subscription to a cell id this server does not have must be SAID.
//
// `filterStateBySubs` keeps only the subscribed cells that exist, so a typo'd
// id ("todo" for "todos") yields an empty view for it: the component renders
// its defaults forever, no frame for it ever arrives, and nothing anywhere
// names the cause. Accepted as before (1.0.11 did), but warned — once per id,
// naming the unknown id and the ids that do exist.
import { assert, assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { enc } from "../src/protocol/envelope.ts";
import { warnUnknownSubs } from "../src/protocol/broadcast-utils.ts";
import { protoHello } from "../src/protocol/protocol-version.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { createUDSListener } from "../src/server/uds.ts";
import { join } from "@std/path";

Deno.test("ws: a subscription to an unknown cell id is warned once, naming the known ids", async () => {
  const todos = cell("subtodos", {
    state: { n: 0 },
    methods: {
      bump(s: { n: number }) {
        s.n++;
      },
    },
  });
  const lines: string[] = [];
  const orig = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  for (const k of ["log", "info", "warn", "error"] as const) {
    console[k] = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  }
  const port = freePort();
  const dir = await tempDir("aio-subs-unknown-");
  let app: { close: () => Promise<void> } | undefined;
  const ws: WebSocket[] = [];
  try {
    app = await aio.run({
      cells: [todos],
      appId: `subsunknown-${Deno.pid}`,
      client: "server-only",
      persist: false,
      libraryMode: true,
      singleton: false,
      port,
      baseDir: dir,
      dbPath: ":memory:",
      // deno-lint-ignore no-explicit-any
    } as any);
    // Two clients with the same typo: said once, not per client.
    for (let i = 0; i < 2; i++) {
      const s = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.push(s);
      await new Promise<void>((res, rej) => {
        s.onopen = () => res();
        s.onerror = () => rej(new Error("socket failed to open"));
      });
      s.send(enc("proto", protoHello()));
      s.send(enc("subs", { subs: ["subtodo.n", "subtodos"] }));
    }
    const said = () => lines.filter((l) => l.includes('"subtodo"'));
    const t0 = Date.now();
    while (said().length === 0 && Date.now() - t0 < 4000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await new Promise((r) => setTimeout(r, 200)); // the second client's frame
    assertEquals(said().length, 1, `once per id: ${lines.join(" | ")}`);
    assert(
      said()[0]!.includes("subtodos"),
      `names the known ids: ${said()[0]}`,
    );
    assert(
      !lines.some((l) => l.includes('"subtodos"') && l.includes("unknown")),
      "a known id is not warned about",
    );
  } finally {
    for (const s of ws) s.close();
    await app?.close();
    Object.assign(console, orig);
    await dropTempDir(dir);
  }
});

Deno.test("uds: a subscription to an unknown cell id is warned, naming the known ids", async () => {
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of ["log", "warn", "error"] as const) {
    console[k] = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
  }
  const dir = await tempDir("aio-uds-subs-unknown-");
  const uds = createUDSListener(
    join(dir, "s.sock"),
    () => ({ udscounter: { value: 1 } }),
    () => {},
    () => {},
  );
  let conn: Deno.Conn | undefined;
  try {
    await new Promise((r) => setTimeout(r, 50));
    conn = await Deno.connect({ path: join(dir, "s.sock"), transport: "unix" });
    const w = conn.writable.getWriter();
    await w.write(
      new TextEncoder().encode(
        '{"v":2,"t":"subs","d":{"subs":["udscountr"]}}\n',
      ),
    );
    w.releaseLock();
    const said = () => lines.filter((l) => l.includes('"udscountr"'));
    const t0 = Date.now();
    while (said().length === 0 && Date.now() - t0 < 4000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assertEquals(said().length, 1, lines.join(" | "));
    assert(said()[0]!.includes("udscounter"), said()[0]);
  } finally {
    conn?.close();
    uds.shutdown();
    Object.assign(console, orig);
    await dropTempDir(dir);
  }
});

// The client half: reading a `scope: "client"` cell must not subscribe the
// server to it — no server has that cell, so the path could only trip the
// warning above on every page that uses one (a false alarm teaches people to
// ignore the real one).
Deno.test("client: reading a client-scope cell does not subscribe the server to it", async () => {
  const { bindCellReactive } = await import("../src/state/cell-reactive.ts");
  const { _resetSubs, _setSubsSendFn } = await import(
    "../src/state/state-subs.ts"
  );
  _resetSubs();
  const sent: string[] = [];
  _setSubsSendFn((msg) => void sent.push(msg));
  try {
    const drawer = cell("subsclientdrawer", {
      scope: "client",
      state: { open: false },
      methods: {
        toggle(s: { open: boolean }) {
          s.open = !s.open;
        },
      },
    });
    const shared = cell("subssharedlist", {
      state: { n: 0 },
      methods: {
        bump(s: { n: number }) {
          s.n++;
        },
      },
    });
    // deno-lint-ignore no-explicit-any
    bindCellReactive(drawer as any);
    // deno-lint-ignore no-explicit-any
    bindCellReactive(shared as any);
    void drawer.open;
    void shared.n;
    await new Promise((r) => setTimeout(r, 40));
    assert(sent.length > 0, "the server cell's read was subscribed");
    assert(sent.some((m) => m.includes("subssharedlist")), sent.join(" | "));
    assert(
      !sent.some((m) => m.includes("subsclientdrawer")),
      `a client-scope cell reached the server's subs: ${sent.join(" | ")}`,
    );
  } finally {
    _setSubsSendFn(null);
    _resetSubs();
  }
});

// …and a page that reads ONLY client-scope cells still narrows. 1.0.11 sent
// the client cell's id, which the server filtered to nothing: no server
// deltas for a page that renders none. Sending no frame at all instead left
// the connection on the wildcard — every server cell's every delta streamed
// to a page that reads none of them.
Deno.test("client: a page reading only client-scope cells subscribes to no server cell, silently", async () => {
  const { bindCellReactive } = await import("../src/state/cell-reactive.ts");
  const { _resetSubs, _setSubsSendFn } = await import(
    "../src/state/state-subs.ts"
  );
  const { filterStateBySubs, parseSubs } = await import(
    "../src/protocol/broadcast-utils.ts"
  );
  const { dec } = await import("../src/protocol/envelope.ts");
  _resetSubs();
  const sent: string[] = [];
  _setSubsSendFn((msg) => void sent.push(msg));
  const lines: string[] = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  try {
    const drawer = cell("subsonlyclientdrawer", {
      scope: "client",
      state: { open: false },
      methods: {
        toggle(s: { open: boolean }) {
          s.open = !s.open;
        },
      },
    });
    // deno-lint-ignore no-explicit-any
    bindCellReactive(drawer as any);
    void drawer.open;
    await new Promise((r) => setTimeout(r, 40));
    assertEquals(sent.length, 1, "a subs frame narrows the connection");
    const frame = dec(sent[0]!) as { d: { subs: unknown } };
    for (const k of ["log", "warn", "error"] as const) {
      console[k] = (...a: unknown[]) =>
        void lines.push(a.map(String).join(" "));
    }
    const subs = parseSubs(frame.d.subs);
    assert(subs instanceof Set, `not the wildcard: ${sent[0]}`);
    assertEquals(
      filterStateBySubs({ big: { rows: [1, 2, 3] } }, subs),
      {},
      "no server cell is sent",
    );
    warnUnknownSubs(subs, new Set(["big"]));
    Object.assign(console, orig);
    assertEquals(lines, [], "the client-only marker is not a typo'd id");
  } finally {
    Object.assign(console, orig);
    _setSubsSendFn(null);
    _resetSubs();
  }
});

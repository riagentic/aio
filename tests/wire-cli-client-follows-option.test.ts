// `aio.run({ wire: { omitTrailingUndefined: true } })` is decided on the
// server and USED by whoever encodes the call. The browser learns it from its
// shell; a CLI client has no shell — it has the `cfg` frame, which it used to
// ignore, so `add("x", undefined)` reached the method as `add("x", null)`
// from a terminal and as `add("x")` from a browser tab of the same app.
//
// A real server in a real subprocess, the option on and off, and calls made
// both BEFORE the connection opens (queued, flushed at open — before any
// frame from the server) and after `ready`.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { dec, enc } from "../src/protocol/envelope.ts";
import {
  parseProtoHello,
  protoHello,
} from "../src/protocol/protocol-version.ts";
import { VERSION } from "../src/server/aio-cli.ts";
import { testServer } from "../src/testing/server-test.ts";
import { cell } from "../src/state/cell-create.ts";
import { connectCli, connectCliUDS } from "../src/server/cli-client.ts";
import { createUDSListener } from "../src/server/aio.ts";
import { join } from "@std/path";
import { localEndpoint, localIdle } from "./local-endpoint-helper.ts";
import { freePort } from "../src/testing/server-test.ts";
import type { CellDef } from "../src/state/cell-types.ts";
import { stopChild } from "./stop-child.ts";
import {
  childCoverageDir,
  dropTempDir,
  tempDir,
} from "../src/testing/temp-dir.ts";
import { fromFileUrl } from "@std/path";
const _childCovDir = childCoverageDir();

const serverApp = (wire: boolean) => `
import { cell, aio } from "${new URL("../mod.ts", import.meta.url).href}";
cell("wcli", {
  state: { n: 0 },
  methods: {
    seen(s, ...rest) { s.n++; return rest.map((v) => v === undefined ? "undefined" : JSON.stringify(v)); },
    dflt(s, a, b = "dflt") { s.n++; return [a, b]; },
  },
});
await aio.run({ client: "server-only", persist: false, appId: "wire-cli-probe"${
  wire ? ", wire: { omitTrailingUndefined: true }" : ""
} });
`;

type Calls = Record<string, (...a: unknown[]) => Promise<unknown>>;

/** `p`, or a failure that says what never came. A call this file awaits is
 *  one a regression leaves waiting forever — and a test that hangs names
 *  nothing. The timer is cleared either way. */
async function within<T>(p: Promise<T>, what: string, ms = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, no) => {
        timer = setTimeout(
          () => no(new Error(`still waiting after ${ms} ms for ${what}`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function received(wire: boolean): Promise<unknown[]> {
  const dir = await tempDir("aio-wire-cli-");
  await Deno.writeTextFile(`${dir}/app.ts`, serverApp(wire));
  const port = freePort();
  const proc = new Deno.Command(Deno.execPath(), {
    env: { DENO_COVERAGE_DIR: _childCovDir, AIO_APPS_DIR: dir },
    args: [
      "run",
      "-A",
      "--unstable-kv",
      "--config",
      fromFileUrl(new URL("../deno.json", import.meta.url)),
      "app.ts",
      `--port=${port}`,
    ],
    cwd: dir,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  proc.stdout.pipeTo(new WritableStream({ write() {} })).catch(() => {});
  proc.stderr.pipeTo(new WritableStream({ write() {} })).catch(() => {});
  const def = cell(`wcli`, {
    state: { n: 0 },
    methods: {
      seen(_s: { n: number }, ..._rest: unknown[]) {},
      dflt(_s: { n: number }, _a: unknown, _b: unknown = "dflt") {},
    },
  });
  const cli = connectCli<{ wcli: { n: number } }>(`http://localhost:${port}`);
  try {
    cli.bind(def as unknown as CellDef);
    const m = def as unknown as Calls;
    // Before the socket exists: these wait in the queue and are flushed the
    // moment it opens. Order is part of the contract.
    const early = [
      m.seen!("x", undefined),
      m.seen!("plain"),
      m.dflt!("a", undefined),
      m.seen!(undefined, "mid"),
    ];
    await cli.ready;
    const late = [m.seen!("y", undefined), m.dflt!("b", undefined)];
    return await within(
      Promise.all([...early, ...late]),
      "the six calls' results (three queued before the socket opened)",
      20_000,
    );
  } finally {
    cli.close();
    await stopChild(proc, { quiet: true });
    await dropTempDir(dir);
  }
}

Deno.test({
  name:
    "wire option (CLI client): off — a trailing undefined arrives as null, as it always has",
  async fn() {
    assertEquals(await received(false), [
      ['"x"', "null"],
      ['"plain"'],
      ["a", null],
      ["null", '"mid"'],
      ['"y"', "null"],
      ["b", null],
    ]);
  },
});

Deno.test({
  name:
    "wire option (CLI client): on — the method gets the arguments that were given, queued call or live",
  async fn() {
    assertEquals(await received(true), [
      ['"x"'],
      ['"plain"'],
      ["a", "dflt"],
      ["null", '"mid"'],
      ['"y"'],
      ["b", "dflt"],
    ]);
  },
});

/** What a real UDS listener is handed by `connectCliUDS`, for one config. */
async function overUds(
  clientConfig: Record<string, unknown>,
): Promise<unknown[]> {
  const dir = await tempDir("aio-wire-cli-uds-");
  const socketPath = localEndpoint(join(dir, "w.sock"));
  const got: unknown[] = [];
  const uds = createUDSListener(
    socketPath,
    () => ({ n: 0 }),
    (a) => void got.push([a.type, (a.payload as { args: unknown[] }).args]),
    () => {},
    undefined,
    undefined,
    clientConfig,
  );
  const cli = connectCliUDS<{ n: number }>(socketPath);
  const call = (type: string, ...args: unknown[]) =>
    cli.send({ type, payload: { args } });
  try {
    // Queued before the connection exists; order is part of the contract.
    call("u:a", "x", undefined);
    call("u:b", 1);
    call("u:c", undefined, "mid");
    await cli.ready;
    call("u:d", "y", undefined);
    for (let i = 0; i < 400 && got.length < 4; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    return got;
  } finally {
    cli.close();
    uds.shutdown();
    await localIdle();
    await dropTempDir(dir);
  }
}

Deno.test("wire option (CLI client, local socket): follows the cfg frame; without it the frames and their order are unchanged", async () => {
  assertEquals(await overUds({ callTimeouts: { default: 1 } }), [
    ["u:a", ["x", null]],
    ["u:b", [1]],
    ["u:c", [null, "mid"]],
    ["u:d", ["y", null]],
  ]);
  // No cfg frame at all (an empty config is not sent): nothing waits.
  assertEquals((await overUds({})).length, 4);
  assertEquals(
    await overUds({ wire: { omitTrailingUndefined: true } }),
    [
      ["u:a", ["x"]],
      ["u:b", [1]],
      ["u:c", [null, "mid"]],
      ["u:d", ["y"]],
    ],
  );
});

// ── against the frames every RELEASED server sends ─────────────────────────
//
// On connect a 1.0.19 server writes `proto`, the state, `boot`, and then
// `cfg` — last, and only when it has something to say. That order is wire: a
// released client reads it, so it is pinned here against the literal
// sequence, and the client's wait is proven against servers shaped exactly
// like it (a `cfg` with no `wire`, and no `cfg` at all).

const until = async (ok: () => boolean, what: string) => {
  for (let i = 0; i < 2000 && !ok(); i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  assert(ok(), `never happened: ${what}`);
};

Deno.test("wire: a server's first frames on connect are 1.0.19's, in 1.0.19's order", async () => {
  const c = cell("wcli-order", { state: { n: 0 }, methods: {} });
  for (
    const extra of [{}, { wire: { omitTrailingUndefined: true } }] as const
  ) {
    await using srv = await testServer({
      cells: [c],
      appId: "wire-order-probe",
      ...extra,
    });
    const kinds: string[] = [];
    let cfg: Record<string, unknown> | undefined;
    const ws = new WebSocket(srv.url.replace(/^http/, "ws") + "/ws");
    ws.onmessage = (e) => {
      const f = dec(String(e.data));
      if (!f) return;
      kinds.push(f.t);
      if (f.t === "cfg") cfg = f.d as Record<string, unknown>;
    };
    try {
      await until(() => kinds.includes("cfg"), "a cfg frame");
      // `tt-state` is the dev panel's (this harness runs dev); a production
      // server sends the other four.
      assertEquals(kinds, ["proto", "state", "tt-state", "boot", "cfg"]);
      // `wire` is in it only when the app asked: otherwise the frame is the
      // one 1.0.19 sent.
      assertEquals("wire" in cfg!, "wire" in extra);
    } finally {
      const gone = new Promise((r) => ws.onclose = r);
      ws.close();
      await gone;
    }
  }
});

/** A server that sends what a 1.0.19 server sends on connect — `cfg` as
 *  given, or none — acks every action, and answers `resync` with the state
 *  unless `onResync` says otherwise. */
function server1019(
  cfg: Record<string, unknown> | null,
  onResync?: (socket: WebSocket) => void,
  /** What a server since 1.0.20 adds to its hello (`ProtoHello.cfg`). */
  hello: { cfg?: boolean } = {},
  /** A frame of someone else's broadcast, landing between `boot` and `cfg`. */
  beforeCfg?: string,
) {
  const port = freePort();
  const got: string[] = [];
  const state = JSON.stringify({ wcli: { n: 0 } });
  let closes = 0;
  const srv = Deno.serve({ port, onListen: () => {} }, (req) => {
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("no", { status: 404 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () => {
      socket.send(enc("proto", { ...protoHello(VERSION), ...hello }));
      socket.send(`{"v":2,"t":"state","d":${state}}`);
      socket.send(enc("boot", { id: "b" }));
      if (beforeCfg) socket.send(beforeCfg);
      if (cfg) socket.send(enc("cfg", cfg));
    };
    socket.onclose = () => void closes++;
    socket.onmessage = (e) => {
      const f = dec(String(e.data));
      if (f?.t === "resync") {
        got.push("resync");
        if (onResync) return onResync(socket);
        socket.send(`{"v":2,"t":"state","d":${state}}`);
      } else if (f?.t === "action") {
        const a = f.d as { type: string; cid?: string; payload: unknown };
        got.push(`${a.type} ${JSON.stringify(a.payload)}`);
        if (a.cid) socket.send(enc("ack", { cid: a.cid, ok: true }));
      }
    };
    return response;
  });
  return {
    url: `http://localhost:${port}`,
    got,
    closes: () => closes,
    stop: () => srv.shutdown(),
  };
}

const CALLS = [
  'wcli:seen {"args":["x",null]}',
  'wcli:seen {"args":["plain"]}',
  'wcli:seen {"args":["y",null]}',
];

for (
  const [name, cfg, frames] of [
    // The answer is the `cfg` frame. A call was already waiting when `boot`
    // was read, so the client had asked; the reply changes nothing.
    ["a cfg frame with no `wire` in it", { appId: "old" }, [
      "resync",
      ...CALLS,
    ]],
    // No answer is coming, and a quiet server sends nothing after `boot`:
    // the reply to the client's own ask is the frame that proves it.
    ["no cfg frame at all, and nothing after boot", null, [
      "resync",
      ...CALLS,
    ]],
  ] as const
) {
  Deno.test(`wire option (CLI client): a 1.0.19 server — ${name} — the wait ends and the calls are the ones 1.0.19 got`, async () => {
    const srv = server1019(cfg);
    const def = cell(`wcli`, {
      state: { n: 0 },
      methods: { seen(_s: { n: number }, ..._rest: unknown[]) {} },
    });
    const cli = connectCli<{ wcli: { n: number } }>(srv.url);
    try {
      cli.bind(def as unknown as CellDef);
      const m = def as unknown as Calls;
      const early = [m.seen!("x", undefined), m.seen!("plain")];
      await cli.ready;
      await within(
        Promise.all([...early, m.seen!("y", undefined)]),
        "the acks of calls that wait for the server's answer about `wire` " +
          `(the server has received: ${JSON.stringify(srv.got)})`,
      );
      assertEquals(srv.got, [...frames]);
    } finally {
      cli.close();
      await srv.stop();
    }
  });
}

// ── a server that says in its hello whether a `cfg` follows (1.0.20) ───────
//
// The wait above proves a negative with a `resync`, whose reply is a whole
// state. A server that says so up front costs neither the wait nor the ask.
for (
  const [name, cfg, hello, beforeCfg, frames] of [
    [
      "none follows: nothing waits, nothing is asked",
      null,
      {
        cfg: false,
      },
      undefined,
      CALLS,
    ],
    [
      "one follows: the wait is for it alone",
      {
        wire: { omitTrailingUndefined: true },
      },
      { cfg: true },
      undefined,
      [
        'wcli:seen {"args":["x"]}',
        'wcli:seen {"args":["plain"]}',
        'wcli:seen {"args":["y"]}',
      ],
    ],
    // Before the hello said so, the first frame after `boot` that was not
    // `cfg` read as "none is coming" and the calls left unencoded.
    [
      "one follows, behind another client's broadcast",
      {
        wire: { omitTrailingUndefined: true },
      },
      { cfg: true },
      '{"v":2,"t":"state","d":{"wcli":{"n":0}}}',
      [
        'wcli:seen {"args":["x"]}',
        'wcli:seen {"args":["plain"]}',
        'wcli:seen {"args":["y"]}',
      ],
    ],
  ] as const
) {
  Deno.test(`wire option (CLI client): the hello says whether a cfg follows — ${name}`, async () => {
    const srv = server1019(cfg, undefined, hello, beforeCfg);
    const def = cell(`wcli`, {
      state: { n: 0 },
      methods: { seen(_s: { n: number }, ..._rest: unknown[]) {} },
    });
    const cli = connectCli<{ wcli: { n: number } }>(srv.url);
    try {
      cli.bind(def as unknown as CellDef);
      const m = def as unknown as Calls;
      const early = [m.seen!("x", undefined), m.seen!("plain")];
      await cli.ready;
      await within(
        Promise.all([...early, m.seen!("y", undefined)]),
        `the acks (the server has received: ${JSON.stringify(srv.got)})`,
      );
      assertEquals(srv.got, [...frames]);
    } finally {
      cli.close();
      await srv.stop();
    }
  });
}

Deno.test("wire: a server's hello says whether its cfg frame follows", async () => {
  const c = cell("wcli-hello", { state: { n: 0 }, methods: {} });
  await using srv = await testServer({ cells: [c], appId: "wire-hello-probe" });
  const seen: Array<[string, unknown]> = [];
  const ws = new WebSocket(srv.url.replace(/^http/, "ws") + "/ws");
  ws.onmessage = (e) => {
    const f = dec(String(e.data));
    if (f) seen.push([f.t, f.d]);
  };
  try {
    await until(() => seen.some(([t]) => t === "boot"), "the boot frame");
    await until(() => seen.some(([t]) => t === "cfg"), "a cfg frame");
    assertEquals(seen[0]![0], "proto");
    assertEquals((seen[0]![1] as { cfg?: unknown }).cfg, true);
    assertEquals(parseProtoHello(seen[0]![1])?.cfg, true);
    assertEquals(parseProtoHello({ v: 3, min: 3, cfg: false })?.cfg, false);
    // Not a boolean: not an answer.
    assertEquals("cfg" in parseProtoHello({ v: 3, min: 3, cfg: 1 })!, false);
  } finally {
    const gone = new Promise((r) => ws.onclose = r);
    ws.close();
    await gone;
  }
});

Deno.test("wire option (CLI client): nothing waits — and nothing is asked — for calls the option cannot change", async () => {
  const srv = server1019(null);
  const def = cell(`wcli`, {
    state: { n: 0 },
    methods: { seen(_s: { n: number }, ..._rest: unknown[]) {} },
  });
  const cli = connectCli<{ wcli: { n: number } }>(srv.url);
  try {
    cli.bind(def as unknown as CellDef);
    const m = def as unknown as Calls;
    const early = [m.seen!("a"), m.seen!(undefined, "mid")];
    await cli.ready;
    await within(
      Promise.all([...early, m.seen!("b")]),
      "the acks of calls that have nothing to wait for",
    );
    assertEquals(srv.got, [
      'wcli:seen {"args":["a"]}',
      'wcli:seen {"args":[null,"mid"]}',
      'wcli:seen {"args":["b"]}',
    ]);
  } finally {
    cli.close();
    await srv.stop();
  }
});

Deno.test("wire option (CLI client): a socket that closes while a call waits leaves it to the offline path — it never hangs", async () => {
  // No cfg, and the ask is answered by hanging up.
  const srv = server1019(null, (socket) => socket.close());
  const def = cell(`wcli`, {
    state: { n: 0 },
    methods: { seen(_s: { n: number }, ..._rest: unknown[]) {} },
  });
  const cli = connectCli<{ wcli: { n: number } }>(srv.url);
  try {
    cli.bind(def as unknown as CellDef);
    const call = (def as unknown as Calls).seen!("x", undefined);
    call.catch(() => {});
    await until(() => srv.closes() > 0, "the server hung up");
    assertEquals(srv.got, ["resync"], "the call left before the answer");
    // Still queued, like any call made while offline: `close()` answers it.
    cli.close();
    const err = await assertRejects(
      () => within(call, "close() to answer the call that was waiting"),
      Error,
    );
    assert(!err.message.includes("still waiting"), err.message);
  } finally {
    cli.close();
    await srv.stop();
  }
});

// ── the answer is per CONNECTION ───────────────────────────────────────────
//
// A server that restarts without the option sends no `cfg` (1.0.19 and
// before: nothing in its hello either). The client used to keep the last
// connection's answer: `f(x, undefined)` reached a server that never asked
// for it as `f(x)` — a parameter with a default took the default, where every
// other client of that server sends `null`.
Deno.test("wire option (CLI client): a server that restarts WITHOUT the option gets the calls it always got", async () => {
  const port = freePort();
  const got: string[] = [];
  let omit = true;
  let live: WebSocket | null = null;
  const srv = Deno.serve({ port, onListen: () => {} }, (req) => {
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("no", { status: 404 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () => {
      live = socket;
      socket.send(enc("proto", protoHello(VERSION)));
      socket.send('{"v":2,"t":"state","d":{"wcli":{"n":0}}}');
      socket.send(enc("boot", { id: "b" }));
      if (omit) {
        socket.send(enc("cfg", { wire: { omitTrailingUndefined: true } }));
      }
    };
    socket.onmessage = (e) => {
      const f = dec(String(e.data));
      if (f?.t === "resync") {
        socket.send('{"v":2,"t":"state","d":{"wcli":{"n":0}}}');
      } else if (f?.t === "action") {
        const a = f.d as { type: string; cid?: string; payload: unknown };
        got.push(`${a.type} ${JSON.stringify(a.payload)}`);
        if (a.cid) socket.send(enc("ack", { cid: a.cid, ok: true }));
      }
    };
    return response;
  });
  const def = cell(`wcli`, {
    state: { n: 0 },
    methods: { seen(_s: { n: number }, ..._rest: unknown[]) {} },
  });
  const cli = connectCli<{ wcli: { n: number } }>(`http://localhost:${port}`);
  try {
    cli.bind(def as unknown as CellDef);
    const m = def as unknown as Calls;
    await cli.ready;
    await within(m.seen!("x", undefined), "the first call's ack");
    const first = live as WebSocket | null;
    omit = false;
    first!.close();
    await until(() => live !== first, "the client reconnecting");
    await within(m.seen!("y", undefined), "the ack after the restart");
    assertEquals(got, [
      'wcli:seen {"args":["x"]}',
      'wcli:seen {"args":["y",null]}',
    ]);
  } finally {
    cli.close();
    await srv.shutdown();
  }
});

Deno.test("wire option (CLI client, local socket): a listener that restarts WITHOUT the option gets the calls it always got", async () => {
  const dir = await tempDir("aio-wire-cli-uds-again-");
  const socketPath = localEndpoint(join(dir, "w.sock"));
  const got: unknown[] = [];
  const listen = (clientConfig: Record<string, unknown>) =>
    createUDSListener(
      socketPath,
      () => ({ n: 0 }),
      (a) => void got.push((a.payload as { args: unknown[] }).args),
      () => {},
      undefined,
      undefined,
      clientConfig,
    );
  let uds = listen({ wire: { omitTrailingUndefined: true } });
  const cli = connectCliUDS<{ n: number }>(socketPath);
  try {
    await cli.ready;
    cli.send({ type: "u:a", payload: { args: ["x", undefined] } });
    await until(() => got.length === 1, "the first call");
    uds.shutdown();
    await localIdle();
    await until(() => !cli.connected, "the client seeing the listener go");
    uds = listen({});
    await until(() => uds.clients().length > 0, "the client reconnecting");
    cli.send({ type: "u:b", payload: { args: ["y", undefined] } });
    await until(() => got.length === 2, "the call after the restart");
    assertEquals(got, [["x"], ["y", null]]);
  } finally {
    cli.close();
    uds.shutdown();
    await localIdle();
    await dropTempDir(dir);
  }
});

// `aio.run({ wire })` is decided on the server and USED by the client, which
// encodes the call. So it has three surfaces to reach — the page shell, the
// WebSocket `cfg` frame, the UDS `cfg` frame — and a key present in two of
// three is the bug class this file is for: a served page that omits a
// trailing `undefined` and a packaged window that sends `null` for it.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";
import { dec } from "../src/protocol/envelope.ts";
import { _applyServerConfig } from "../src/browser/browser-protocol.ts";
import {
  omitsTrailingUndefined,
  serializeArgs,
  wireArgs,
  wirePayload,
} from "../src/protocol/wire-value.ts";
import { encodeAction, wireAction } from "../src/state/action-encode.ts";
import { generateHTML } from "../src/server/server-html-gen.ts";
import { createUDSListener } from "../src/server/aio.ts";
import { connectLocal } from "../src/server/local-listen.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { join } from "@std/path";
import { localEndpoint, localIdle } from "./local-endpoint-helper.ts";

const WIRE = { omitTrailingUndefined: true };
type G = { __aioConfig?: Record<string, unknown> };

Deno.test("wire option: reaches the page shell AND the cfg frame — and is absent from both when unset", async () => {
  for (const wire of [WIRE, undefined]) {
    const c = cell("wireopt-cell", { state: { n: 0 }, methods: {} });
    await using srv = await testServer({ cells: [c], appId: "wireopt", wire });
    const html = await (await srv.fetch("/")).text();
    const m = /window\.__aioConfig=(\{.*?\})<\/script>/.exec(html);
    assert(m, `no injected config in the shell:\n${html.slice(0, 400)}`);
    assertEquals(JSON.parse(m[1]!).wire, wire, "the shell");

    const ws = new WebSocket(srv.url.replace("http", "ws") + "/ws");
    const cfg = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        ws.onmessage = (e) => {
          const f = dec(String(e.data));
          if (f?.t === "cfg") resolve(f.d as Record<string, unknown>);
        };
        ws.onerror = (e) => reject(e);
        ws.onclose = () => reject(new Error("closed before a cfg frame"));
      },
    );
    ws.onclose = null;
    const closed = new Promise((r) => ws.addEventListener("close", r));
    ws.close();
    await closed;
    assertEquals(cfg.wire, wire, "the cfg frame");
  }
});

Deno.test("wire option: the UDS listener's cfg frame carries it — decoded off a real socket", async () => {
  const dir = await tempDir("aio-wire-uds-");
  const socketPath = localEndpoint(join(dir, "wire.sock"));
  const listen = (clientConfig: Record<string, unknown>) =>
    createUDSListener(
      socketPath,
      () => ({ n: 0 }),
      () => {},
      () => {},
      undefined,
      undefined,
      clientConfig,
    );
  /** The `cfg` frame a new connection is sent, or null when the first state
   *  arrives without one. */
  const cfgFrame = async (): Promise<unknown> => {
    let conn: Awaited<ReturnType<typeof connectLocal>> | undefined;
    for (let i = 0; i < 200 && !conn; i++) {
      try {
        conn = await connectLocal(socketPath);
      } catch {
        await new Promise((r) => setTimeout(r, 10)); // not listening yet
      }
    }
    assert(conn, "the listener never accepted");
    const reader = conn.readable.getReader();
    let text = "";
    try {
      for (;;) {
        const lines = text.split("\n").slice(0, -1).map((l) => dec(l));
        const cfg = lines.find((f) => f?.t === "cfg");
        if (cfg) return cfg.d;
        if (lines.some((f) => f?.t === "state")) return null;
        const { value, done } = await reader.read();
        assert(!done, `closed before a cfg or state frame: ${text}`);
        text += new TextDecoder().decode(value);
      }
    } finally {
      reader.releaseLock();
      conn.close();
    }
  };
  try {
    const on = listen({ wire: WIRE, callTimeouts: { default: 1 } });
    assertEquals(
      (await cfgFrame() as { wire?: unknown }).wire,
      WIRE,
    );
    on.shutdown();
    await localIdle();
    const off = listen({ callTimeouts: { default: 1 } });
    assertEquals("wire" in (await cfgFrame() as object), false);
    off.shutdown();
    await localIdle();
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("wire option: aio-server hands `wire` to that listener (a source check — this path boots only with an Electron window)", async () => {
  // The UDS frame's object is a literal in aio-server.ts beside the
  // WebSocket's in server.ts: two lists of the same keys, kept by hand.
  const uds = await Deno.readTextFile("src/server/aio-server.ts");
  const at = uds.indexOf("uds = createUDSListener(");
  assert(at > 0);
  assert(
    uds.slice(at, at + 900).includes("config.wire ? { wire: config.wire }"),
    "createUDSListener's client config no longer carries `wire` — a packaged " +
      "desktop window would encode calls the default way",
  );
});

Deno.test("wire option: a shell without it learns it from the frame; every door then reads the one decision", () => {
  const g = globalThis as G;
  const had = g.__aioConfig;
  try {
    delete g.__aioConfig;
    assertEquals(omitsTrailingUndefined(), false);
    const action = { type: "t:add", payload: { args: ["a", undefined] } };
    assertEquals(wireAction(action), action, "off: the same object");
    const off = encodeAction(action);
    assert(off.includes('["a",null]'), off);

    _applyServerConfig({ wire: WIRE }); // the packaged window's only source
    assertEquals(omitsTrailingUndefined(), true);
    // The action frame, the queue's object, the CRDT payload, serverFn args.
    assert(encodeAction(action).includes('"args":["a"]'));
    assertEquals(wireAction(action).payload, { args: ["a"] });
    assertEquals(wirePayload({ args: [1, undefined], k: 1 }), {
      args: [1],
      k: 1,
    });
    const sent = serializeArgs(["a", undefined, undefined], "fn");
    assertEquals(sent.args, ["a"]);
    assertEquals(sent.lossy, [], "not sent is not changed");
    // Not trailing: still null, still named.
    const mid = serializeArgs([undefined, "a"], "fn");
    assertEquals(mid.args, [null, "a"]);
    assertEquals(mid.lossy.map((l) => l.path), ["args[0]"]);
  } finally {
    if (had === undefined) delete g.__aioConfig;
    else g.__aioConfig = had;
  }
});

Deno.test("wire option: wireArgs is pure — same array back when nothing is dropped, the input never touched", () => {
  const same = ["a", null];
  assertEquals(wireArgs(same, true) === same, true);
  assertEquals(wireArgs(same, false) === same, true);
  const args = Object.freeze(["a", undefined, null, undefined, undefined]);
  assertEquals(wireArgs(args, true), ["a", undefined, null]);
  assertEquals(wireArgs(args, false) === args, true);
  assertEquals(wireArgs([undefined, undefined], true), []);
  assertEquals(wireArgs([], true), []);
  // A payload that is not a method call's is left alone.
  for (const p of [undefined, null, 3, "s", { args: "no" }, { x: 1 }]) {
    assertEquals(wirePayload(p, true), p);
  }
});

Deno.test("wire option: generateHTML writes nothing for it when the app did not ask", () => {
  const html = (wire?: typeof WIRE) =>
    generateHTML({
      title: "t",
      prod: true,
      hasCSS: false,
      importMap: "",
      appId: "x",
      wire,
      // deno-lint-ignore no-explicit-any
    } as any);
  assert(!html().includes('"wire"'));
  assert(html(WIRE).includes('"wire":{"omitTrailingUndefined":true}'));
});

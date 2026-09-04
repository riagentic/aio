// The framework's OWN client must not be reported as an attacker.
//
// `bindCellReactive` tags every ASYNC method dispatch with `payload._callId`
// (beside the envelope `cid`), and `dispatchNetwork` re-mints that id
// server-side on every door, so the client's value never has an effect.
// `sanitizeClientAction` nevertheless listed it among the FORGED trusted
// fields and warned — once per `await cell.method()`, on WS and on UDS alike.
// Measured on amui: its UI calls the async `manager:discover` every 9 s, so the
// server log carried
//
//   WARN ws client sent trusted field(s) payload._callId on 'manager:discover'
//        — stripped (a network value is never legitimate here)
//
// every 9 s, forever. A warning that fires on correct use trains people to
// skim warnings, which is how the one that matters gets missed. The field is
// still stripped (nothing downstream may ever read it as trusted); only the
// accusation goes. The fields that WOULD change what the server does —
// `_user`, `_source`, `_syncOp`, `_inflight`, `payload._origin` — stay loud.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { dec, enc } from "../src/protocol/envelope.ts";
import { freePort } from "../src/testing/server-test.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import { sanitizeClientAction } from "../src/server/server-ws.ts";
import { createUDSListener } from "../src/server/uds.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

type Ack = { cid: string; ok: boolean; error?: string; value?: unknown };
const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));

/** Capture every WARN+ line while `fn` runs, on top of whatever sink is
 *  active (aio.run installs its own, so this wraps rather than replaces). */
function captureWarns(): { warns: string[]; restore: () => void } {
  const prev = getLogger();
  const warns: string[] = [];
  setLogger({
    ...(prev ?? {}),
    pub: (lvl: string, cat: string, msg: string, data?: unknown) => {
      if (lvl === "warn" || lvl === "error") warns.push(`${cat}: ${msg}`);
      // deno-lint-ignore no-explicit-any
      (prev as any)?.pub?.(lvl, cat, msg, data);
    },
    // deno-lint-ignore no-explicit-any
  } as any);
  return { warns, restore: () => setLogger(prev) };
}

Deno.test("sanitize: `payload._callId` is stripped WITHOUT a warning", () => {
  const { warns, restore } = captureWarns();
  try {
    const action: Record<string, unknown> = {
      type: "bare:ok",
      cid: "c1",
      _source: "UI",
      payload: { _callId: "c1", keep: 1 },
    };
    sanitizeClientAction(action, "ws");
    assertEquals(action.payload, { keep: 1 }, "still stripped");
    assertEquals(action._source, "UI");
    assertEquals(
      warns,
      [],
      `an honest async call from aio's own client must not warn:\n${
        warns.join("\n")
      }`,
    );
  } finally {
    restore();
  }
});

Deno.test("sanitize: a REAL trusted field still warns, by name", () => {
  const { warns, restore } = captureWarns();
  try {
    for (const via of ["ws", "uds", "trojan"] as const) {
      warns.length = 0;
      const action: Record<string, unknown> = {
        type: "bare:ok",
        _user: { id: "root", role: "admin" },
        payload: { _callId: "x", _origin: "read" },
      };
      sanitizeClientAction(action, via);
      assertEquals(action._user, undefined);
      assertEquals(action.payload, {});
      assertEquals(warns.length, 1, `${via}: ${warns.join("\n")}`);
      assert(warns[0]!.includes("_user"), warns[0]);
      assert(warns[0]!.includes("payload._origin"), warns[0]);
      assert(
        !warns[0]!.includes("_callId"),
        `the expected field must not be listed among the forged ones: ${
          warns[0]
        }`,
      );
    }
  } finally {
    restore();
  }
});

Deno.test("ws: an async call tagged the way aio's client tags it is quiet AND answered", async () => {
  const { aio, cell } = await import("../mod.ts");
  const probe = cell("quiet", {
    state: { n: 0 },
    visible: "all",
    methods: {
      async ok(s: { n: number }) {
        await Promise.resolve();
        s.n += 1;
        return 42;
      },
    },
  });
  const port = freePort();
  const app = await aio.run({
    cells: [probe],
    appId: "test-sanitize-quiet",
    client: "server-only",
    persist: false,
    libraryMode: true,
    port,
    baseDir: await tempDir("aio-sanitize-own-client-quiet-"),
  });
  const acks: Ack[] = [];
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const t = setTimeout(() => reject(new Error("ws timeout")), 5000);
    s.onmessage = (e) => {
      const f = dec(String(e.data));
      if (f?.t === "ack") acks.push(f.d as Ack);
      clearTimeout(t);
      resolve(s);
    };
    s.onerror = () => {
      clearTimeout(t);
      reject(new Error("ws error"));
    };
  });
  // Installed AFTER boot — aio.run wires its own sink, and this wraps it.
  const { warns, restore } = captureWarns();
  try {
    // EXACTLY what bindCellReactive sends for an async method: the envelope
    // cid, `_source:"UI"`, and the same id repeated as `payload._callId`.
    ws.send(
      enc("action", {
        type: "quiet:ok",
        cid: "a1",
        _source: "UI",
        payload: { _callId: "a1" },
      }),
    );
    await settle();
    const ack = acks.find((a) => a.cid === "a1");
    assertEquals(ack?.ok, true, JSON.stringify(ack));
    assertEquals(ack?.value, 42, "the return value must still cross");
    const accused = warns.filter((w) => /trusted field/.test(w));
    assertEquals(
      accused,
      [],
      `the framework's own client was reported as an attacker:\n${
        accused.join("\n")
      }`,
    );
  } finally {
    restore();
    ws.close();
    await app.close();
  }
});

Deno.test("uds: the same call is quiet AND answered on the desktop transport", async () => {
  const socketPath = join(
    await tempDir("aio-sanitize-own-client-quiet-"),
    "sanitize-quiet.sock",
  );
  const seen: Record<string, unknown>[] = [];
  const uds = createUDSListener(
    socketPath,
    () => ({ quiet: { n: 0 } }),
    (action) => {
      seen.push(action as Record<string, unknown>);
      return Promise.resolve(42);
    },
    () => {},
  );
  await settle(50);
  const conn = await Deno.connect({ path: socketPath, transport: "unix" });
  const lines: string[] = [];
  const reader = conn.readable.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split("\n");
        buf = parts.pop()!;
        for (const p of parts) if (p) lines.push(p);
      }
    } catch { /* closed */ }
  })();
  const { warns, restore } = captureWarns();
  try {
    const w = conn.writable.getWriter();
    await w.write(
      new TextEncoder().encode(
        enc("action", {
          type: "quiet:ok",
          cid: "u1",
          _source: "UI",
          payload: { _callId: "u1" },
        }) + "\n",
      ),
    );
    w.releaseLock();
    await settle();
    assertEquals(seen.length, 1);
    assertEquals(
      (seen[0]!.payload as Record<string, unknown>)._callId,
      undefined,
      "still stripped before dispatch",
    );
    const ack = lines.map((l) => dec(l)).find((f) => f?.t === "ack")
      ?.d as Ack | undefined;
    assertEquals(ack?.ok, true, JSON.stringify(ack));
    assertEquals(ack?.value, 42);
    const accused = warns.filter((w) => /trusted field/.test(w));
    assertEquals(accused, [], accused.join("\n"));
  } finally {
    restore();
    conn.close();
    await settle(30);
    uds.shutdown();
  }
});

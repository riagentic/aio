// Time travel over the local socket answers to the WS bar once a peer has
// PROVEN who it is: a proven non-admin gets no history (`tt-state`, at its
// first frame or on broadcast) and its `tt-cmd` runs nothing; an admin and the
// anonymous trusted window keep both.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createUDSListener } from "../src/server/aio.ts";
import { enc } from "../src/protocol/envelope.ts";
import { connectLocal } from "../src/server/local-listen.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { localEndpoint, localIdle } from "./local-endpoint-helper.ts";
import { interceptConsole } from "./console-capture.ts";

Deno.test("uds time travel: proven non-admin refused, admin + anonymous window served", async () => {
  const dir = await tempDir("aio-uds-tt-");
  const cmds: string[] = [];
  const said: string[] = [];
  const restore = interceptConsole(said);
  const uds = createUDSListener(
    localEndpoint(join(dir, "tt.sock")),
    () => ({ c: { n: 1 } }),
    () => {},
    () => {},
    undefined,
    undefined,
    undefined,
    { onCommand: (c) => void cmds.push(c), getBroadcast: () => ({ h: [] }) },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (proof) =>
      Promise.resolve({
        ok: true,
        user: { id: proof, role: proof === "alice" ? "admin" : "user" },
      }),
  );
  const te = new TextEncoder();
  const open = async (first: string) => {
    const conn = await connectLocal(uds.socketPath);
    const w = conn.writable.getWriter();
    const r = conn.readable.getReader();
    let got = "";
    void (async () => {
      const td = new TextDecoder();
      for (;;) {
        const { value, done } = await r.read().catch(() => ({
          value: undefined,
          done: true,
        }));
        if (done) return;
        got += td.decode(value);
      }
    })();
    await w.write(te.encode(first + "\n"));
    return {
      w,
      conn,
      got: () => got,
      send: (f: string) => w.write(te.encode(f + "\n")),
    };
  };
  const hello = (who: string) =>
    enc("type", { kind: "peer", proof: who, cid: `h-${who}` });
  const until = async (p: () => boolean) => {
    for (let i = 0; i < 200 && !p(); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  try {
    const bob = await open(hello("bob"));
    const alice = await open(hello("alice"));
    const win = await open(enc("ping"));
    await until(() =>
      alice.got().includes('"t":"tt-state"') &&
      win.got().includes('"t":"tt-state"') &&
      bob.got().includes('"cid":"h-bob","ok":true')
    );
    assert(alice.got().includes('"t":"tt-state"'), "admin gets the history");
    assert(win.got().includes('"t":"tt-state"'), "the window gets it");
    uds.broadcast(enc("tt-state", { h: ["later"] }));
    await bob.send(enc("tt-cmd", "undo"));
    await alice.send(enc("tt-cmd", "pause"));
    await until(() => cmds.length >= 1 && alice.got().includes("later"));
    await new Promise((r) => setTimeout(r, 50));
    assert(win.got().includes("later"));
    assertEquals(
      bob.got().includes('"t":"tt-state"'),
      false,
      `a proven non-admin read the history: ${bob.got()}`,
    );
    assertEquals(cmds, ["pause"], "only the admin's command ran");
    assert(said.some((l) => l.includes("time-travel command denied")));
    for (const c of [bob, alice, win]) c.conn.close();
  } finally {
    restore();
    uds.shutdown();
    await localIdle();
    await dropTempDir(dir);
  }
});

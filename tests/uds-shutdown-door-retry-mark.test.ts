// The UDS twin of tests/shutdown-door-retry-mark.test.ts. A call refused AT
// THE DOOR while the server shuts down never ran, and its ack carries
// `retryAfterMs` — the cue `cli-client.ts` (`_retryRefusedCall`) and the
// browser transport both read to hold the call and re-send it after the
// restart. The UDS door dropped that field: its error ack spread only
// `errorFields(err)`, so on a desktop app (the socket is its only wire) a call
// made during a restart FAILED where the same call over WS was held and landed.
import { assert, assertEquals } from "@std/assert";
import { dec, enc } from "../src/protocol/envelope.ts";
import { connectLocal } from "../src/server/local-listen.ts";
import { resolveSocketPath } from "../src/server/paths.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { unrunnableElectron } from "./unrunnable-electron.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

Deno.test("uds shutdown: a door refusal says re-send (retryAfterMs), a refusal inside a running method does not", async () => {
  const dir = await tempDir("aio-uds-door-retry-");
  // A local electron app speaks UDS. No display → no window is launched (the
  // server still comes up on its socket); elsewhere the launch stops at an
  // unrunnable binary (tests/unrunnable-electron.ts).
  const saved = ["DISPLAY", "WAYLAND_DISPLAY", "ELECTRON_PATH"].map(
    (k) => [k, Deno.env.get(k)] as const,
  );
  Deno.env.delete("DISPLAY");
  Deno.env.delete("WAYLAND_DISPLAY");
  Deno.env.set("ELECTRON_PATH", await unrunnableElectron(dir));
  await Deno.writeTextFile(
    `${dir}/App.tsx`,
    "export default function App() { return <div>Hi</div>; }\n",
  );
  const { aio, cell } = await import("../mod.ts");
  let release!: () => void;
  const gate = new Promise<void>((r) => release = r);
  const other = cell("udrOther", {
    state: { n: 0 },
    methods: {
      inc(s: Any) {
        s.n++;
      },
      // A method's OWN error with a `retryAfterMs` field: it ran and wrote,
      // so its ack must not ask for a re-send (a client applied it 9×).
      async rated(s: Any) {
        s.n++;
        await 0;
        throw Object.assign(new Error("rate limited"), { retryAfterMs: 50 });
      },
    },
  } as Any) as Any;
  const main = cell("udrMain", {
    state: { n: 0 },
    methods: {
      async slow(s: Any) {
        await gate;
        s.n++;
        await other.inc();
      },
      inc(s: Any) {
        s.n++;
      },
    },
  } as Any) as Any;
  const appId = `uds-door-retry-${Deno.pid}`;
  const app = await aio.run({
    watch: false,
    cells: [main, other],
    appId,
    appDir: dir,
    baseDir: dir,
    client: "electron",
    libraryMode: true,
    singleton: false,
    persist: false,
  } as Any);
  const acks = new Map<string, Record<string, unknown>>();
  const conn = await connectLocal(resolveSocketPath(appId));
  const writer = conn.writable.getWriter();
  const reading = (async () => {
    const reader = conn.readable.getReader();
    const td = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += td.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const f = dec(buf.slice(0, i));
          buf = buf.slice(i + 1);
          if (f?.t === "ack") {
            const d = f.d as Record<string, unknown>;
            acks.set(String(d.cid), d);
          }
        }
      }
    } catch { /* closed */ }
  })();
  let closing: Promise<unknown> | undefined;
  try {
    const send = (type: string, cid: string) =>
      writer.write(
        new TextEncoder().encode(
          enc("action", { type, payload: { args: [] }, cid }) + "\n",
        ),
      );
    const until = async (ok: () => boolean, what: string) => {
      const end = Date.now() + 10_000;
      while (!ok()) {
        assert(Date.now() < end, `timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 10));
      }
    };

    await send("udrMain:slow", "inside");
    await new Promise((r) => setTimeout(r, 100));
    await send("udrOther:rated", "rated");
    await until(() => acks.has("rated"), "the method's own error");
    assertEquals(acks.get("rated")!.ok, false);
    assertEquals(
      acks.get("rated")!.retryAfterMs,
      undefined,
      "a method's own retryAfterMs is not the door's word that it never ran",
    );

    closing = (app as Any).close();
    await new Promise((r) => setTimeout(r, 50));

    await send("udrMain:inc", "door");
    await until(() => acks.has("door"), "the door refusal");
    const door = acks.get("door")!;
    assertEquals(door.ok, false);
    assertEquals(door.code, "DISPATCH_DRAINING");
    assertEquals(typeof door.retryAfterMs, "number", JSON.stringify(door));

    release();
    await until(() => acks.has("inside"), "the in-method refusal");
    const inside = acks.get("inside")!;
    assertEquals(inside.ok, false, JSON.stringify(inside));
    assertEquals(
      inside.retryAfterMs,
      undefined,
      "a refusal raised inside a running method must not ask for a re-send",
    );
  } finally {
    release();
    try {
      conn.close();
    } catch { /* closed */ }
    await reading;
    await (closing ?? (app as Any).close());
    for (const [k, v] of saved) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    await dropTempDir(dir);
  }
});

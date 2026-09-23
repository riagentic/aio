// A stand-in for the Electron MAIN process of a UDS-only app, for the
// window-owned pickFile (#10) — launched by the app as `$ELECTRON_PATH`
// through a shell wrapper the test writes.
//
// It does what the generated main.cjs does on the wire and nothing else:
// announce `caps: ["dialog"]` on connect, then (standing in for the renderer
// it would relay for) call the app's async method `c:pick`, answer the
// `dialog` frame the server sends back, and record what came through — the
// request it was asked to open and the method's acked return value — in
// `$AIO_DIALOG_STANDIN_OUT`. The test reads that file.
//
// The socket is found the way `am` finds it: through the lock record in the
// lock dir the app's `AIO_APPS_DIR` scopes — its `socketPath`, which is NOT
// in that dir when the path is too long and falls back to `/tmp/aio`.
import { lockDir, readLock } from "../../src/server/single-instance-lock.ts";
import { dec, enc } from "../../src/protocol/envelope.ts";
import { protoHello } from "../../src/protocol/protocol-version.ts";
import { VERSION } from "../../src/server/aio-cli.ts";
import { join } from "@std/path";

const OUT = Deno.env.get("AIO_DIALOG_STANDIN_OUT") ?? "";
if (!OUT) throw new Error("AIO_DIALOG_STANDIN_OUT is not set");

async function findSocket(): Promise<string> {
  const dir = lockDir();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      for (const e of Deno.readDirSync(dir)) {
        if (!e.name.endsWith(".lock")) continue;
        const sock = readLock(e.name.slice(0, -".lock".length))?.socketPath;
        if (sock) return sock;
      }
    } catch { /* not created yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no app socket appeared in ${dir}`);
}

const conn = await Deno.connect({
  transport: "unix",
  path: await findSocket(),
});
const send = (line: string) =>
  conn.write(new TextEncoder().encode(line + "\n")).then(() => {});
await send(enc("type", { kind: "electron", caps: ["dialog"] }));
await send(enc("proto", protoHello(VERSION)));
await send(enc("action", { type: "c:pick", cid: "k1" }));

const record: { asked?: unknown; ack?: unknown } = {};
const decoder = new TextDecoder();
const buf = new Uint8Array(1 << 16);
let pending = "";
outer: while (true) {
  const n = await conn.read(buf);
  if (n === null) break;
  pending += decoder.decode(buf.subarray(0, n), { stream: true });
  let nl: number;
  while ((nl = pending.indexOf("\n")) !== -1) {
    const line = pending.slice(0, nl);
    pending = pending.slice(nl + 1);
    const f = line ? dec(line) : null;
    if (!f) continue;
    if (f.t === "dialog") {
      const d = f.d as { id: string };
      record.asked = d;
      await send(enc("dialog-result", {
        id: d.id,
        canceled: false,
        paths: ["/picked/one.txt", "/picked/two words.txt"],
      }));
    } else if (f.t === "ack" && (f.d as { cid?: string }).cid === "k1") {
      record.ack = f.d;
      break outer;
    }
  }
}
await Deno.writeTextFile(OUT, JSON.stringify(record));
// Stay connected like a window would until the app goes away (the test stops
// it), then exit — never outlive it.
try {
  while ((await conn.read(buf)) !== null) { /* drain */ }
} catch { /* the app closed the socket */ }
Deno.exit(0);

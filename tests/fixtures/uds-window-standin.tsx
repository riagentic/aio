// A stand-in for the Electron WINDOW of a UDS-only app — launched by the app
// itself as `$ELECTRON_PATH` (through a tiny shell wrapper the test writes).
//
// Electron cannot run in CI, and its renderer is the one peer that speaks the
// app's socket as a UI client. This process is that peer without the browser:
// it mounts a component with the real AIR renderer (happy-dom, exactly as
// `testUI` does), connects to the app's NDJSON socket as a window, and answers
// `ui-surface` / `ui-trigger` with the SAME two functions the browser runtime
// routes them to (`browser-air-commands.ts`). What the test then proves is the
// path a packaged desktop app ships with: `am` → the socket → the trojan → a
// UI client over UDS → back.
//
// The socket is found the way `am` finds it — in the lock dir the app's
// `AIO_APPS_DIR` scopes — never from the Electron main-script argument, which
// is an implementation detail of the launcher.
import { lockDir } from "../../src/server/single-instance-lock.ts";
import { useLocal } from "../../src/air.ts";
import { testUI } from "../../src/testing/ui-test.ts";
import {
  getSerializedSurfaces,
  runUITrigger,
} from "../../src/air/ui-remote.ts";
import { dec, enc } from "../../src/protocol/envelope.ts";
import { protoHello } from "../../src/protocol/protocol-version.ts";
import { VERSION } from "../../src/server/aio-cli.ts";
import { join } from "@std/path";

function Counter() {
  const s = useLocal({ count: 0 });
  return (
    <div>
      <span class="count">{String(s.local.count)}</span>
      <div class="button" onClick={() => s.patch({ count: s.local.count + 1 })}>
        Inc
      </div>
    </div>
  );
}

async function findSocket(): Promise<string> {
  const dir = lockDir();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      for (const e of Deno.readDirSync(dir)) {
        if (e.name.endsWith(".sock") && !e.name.endsWith(".http.sock")) {
          return join(dir, e.name);
        }
      }
    } catch { /* not created yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no app socket appeared in ${dir}`);
}

// The HANDLE form: the three-argument `testUI(App, name, fn)` REGISTERS a
// `Deno.test`, which never runs under `deno run` — this process is a window,
// not a test file.
await using _ui = await testUI(Counter);
{
  const conn = await Deno.connect({
    transport: "unix",
    path: await findSocket(),
  });
  const send = (line: string) =>
    conn.write(new TextEncoder().encode(line + "\n")).catch(() => {});
  await send(enc("proto", protoHello(VERSION)));
  console.log("STANDIN CONNECTED");
  const decoder = new TextDecoder();
  const buf = new Uint8Array(1 << 16);
  let pending = "";
  while (true) {
    const n = await conn.read(buf);
    if (n === null) break;
    pending += decoder.decode(buf.subarray(0, n), { stream: true });
    let nl: number;
    while ((nl = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, nl);
      pending = pending.slice(nl + 1);
      const f = line ? dec(line) : null;
      if (!f) continue;
      if (f.t === "ui-surface") {
        const full = (f.d as { full?: boolean } | undefined)?.full === true;
        await send(enc("ui-surface-result", getSerializedSurfaces(full)));
      } else if (f.t === "ui-trigger") {
        const r = await runUITrigger(
          f.d as Parameters<typeof runUITrigger>[0],
        );
        await send(enc("ui-trigger-result", r));
      }
    }
  }
  console.log("STANDIN CLOSED");
}

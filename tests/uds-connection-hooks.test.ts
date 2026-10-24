// `onConnect` / `onDisconnect` run for a window on the local socket too —
// under `localConnectHooks: true`. By default they run for WS clients only,
// exactly as through 1.0.24 (whose docs said so: an app written for that
// must not start seeing extra connects).
//
// They ran on the WS path only. A desktop window speaks the app's Unix socket
// (a named pipe on Windows), so a presence app — `onConnect` →
// `presence.mark()` — counted every browser tab and never its own desktop
// window: the hook simply did not fire on the transport every shipped desktop
// client uses, and nothing said so.
//
// A control client (`am`, amui) is NOT a connection: it says `type: control`
// first, asks one question and leaves — the twin of its HTTP request on the
// WS path, which no hook sees either.
import { assertEquals } from "@std/assert";
import { connectLocal } from "../src/server/local-listen.ts";
import { udsRequest } from "../src/server/local-request.ts";
import { resolveSocketPath } from "../src/server/paths.ts";
import { enc } from "../src/protocol/envelope.ts";
import { protoHello } from "../src/protocol/protocol-version.ts";
import { VERSION } from "../src/server/aio-cli.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { unrunnableElectron } from "./unrunnable-electron.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

async function until(what: string, fn: () => boolean): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!fn()) {
    if (performance.now() > deadline) throw new Error(`never: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A local electron app on its socket, no window: no display, and an
 *  unrunnable binary elsewhere (tests/unrunnable-electron.ts). */
async function withApp(
  name: string,
  hooks: { onConnect: Any; onDisconnect: Any; localConnectHooks?: boolean },
  body: (socketPath: string) => Promise<void>,
): Promise<void> {
  const dir = await tempDir(`aio-uds-connection-hooks-${name}-`);
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
  const appId = `uds-conn-hooks-${name}-${Deno.pid}`;
  const app = await aio.run({
    ...hooks,
    cells: [cell(`uch_${name}`, { state: { n: 0 }, methods: {} })],
    appId,
    appDir: dir,
    baseDir: dir,
    client: "electron",
    libraryMode: true,
    singleton: false,
    persist: false,
    watch: false,
  } as Any);
  try {
    await body(resolveSocketPath(appId));
  } finally {
    await (app as Any).close();
    for (const [k, v] of saved) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    await dropTempDir(dir);
  }
}

/** Connect as a window would: say `lines` first, then read until a `state`
 *  frame arrives (the connection is served). */
async function window(socketPath: string, lines: string[]) {
  const conn = await connectLocal(socketPath);
  const w = conn.writable.getWriter();
  await w.write(new TextEncoder().encode(lines.map((l) => l + "\n").join("")));
  w.releaseLock();
  const reader = conn.readable.getReader();
  const td = new TextDecoder();
  let text = "";
  while (!text.includes('"t":"state"')) {
    const { value, done } = await reader.read();
    if (done) throw new Error("closed before its state frame");
    text += td.decode(value, { stream: true });
  }
  reader.releaseLock();
  return conn;
}

Deno.test("uds: by default (as 1.0.24) no connection hook runs for a window", async () => {
  const seen: string[] = [];
  await withApp("default", {
    onConnect: () => void seen.push("connect"),
    onDisconnect: () => void seen.push("disconnect"),
  }, async (socketPath) => {
    const conn = await window(socketPath, [
      enc("type", { kind: "electron" }),
      enc("proto", protoHello(VERSION)),
    ]);
    // The window is served (its state arrived) and a later frame is read.
    await new Promise((r) => setTimeout(r, 150));
    conn.close();
    await new Promise((r) => setTimeout(r, 150));
  });
  assertEquals(seen, [], "the hooks are opt-in on the local socket");
});

Deno.test("uds: localConnectHooks — onConnect/onDisconnect fire for a window, not for a control client", async () => {
  const seen: string[] = [];
  await withApp("pair", {
    localConnectHooks: true,
    onConnect: (u?: unknown) => void seen.push(`connect:${u ?? "anon"}`),
    onDisconnect: (u?: unknown) => void seen.push(`disconnect:${u ?? "anon"}`),
  }, async (socketPath) => {
    // A control client: one question, no hook.
    const r = await udsRequest(socketPath, "/__aio/health", {
      method: "GET",
    }, 5000);
    assertEquals("status" in r && r.status, 200, JSON.stringify(r));
    await new Promise((r) => setTimeout(r, 100));
    assertEquals(seen, [], "a control request is not a connection");

    // A window: what the Electron main process says first on every connect.
    const conn = await window(socketPath, [
      enc("type", { kind: "electron" }),
      enc("proto", protoHello(VERSION)),
    ]);
    await until("onConnect for the window", () => seen.length === 1);
    assertEquals(seen, ["connect:anon"]);
    conn.close();
    await until("onDisconnect for the window", () => seen.length === 2);
    assertEquals(seen, ["connect:anon", "disconnect:anon"]);
  });
});

Deno.test("uds: a throwing or rejecting connection hook never ends the connection", async () => {
  let connects = 0, disconnects = 0;
  await withApp("throw", {
    localConnectHooks: true,
    onConnect: () => {
      connects++;
      throw new Error("boom");
    },
    onDisconnect: () => {
      disconnects++;
      return Promise.reject(new Error("later boom"));
    },
  }, async (socketPath) => {
    // Served after the throw: its state frame arrives.
    const conn = await window(socketPath, [enc("proto", protoHello(VERSION))]);
    assertEquals(connects, 1);
    conn.close();
    await until("onDisconnect", () => disconnects === 1);
  });
});

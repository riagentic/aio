// The server's `proto` hello names WHICH APP this is and WHO the connection
// is — on every transport, as the first frame.
//
// The reload carry (browser-air-transport `_carryAcrossReload`) must send a
// dying page's calls only to the same app as the same user. Asking
// `/__aio/auth/me` for that was wrong twice: a `users:` token app sends its
// token on the socket URL, not as a cookie, so the fetch had no credential
// (401 → carry dropped silently), and an Electron UDS shell has no
// `__aioConfig` at import (appId arrives in `cfg`), so every carry looked
// foreign. The connection already knows both; the hello now says them.
// Additive: optional fields an older client ignores.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";
import { createUDSListener } from "../src/server/aio.ts";
import { connectLocal } from "../src/server/local-listen.ts";
import { localEndpoint } from "./local-endpoint-helper.ts";
import { parseProtoHello } from "../src/protocol/protocol-version.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const c = cell("hellowho", { state: { n: 0 }, methods: {} });

async function firstFrame(
  url: string,
): Promise<{ t: string; d: Record<string, unknown> }> {
  const ws = new WebSocket(url);
  try {
    return await new Promise((res, rej) => {
      ws.onmessage = (e) => res(JSON.parse(String(e.data)));
      ws.onerror = () => rej(new Error("ws error"));
    });
  } finally {
    ws.close();
    await new Promise((r) => setTimeout(r, 50));
  }
}

Deno.test("WS hello names the app and the connection's user (token apps included)", async () => {
  await using srv = await testServer({
    cells: [c],
    appId: "hello-app",
    users: { "tok-a": { id: "alice", role: "user" } },
  } as never);
  const host = new URL(srv.url).host;
  const f = await firstFrame(`ws://${host}/ws?token=tok-a`);
  assertEquals(f.t, "proto");
  assertEquals(f.d.appId, "hello-app");
  assertEquals(f.d.user, "alice");
});

Deno.test("WS hello says null for an anonymous connection", async () => {
  await using srv = await testServer({ cells: [c], appId: "anon-app" });
  const f = await firstFrame(`ws://${new URL(srv.url).host}/ws`);
  assertEquals(f.t, "proto");
  assertEquals(f.d.appId, "anon-app");
  assertEquals(f.d.user, null);
});

Deno.test("UDS hello names the app too (an Electron shell has no __aioConfig at import)", async () => {
  const dir = await tempDir("aio-hello-uds-");
  const path = localEndpoint(join(dir, "hello.sock"));
  const uds = createUDSListener(
    path,
    () => ({}),
    () => {},
    () => {},
    undefined,
    undefined,
    { appId: "uds-app" },
  );
  await new Promise((r) => setTimeout(r, 50));
  const conn = await connectLocal(path);
  const r = conn.readable.getReader();
  let buf = "";
  while (!buf.includes("\n")) {
    const { value, done } = await r.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
  }
  r.releaseLock();
  conn.close();
  uds.shutdown();
  await new Promise((r) => setTimeout(r, 50));
  await Deno.remove(dir, { recursive: true }).catch(() => {});
  const f = JSON.parse(buf.split("\n")[0]!);
  assertEquals(f.t, "proto");
  assertEquals(f.d.appId, "uds-app");
  assertEquals(f.d.user, null);
});

Deno.test("parseProtoHello keeps appId/user and drops ill-typed ones", () => {
  const base = { v: 3, min: 3 };
  assertEquals(
    parseProtoHello({ ...base, appId: "a", user: "u" })?.appId,
    "a",
  );
  assertEquals(parseProtoHello({ ...base, user: null })?.user, null);
  const bad = parseProtoHello({ ...base, appId: 7, user: { id: 1 } })!;
  assertEquals("appId" in bad, false);
  assertEquals("user" in bad, false);
});

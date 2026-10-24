// Every hook sees the user `onConnect` saw. A session socket's user was
// re-read per inbound frame and rebuilt as `{ id, role }`, so `onConnect` got
// `{ id, role, expiresAt }` and dispatch / `onDisconnect` (everything after
// the first frame) got the stripped copy.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createServer } from "../src/server/server.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("session user: onConnect, dispatch and onDisconnect get the same shape", async () => {
  const dir = await tempDir("aio-hook-user-");
  await Deno.mkdir(join(dir, "dist"));
  await Deno.writeTextFile(
    join(dir, "dist", "app.js"),
    "export function mount(){}",
  );
  const port = freePort();
  const seen: Record<string, unknown> = {};
  const session = { id: "u1", role: "user", expiresAt: 4102444800000 };
  const server = createServer({
    port,
    title: "t",
    getUIState: () => ({ ok: true }),
    dispatch: (_a: unknown, u?: unknown) => void (seen.dispatch = u),
    baseDir: dir,
    debug: () => {},
    prod: true,
    distDir: join(dir, "dist"),
    sessionResolver: (tok: string) => tok === "tok1" ? { ...session } : null,
    onConnect: (u: unknown) => void (seen.onConnect = u),
    onDisconnect: (u: unknown) => void (seen.onDisconnect = u),
    // deno-lint-ignore no-explicit-any
  } as any);
  const until = async (k: string) => {
    for (let i = 0; i < 200 && !(k in seen); i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=tok1`);
    await new Promise((r) => (ws.onopen = r));
    await until("onConnect");
    ws.send(
      JSON.stringify({ v: 2, t: "action", d: { type: "c:x", cid: "1" } }),
    );
    await until("dispatch");
    ws.close();
    await until("onDisconnect");
    assertEquals(seen.onConnect, session);
    assertEquals(seen.dispatch, session);
    assertEquals(seen.onDisconnect, session);
  } finally {
    await server.shutdown();
    await dropTempDir(dir);
  }
});

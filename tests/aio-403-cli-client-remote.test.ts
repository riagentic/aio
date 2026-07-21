// AIO-403 — remote field report: connectCli against an exposed server.
// Bug 1: wss:// URLs were downgraded to ws: (only https: mapped to wss:).
// Bug 2: ?token= in the URL was silently dropped (only opts.token was read),
//        while the server's own share link uses the ?token= form.
import { assert, assertEquals } from "@std/assert";
import { connectCli } from "../src/server/cli-client.ts";

Deno.test("aio-403: connectCli preserves ?token= from the share-link URL", async () => {
  let seenToken: string | null = null;

  const server = Deno.serve({ hostname: "127.0.0.1", port: 0 }, (req) => {
    const url = new URL(req.url);
    seenToken = url.searchParams.get("token");
    if (seenToken !== "sesame") {
      return new Response("unauthorized", { status: 401 });
    }
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () =>
      socket.send(
        JSON.stringify({ v: 2, t: "state", d: { counter: { count: 3 } } }),
      );
    return response;
  });

  const app = connectCli<{ counter: { count: number } }>(
    `ws://127.0.0.1:${server.addr.port}/ws?token=sesame`,
  );
  const state = await Promise.race([
    app.ready,
    new Promise<never>((_, rej) =>
      setTimeout(
        () => rej(new Error("ready timed out — token was dropped")),
        3000,
      )
    ),
  ]);

  assertEquals(seenToken, "sesame");
  assertEquals(state.counter.count, 3);

  app.close();
  await server.shutdown();
});

Deno.test("aio-403: connectCli opts.token wins over URL token", async () => {
  let seenToken: string | null = null;

  const server = Deno.serve({ hostname: "127.0.0.1", port: 0 }, (req) => {
    seenToken = new URL(req.url).searchParams.get("token");
    const { socket, response } = Deno.upgradeWebSocket(req);
    socket.onopen = () =>
      socket.send(JSON.stringify({ v: 2, t: "state", d: { ok: true } }));
    return response;
  });

  const app = connectCli(
    `ws://127.0.0.1:${server.addr.port}/ws?token=fromurl`,
    {
      token: "explicit",
    },
  );
  await Promise.race([
    app.ready,
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error("ready timed out")), 3000)
    ),
  ]);

  assertEquals(seenToken, "explicit");

  app.close();
  await server.shutdown();
});

Deno.test("aio-403: connectCli keeps wss: secure (no TLS downgrade)", async () => {
  // Behavioral TLS setup is heavy for unit tests; pin the mapping at source
  // level like the aio24 transport tests do.
  const src = await Deno.readTextFile("src/server/cli-client.ts");
  assert(
    /parsed\.protocol === "https:" \|\| parsed\.protocol === "wss:"/.test(src),
    "wss: must map to wss:, not fall through to ws:",
  );
  assert(
    /searchParams\.get\("token"\)/.test(src),
    "URL ?token= must be honored when opts.token is absent",
  );
});

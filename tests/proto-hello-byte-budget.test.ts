// The server's hello advertises its byte budget (`bytesPerSec`) beside the
// frame budget (`rate`), so a client paces large frames by size
// (send-pacer.ts `bytesRate`) instead of crossing the budget and living on
// retry hints. Additive within protocol v3: parsed when sane, dropped when not.
import { assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { dec } from "../src/protocol/envelope.ts";
import { parseProtoHello } from "../src/protocol/protocol-version.ts";

const probe = cell("hello-bytes-probe", {
  state: { n: 0 },
  methods: {
    bump(s) {
      s.n++;
    },
  },
});

Deno.test("proto hello: the server advertises wsLimits.bytesPerSec and the client parser keeps it", async () => {
  await using server = await testServer({
    cells: [probe],
    wsLimits: { bytesPerSec: 3_000_000 },
  });
  const hello = await new Promise<unknown>((resolve, reject) => {
    const ws = new WebSocket(server.url.replace("http", "ws") + "/ws");
    ws.onerror = () => reject(new Error("socket error"));
    ws.onmessage = (e) => {
      const f = dec(String(e.data));
      if (f?.t !== "proto") return;
      ws.onclose = () => resolve(f.d);
      ws.close();
    };
  });
  assertEquals(parseProtoHello(hello)?.bytesPerSec, 3_000_000);
});

Deno.test("proto hello: a nonsense bytesPerSec is dropped, never paced on", () => {
  for (const bad of [0, -1, 10, Number.NaN, "5000000", 1e15]) {
    assertEquals(
      parseProtoHello({ v: 3, min: 3, bytesPerSec: bad })?.bytesPerSec,
      undefined,
      String(bad),
    );
  }
});

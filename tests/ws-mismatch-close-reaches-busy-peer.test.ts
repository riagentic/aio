// A peer refused for its wire protocol is TOLD so — code 4505, "protocol
// mismatch" — also when it had already sent frames behind its hello.
//
// The server used to close from inside the hello's handler. Whatever the peer
// had sent behind the hello was then unread, the runtime's close handshake
// fails on unread data, and the peer saw an abrupt end with no code: measured
// (Deno 2.9), 30 frames behind the hello on macOS, 300 on Linux. A client
// reads 4505 as "stop reconnecting, this build is too old"; code 0 reads as a
// dropped connection, to be retried forever.
import { assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { enc } from "../src/protocol/envelope.ts";
import {
  PROTOCOL_MISMATCH_CLOSE_CODE,
  protoHello,
} from "../src/protocol/protocol-version.ts";
import { testServer } from "../src/testing/server-test.ts";

for (
  const [name, hello] of [
    ["a v1 hello", '__proto:{"v":1}'],
    ["a v2 hello this server cannot speak", null],
  ] as const
) {
  Deno.test(`ws: ${name} with 3000 frames behind it is closed with 4505 and its reason`, async () => {
    const c = cell(`mm${crypto.randomUUID().slice(0, 6)}`, {
      state: { n: 0 },
      methods: {
        bump(s: { n: number }) {
          s.n++;
        },
      },
    });
    await using srv = await testServer({ cells: [c] });
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`);
    let told = false;
    ws.onmessage = (e) => told ||= String(e.data).includes("proto-err");
    const closed = new Promise<CloseEvent>((res) => ws.onclose = res);
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error("socket failed to open"));
    });
    ws.send(hello ?? enc("proto", { ...protoHello(), v: 999, min: 999 }));
    for (let i = 0; i < 3000; i++) {
      ws.send(enc("action", { type: "x:bump", payload: {}, cid: `c${i}` }));
    }
    const e = await closed;
    assertEquals(
      [e.code, e.reason, told],
      [PROTOCOL_MISMATCH_CLOSE_CODE, "protocol mismatch", true],
    );
    assertEquals(c.n, 0, "nothing behind a refused hello is ever dispatched");
  });
}

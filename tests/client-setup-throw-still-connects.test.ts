// A throw during client setup must not cost the app its connection.
//
// `ensureConnected` claims its re-entry latch FIRST (correctly —
// `bindAllCellsReactive` must not run twice), which made every step after it
// load-bearing for the socket: one throw and `_callConnectFn()` never ran,
// with `_ensured` already true so nothing ever called it again.
//
// The result is the worst shape there is — an app that renders its shell,
// opens no socket, retries nothing and reports no error. Setup is
// app-reachable: binding walks every registered cell, so one bad cell took the
// whole connection with it.
import { assert, assertEquals } from "@std/assert";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";

Deno.test("client: a setup throw is reported, and the socket still opens", async () => {
  _resetAioRuntime();
  const mod = await import("../src/browser/browser-protocol.ts");
  const realError = console.error;
  const errs: string[] = [];
  console.error = (...a: unknown[]) => errs.push(String(a[0]));
  let connected = 0;
  try {
    mod._setConnectFn(() => {
      connected++;
    });
    // A throw from INSIDE setup, through the real path: `_makeSendWrapper`
    // hands the client send to `wrapTransport`, which reads the transport's
    // capability symbols off it. A send whose property access throws is
    // therefore a setup that throws — the same position an app-level cell
    // binding failure occupies.
    mod._setClientSend(
      new Proxy(() => {}, {
        // `wrapTransport` copies the transport's capability symbols with
        // `Object.getOwnPropertySymbols`, which goes through `ownKeys`.
        ownKeys() {
          throw new Error("binding blew up");
        },
      }) as unknown as Parameters<typeof mod._setClientSend>[0],
    );

    mod.ensureConnected();

    assertEquals(
      connected,
      1,
      "the connection must be opened even when setup threw — without it the " +
        "app renders its shell, opens no socket and retries nothing",
    );
    assert(
      errs.some((e) => e.includes("client setup failed")),
      `the failure must be said out loud: ${JSON.stringify(errs)}`,
    );
  } finally {
    console.error = realError;
    _resetAioRuntime();
  }
});

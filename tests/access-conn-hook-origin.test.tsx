// `onConnect` / `onDisconnect` are SERVER origin.
//
// A connection hook is the app's own server code, like `onInit` or a
// schedule, and the canonical thing it does is presence: mark the socket's
// user online in a cell whose `access` refuses that method to the network
// (a client must never set its own presence). Under `testUI` the server
// shares the isolate with the harness's origin scope, and the hook ran
// unmarked — so the harness refused the app's own hook as "an anonymous UI".
// Found by the dm messenger's approval tests on the 1.0.9-beta upgrade.

import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell.ts";
import { aio } from "../src/server/aio.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { connectCli } from "../src/server/cli-client.ts";
import { freePort } from "./e2e-harness.ts";

Deno.test({
  name: "a connection hook calling an access-gated method is server origin",
  fn: async () => {
    const presence = cell("presenceHook", {
      state: { online: 0 },
      // The network may never call `mark`; only the server may.
      access: (_user, method) => method !== "mark",
      methods: {
        mark: (s: { online: number }, d: number) => void (s.online += d),
      },
    });
    const port = freePort();
    const app = await aio.run({
      appId: `conn-hook-origin-${port}`,
      cells: [presence],
      port,
      client: "server-only",
      dbPath: ":memory:",
      persist: false,
      libraryMode: true,
      onConnect: () => void presence.mark(1),
      onDisconnect: () => void presence.mark(-1),
    });
    try {
      const App = () => <div>{String(presence.online)}</div>;
      await using ui = await testUI(App as never);
      const cli = connectCli(`http://127.0.0.1:${port}`, { token: "t" });
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        cli.ready,
        new Promise((_, no) => {
          timer = setTimeout(() => no(new Error("no ready")), 5e3);
        }),
      ]).finally(() => clearTimeout(timer));
      for (let i = 0; i < 100 && presence.online === 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      // settle() raises any unobserved rejection — the denial surfaced here.
      await ui.settle();
      assertEquals(presence.online, 1, "onConnect's own call was refused");
      cli.close();
      for (let i = 0; i < 100 && presence.online !== 0; i++) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await ui.settle();
      assertEquals(presence.online, 0, "onDisconnect's own call was refused");
      // …and the gate still holds for an actual client.
      assert(
        await presence.mark(1).then(() => false, () => true),
        "a UI call to a network-refused method must still be denied",
      );
    } finally {
      await app.close();
    }
  },
});

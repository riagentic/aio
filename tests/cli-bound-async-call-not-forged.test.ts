// cli-bound-async-call-not-forged.test.ts — an async method called through a
// remote binding (connectCli/connectCliUDS `.bind(cell)`) is not reported as a
// forgery by the server it calls.
//
// `bindCell`'s async branch stamped `_source: "Effect"` on the action whether
// the dispatcher was local or a wire. Over a wire `sanitizeClientAction` treats
// any `_source` other than "UI" as a forged trusted field: stripped, re-stamped
// "UI", and a WARN — "client sent trusted field(s) _source" — on every
// `await cell.asyncMethod()`, naming aio's own CLI client as an attacker. The
// same false alarm was removed for `payload._callId` earlier; this is its twin.
import { assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { bindCell } from "../src/state/cell-catalog.ts";
import { SETTLES_CALLS } from "../src/protocol/ack-registry.ts";
import { sanitizeClientAction } from "../src/server/server-ws.ts";
import { log } from "../src/diagnostics/logger-api.ts";
import type { CellDef, Msg } from "../src/state/cell-types.ts";

Deno.test("remote binding: an async call's action carries no _source, and the server does not warn", async () => {
  const c = cell("remote-async-not-forged", {
    state: { n: 0 },
    methods: {
      // deno-lint-ignore require-await
      async bump(s, by = 1) {
        s.n += by;
      },
      plain(s) {
        s.n++;
      },
    },
  });
  const sent: Msg[] = [];
  const dispatch = (a: Msg): Promise<unknown> => {
    sent.push(a);
    return Promise.resolve(undefined);
  };
  (dispatch as unknown as Record<symbol, boolean>)[SETTLES_CALLS] = true;
  bindCell(c as unknown as CellDef, dispatch, () => ({}));

  // deno-lint-ignore no-explicit-any
  await (c as any).bump(2);
  // deno-lint-ignore no-explicit-any
  await (c as any).plain();
  assertEquals(sent.length, 2);
  assertEquals(sent[0]!.type, "remote-async-not-forged:bump");
  assertEquals((sent[0] as { _source?: string })._source, undefined);

  // What the server does with exactly those actions, off the wire.
  const warned: string[] = [];
  const orig = log.warn.bind(log);
  // deno-lint-ignore no-explicit-any
  log.warn = ((_c: string, m: string) => void warned.push(m)) as any;
  try {
    for (const a of sent) {
      const wire = JSON.parse(JSON.stringify(a)) as Record<string, unknown>;
      sanitizeClientAction(wire, "ws");
      assertEquals(wire._source, "UI", "the server's stamp is unchanged");
    }
  } finally {
    log.warn = orig;
  }
  assertEquals(warned, []);
});

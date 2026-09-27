// invokeServerFn drops the `code` of an error thrown inside a serverFn body.
// docs/debugging/errors.md: "A cell method or `serverFn` that fails across a
// transport rejects with an Error carrying the code" — and the cell-method ack
// path keeps ANY code the error carries (`errorFields`). A serverFn that
// awaits a cell method refused with ACTION_REFUSED / ACCESS_DENIED (or throws
// an AioError itself) reaches its remote caller code-less, so
// `errorCode(err)` reads undefined and the caller cannot tell "stale" from
// "your code threw".
import { assertEquals } from "@std/assert";
import {
  _resetServerFns,
  invokeServerFn,
  serverFns,
} from "../src/server/server-fns.ts";
import { errorFields } from "../src/protocol/envelope.ts";

Deno.test("invokeServerFn: a coded error thrown in the fn body keeps its code (parity with cell acks)", async () => {
  _resetServerFns();
  try {
    const refused = () => {
      const e = new Error('cell "todos.add" — refused by validate');
      (e as Error & { code?: string }).code = "ACTION_REFUSED";
      return e;
    };
    serverFns("huntr7sfn", {
      // deno-lint-ignore require-await
      async viaCell() {
        throw refused(); // what `await todos.add(x)` rejects with
      },
    });
    // The cell-method ack for the same error carries the code:
    assertEquals(errorFields(refused()).code, "ACTION_REFUSED");

    const r = await invokeServerFn("huntr7sfn", "viaCell", []);
    assertEquals(r.ok, false);
    assertEquals(
      (r as { code?: string }).code,
      "ACTION_REFUSED",
      "the serverFn reply must carry the thrown error's code",
    );
  } finally {
    _resetServerFns();
  }
});

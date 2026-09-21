// What a production build serves, and what it must not.
//
// 🔓 The bug these pin. `/__aio/snapshot` was mounted in EVERY mode, and what
// it returns is `JSON.stringify(getState())` — the raw tree, with no `ui`
// filter and no `forUser` pass, by design, because an operator restoring a
// snapshot needs all of it. So every field an app excluded from its client
// projection was served in prod, unauthenticated, to anything that could
// reach the runtime — including the PAGE, since a packaged window's `aio://`
// handler proxies unknown paths to the app socket.
//
// Measured before the fix, against `examples/counter --prod`: 200 with the
// whole state, while `/__aio/error` and the trojan correctly 404'd in the same
// process. Reported by a crypto wallet built on aio, whose excluded fields are the
// encrypted seeds, the encrypted account keys and the passphrase verifier.
//
// The write half mattered as much as the read half and is easy to miss:
// `POST /__aio/snapshot?force=1` REPLACES state. For a wallet that is an
// address substitution — contacts, fee destinations — and it needed no
// passphrase, which no read of the vault file could ever give you.
import { assert, assertEquals } from "@std/assert";
import {
  AIO_ROUTE_METHODS,
  aioMethodDenial,
} from "../src/server/server-static.ts";

Deno.test("the snapshot route is declared dev-only", () => {
  const row = AIO_ROUTE_METHODS["/__aio/snapshot"];
  assert(row, "the route must still be in the table");
  assertEquals(
    row.devOnly,
    true,
    "a route that serves the raw, unfiltered state tree is an operator tool",
  );
});

Deno.test("its mount is gated on !prod, in the same place as the trojan", async () => {
  // Read as source on purpose. The route's own handler cannot tell you which
  // modes it is reachable in — that is decided at the mount, which is exactly
  // where the gate was missing.
  const src = await Deno.readTextFile("src/server/server-static.ts");
  const at = src.indexOf('pathname === "/__aio/snapshot"');
  assert(at > 0, "the mount must still exist");
  // The gate has to be part of the SAME condition, not a check somewhere
  // above that a later edit can drift away from.
  const condition = src.slice(Math.max(0, at - 200), at + 120);
  assert(
    /!prod\s*&&/.test(condition),
    `the snapshot mount must be gated on !prod:\n${condition}`,
  );
});

Deno.test("in prod it answers 404, not 405 — the truthful answer", () => {
  // `aioMethodDenial` takes the mode precisely so an unmounted route does not
  // claim to exist with the wrong method. A 405 would tell a prober the route
  // is there and to keep trying verbs.
  assertEquals(
    aioMethodDenial("/__aio/snapshot", "DELETE", true),
    null,
    "in prod the route is not mounted, so there is no method to deny",
  );
  // In dev it is a real route, so a wrong verb is a real 405.
  const dev = aioMethodDenial("/__aio/snapshot", "DELETE", false);
  assert(dev !== null, "in dev a wrong method must still be denied");
});

Deno.test("every route serving raw state or control is dev-only", () => {
  // The rule, not the instance. A future operator endpoint that reads state
  // or executes anything has to join this list.
  for (const path of ["/__aio/snapshot", "/__aio/error"]) {
    assertEquals(
      AIO_ROUTE_METHODS[path]?.devOnly,
      true,
      `${path} must not be mounted in a release build`,
    );
  }
  // …and the ones that are deliberately public stay public: an operator
  // needs liveness from a shipped app, and none of them read cell state.
  for (const path of ["/__aio/health", "/__aio/metrics", "/__aio/icon"]) {
    assertEquals(
      AIO_ROUTE_METHODS[path]?.devOnly,
      undefined,
      `${path} is diagnostics, not state — it should stay available`,
    );
  }
});

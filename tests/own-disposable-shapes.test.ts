// `own.set` kept a disposer only for a function or a close()/dispose() object.
// Everything else was dropped without a word, and the resource leaked for the
// life of the process — including the platform's own disposables:
// `Deno.serve()`'s HttpServer (and a spawned ChildProcess) carry only
// `Symbol.asyncDispose`. And an ASYNC factory — which type-checks, a
// Promise-returning function is assignable to one returning void — handed its
// Promise to the same check, which kept nothing. (The `OwnResource` type
// refuses these shapes, but the dev server is transpile-only: the type
// protects code that runs `deno check`, and the runtime has to be right for
// the code that does not — hence the casts below.)
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createOwnManager, own } from "../src/state/own.ts";
import { freePort } from "../src/testing/server-test.ts";

function mgr() {
  const errors: string[] = [];
  const log = {
    info() {},
    warn() {},
    error: (m: string) => void errors.push(m),
    debug() {},
  };
  // deno-lint-ignore no-explicit-any
  return { m: createOwnManager(log as any), errors };
}
const turn = () => new Promise((r) => setTimeout(r, 5));

Deno.test("own.set: standard-disposable and async-factory resources are released", async () => {
  const { m, errors } = mgr();
  const closed: string[] = [];

  // A real Deno.serve() server — owned, then shut down with the slot.
  const port = freePort();
  let server: Deno.HttpServer | undefined;
  m.handle(own.set(
    "srv",
    (() => {
      server = Deno.serve(
        { port, hostname: "127.0.0.1", onListen() {} },
        () => new Response("x"),
      );
      return server;
    }) as never,
  ));
  assertEquals(m.active(), ["srv"]);

  m.handle(own.set(
    "sync",
    (() => ({ [Symbol.dispose]: () => closed.push("sync") })) as never,
  ));
  m.handle(own.set(
    "async",
    (async () => {
      await turn();
      return () => closed.push("async");
    }) as never,
  ));
  await turn();
  await turn();
  assert(m.active().includes("async"), "the async factory's disposer is held");

  m.disposeAll();
  await server!.finished; // resolves only once the server has shut down
  await turn();
  assertEquals(closed.sort(), ["async", "sync"]);
  assertEquals(errors, []);
});

Deno.test("own.set: an async acquisition superseded while opening is released on arrival", async () => {
  const { m } = mgr();
  const closed: string[] = [];
  m.handle(own.set(
    "w",
    (async () => {
      await turn();
      return () => closed.push("old");
    }) as never,
  ));
  m.handle(own.set("w", () => () => closed.push("new"), { replace: true }));
  await turn();
  await turn();
  assertEquals(closed, ["old"], "the late resource must not leak or evict");
  assertEquals(m.active(), ["w"]);
  m.handle(own.dispose("w"));
  assertEquals(closed, ["old", "new"]);
});

Deno.test("own.set: a factory return that is not a disposer is reported, not dropped silently", () => {
  const { m, errors } = mgr();
  m.handle(own.set("n", (() => 42) as never));
  assertEquals(m.active(), []);
  assertStringIncludes(errors.join("\n"), "own: factory 'n' returned a number");
});

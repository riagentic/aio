// A serverFn call is asynchronous by construction — on BOTH sides.
//
// The type used to be the declared map, unchanged, so a sync body
// (`logout(t: string): void`) typed as `void` at every call site while the
// runtime returned a promise. `await api.logout(t).catch(…)` — the natural
// client code — failed to compile with "Property 'catch' does not exist on
// type 'void'", and the workaround was to declare bodies `async` that have
// nothing to await, each carrying a `deno-lint-ignore require-await`. That
// made the SERVER-side type less accurate to buy back a client-side one.
//
// The compile-time half of this test is the file itself: if `serverFn` ever
// stops mapping members to promises, the `.catch` and `Awaited` lines below
// stop type-checking.
import { assertEquals } from "@std/assert";
import { serverFn, serverFns } from "aio";

const def = serverFns("sfn-types", {
  // A plainly SYNC body — the shape that used to force the workaround.
  logout(token: string): void {
    void token;
  },
  count(a: number, b: number): number {
    return a + b;
  },
  // An async body must NOT become Promise<Promise<T>>.
  async fetchName(id: string): Promise<string> {
    await Promise.resolve();
    return `name-${id}`;
  },
});

Deno.test("serverFn: a sync body is still awaitable at the call site", async () => {
  const api = serverFn<typeof def>("sfn-types");
  // .catch on a void-declared member — the exact line that would not compile.
  await api.logout("tok").catch(() => {});
  assertEquals(await api.count(2, 3), 5);
});

Deno.test("serverFn: an async body does not double-wrap", async () => {
  const api = serverFn<typeof def>("sfn-types");
  const name: string = await api.fetchName("7");
  assertEquals(name, "name-7");
});

Deno.test("serverFns: the SERVER-side map keeps its real signatures", () => {
  // Direct server-side use is not a hop, so `def.count` stays sync — the
  // return type is the honest one on the side that actually runs the body.
  const n: number = def.count(1, 1);
  assertEquals(n, 2);
});

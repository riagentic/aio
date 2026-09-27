// tests/sync/twin-tab-dead-owner.test.ts — an op one tab queued, overwritten a
// moment later by a twin tab working from its older copy of the queue, is not
// lost when the tab that queued it is gone before it could notice.
//
// Tabs read localStorage from their own cache, which another tab's write
// reaches a moment later. Tab A queued x and closed (or reloaded, or
// navigated) right after the call; tab B, whose cache did not hold x yet,
// queued y and wrote its queue back without x. Only A ever put its own ops
// back — and A was gone: x never reached the server, while its call had
// resolved. B hears A's write (the `storage` event carries it) after its own
// write threw it away, and puts x back.
import { assertEquals } from "@std/assert";
import { tabViews } from "./_tab-views.ts";
import type { SyncOp } from "../../src/sync/types.ts";

const op = (id: string): SyncOp => ({
  id,
  cell: "c",
  action: "add",
  payload: { args: [id] },
  hlc: [1, 0, "p"],
  confirmed: false,
  _clientTs: 1,
});
const ids = async (s: { loadOps(c: string): Promise<SyncOp[]> }) =>
  (await s.loadOps("c")).map((o) => o.id).sort();

Deno.test("twin tabs: an op whose tab closed right after queueing survives a twin's stale write", async () => {
  const v = tabViews();
  const a = v.open("q");
  const b = v.open("q");
  await a.s.saveOp(op("x"));
  v.kill(a.idx); // A is gone: it never reads the queue again.
  await b.s.saveOp(op("y")); // B's cache has no x: its write drops it.
  v.deliver(b.idx); // A's write reaches B — after B's own.
  assertEquals(await ids(b.s), ["x", "y"]);
  const c = v.open("q"); // a tab opened later reads what is stored
  assertEquals(await ids(c.s), ["x", "y"]);
});

Deno.test("twin tabs: an op put back for a closed tab survives a third tab's stale write", async () => {
  const v = tabViews();
  const a = v.open("q");
  const b = v.open("q");
  const c = v.open("q");
  await a.s.saveOp(op("x"));
  v.kill(a.idx);
  await b.s.saveOp(op("y"));
  v.deliver(b.idx); // B puts x back…
  await c.s.saveOp(op("z")); // …and C, from its older copy, takes it out again
  v.deliver(b.idx);
  assertEquals(await ids(v.open("q").s), ["x", "y", "z"]);
});

Deno.test("twin tabs: an op put back by a tab that closed survives the next stale write", async () => {
  const v = tabViews();
  const a = v.open("q");
  const b = v.open("q");
  const c = v.open("q");
  await a.s.saveOp(op("x"));
  v.deliver(c.idx); // C hears A's write while x is there: nothing to do
  v.kill(a.idx);
  await b.s.saveOp(op("y")); // B's stale write drops x…
  v.deliver(c.idx); // (C now holds B's queue: no x)
  v.deliver(b.idx); // …B hears A's write and puts x back — then closes
  v.kill(b.idx);
  await c.s.saveOp(op("z")); // C writes over B's put-back from its copy
  v.deliver(c.idx); // C hears B's write: the op it put back is back again
  assertEquals(await ids(v.open("q").s), ["x", "y", "z"]);
});

Deno.test("twin tabs: an op its own tab put back before closing survives the next stale write", async () => {
  const v = tabViews();
  const a = v.open("q");
  const b = v.open("q");
  const c = v.open("q");
  await a.s.saveOp(op("x"));
  v.deliver(c.idx); // C hears A's write while x is there: nothing to do
  await b.s.saveOp(op("y")); // B's stale write drops x…
  v.deliver(c.idx); // (C now holds B's queue: no x)
  v.deliver(a.idx); // …A reads, puts x back — then closes
  v.kill(a.idx);
  await c.s.saveOp(op("z")); // C writes over A's put-back from its copy
  v.deliver(c.idx);
  assertEquals(await ids(v.open("q").s), ["x", "y", "z"]);
});

Deno.test("twin tabs: an op the lost write carried over, taken out on purpose, stays out", async () => {
  const v = tabViews();
  const a = v.open("q");
  const b = v.open("q");
  const c = v.open("q");
  await c.s.saveOp(op("o"));
  v.deliver(a.idx);
  await a.s.saveOp(op("x")); // A's write carries C's o over and adds x
  v.kill(a.idx);
  await c.s.confirmOp("c", "o"); // C, not yet seeing x, is done with o
  await c.s.pruneConfirmed("c");
  v.deliver(b.idx); // B, a bystander, hears it all
  assertEquals(await ids(v.open("q").s), ["x"]);
});

Deno.test("twin tabs: an op the late tab took out on purpose is not put back", async () => {
  const v = tabViews();
  const a = v.open("q");
  const b = v.open("q");
  await a.s.saveOp(op("x"));
  v.kill(a.idx);
  // B's cache gets x; B confirms and prunes it (its ack) and writes again —
  // all before the event of A's write reaches B.
  v.deliver(b.idx, true);
  await b.s.saveOp(op("y"));
  await b.s.confirmOp("c", "x");
  await b.s.pruneConfirmed("c");
  await b.s.saveOp(op("z"));
  v.deliver(b.idx);
  assertEquals(await ids(b.s), ["y", "z"]);
  assertEquals(await ids(v.open("q").s), ["y", "z"]);
});

Deno.test("twin tabs: an op another tab took out on purpose is not put back", async () => {
  const v = tabViews();
  const a = v.open("q");
  const b = v.open("q");
  const c = v.open("q");
  await a.s.saveOp(op("x"));
  v.kill(a.idx);
  v.deliver(c.idx, true); // C sees x, confirms and prunes it: done with it
  await c.s.confirmOp("c", "x");
  await c.s.pruneConfirmed("c");
  v.deliver(b.idx); // B hears A's write only now — the queue has moved on
  assertEquals(await ids(b.s), []);
  assertEquals(await ids(v.open("q").s), []);
});

Deno.test("twin tabs: an op the late tab took out is not put back after a third tab's stale write", async () => {
  const v = tabViews();
  const a = v.open("q");
  const b = v.open("q");
  const c = v.open("q");
  await a.s.saveOp(op("x"));
  v.kill(a.idx);
  v.deliver(b.idx, true); // B confirms and prunes x…
  await b.s.confirmOp("c", "x");
  await b.s.pruneConfirmed("c");
  await c.s.saveOp(op("z")); // …and C, from before A's write, writes over it
  v.deliver(b.idx); // B hears A's write: x left on purpose, by B itself
  assertEquals(await ids(v.open("q").s), ["z"]);
});

Deno.test("twin tabs: only the ops the lost write added come back, not what it carried over", async () => {
  const v = tabViews();
  const a = v.open("q");
  const b = v.open("q");
  await b.s.saveOp(op("o"));
  v.deliver(a.idx);
  await a.s.saveOp(op("x")); // A's write carries o over and adds x
  v.kill(a.idx);
  await b.s.confirmOp("c", "o"); // B, not yet seeing x, is done with o
  await b.s.pruneConfirmed("c");
  v.deliver(b.idx);
  assertEquals(await ids(b.s), ["x"]);
});

Deno.test("twin tabs: a write the late tab never overwrote is left alone", async () => {
  const v = tabViews();
  const a = v.open("q");
  const b = v.open("q");
  await b.s.saveOp(op("y"));
  v.deliver(a.idx);
  await a.s.saveOp(op("x")); // A's write descends from B's: nothing lost
  await a.s.confirmOp("c", "x");
  await a.s.pruneConfirmed("c"); // …and A takes x out on purpose
  v.kill(a.idx);
  v.deliver(b.idx); // B hears both writes; the queue is not B's write now
  assertEquals(await ids(b.s), ["y"]);
});

Deno.test("twin tabs: another app's queue on the origin is never restored from", async () => {
  const v = tabViews();
  const other = v.open("qa"); // a second app: a prefix of the same length
  const b = v.open("qb");
  await b.s.saveOp(op("y"));
  await other.s.saveOp(op("x"));
  v.deliver(b.idx);
  assertEquals(await ids(b.s), ["y"]);
});

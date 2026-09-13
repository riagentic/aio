// tests/sync/nondeterministic-method.test.ts — a sync method that reads a
// random source (or a clock) must not fork replicas silently.
//
// Every replica replays a sync op through the method: the origin at its ack,
// the server at dispatch, each peer at the broadcast. `crypto.randomUUID()`
// inside `add` — the docs' own Quick Start — gave the item a different id on
// every one of them, so a peer's `remove(id)` matched nothing on the server,
// and each screen kept its own ids for good with nothing said anywhere.
//
// The engine cannot make the method deterministic without the value travelling
// with the op (future/v2.md). It must SEE it — a pure reducer run twice on one
// input disagreeing with itself is proof — say so, and converge on the server.
import { assert, assertEquals } from "@std/assert";
import { createNet, type State } from "./_net.ts";

const CELL = "todos";
type Todo = { id: string; text: string };
const apply = (s: State, action: string, payload: unknown): State => {
  const items = s.items as Todo[];
  if (action === "add") {
    return {
      items: [...items, { id: crypto.randomUUID(), text: payload as string }],
    };
  }
  if (action === "remove") {
    return { items: items.filter((i) => i.id !== payload) };
  }
  return s;
};

Deno.test("a method using crypto.randomUUID() is reported, and every replica converges on the server's ids", async () => {
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  const net = createNet({
    cell: CELL,
    initial: () => ({ items: [] }),
    apply,
    engine: { pureReducer: true },
  });
  try {
    const a = net.addClient("a");
    const b = net.addClient("b");
    await a.engine.requestSync();
    await b.engine.requestSync();
    await net.pump();

    await a.engine.handleLocalAction(CELL, "add", "milk");
    await a.engine.handleLocalAction(CELL, "add", "eggs");
    for (let i = 0; i < 20; i++) {
      await net.pump();
      await new Promise((r) => setTimeout(r, 5));
    }

    const server = net.live().items as Todo[];
    assertEquals(server.length, 2);
    for (const c of [a, b]) {
      assertEquals(
        c.confirmed().items,
        server,
        `${c.name} holds the server's ids`,
      );
      assertEquals(c.view().items, server, `${c.name} shows the server's ids`);
    }

    // …so an edit that names an id now means the same item everywhere.
    await b.engine.handleLocalAction(CELL, "remove", server[0]!.id);
    for (let i = 0; i < 10; i++) await net.pump();
    assertEquals((net.live().items as Todo[]).map((t) => t.text), ["eggs"]);
    assertEquals((a.view().items as Todo[]).map((t) => t.text), ["eggs"]);

    const said = errors.filter((e) =>
      e.includes(`${CELL}.add is not deterministic`)
    );
    assert(
      said.length > 0,
      `the method is named at error level — got ${errors.join("\n")}`,
    );
    // Two ops of the method, replayed on two clients (ack, broadcast, local
    // call): once per method per client, never once per op.
    assert(said.length <= 2, `said ${said.length} times for two clients`);
  } finally {
    console.error = origError;
    await net.close();
  }
});

Deno.test("a deterministic method is never reported", async () => {
  const errors: string[] = [];
  const origError = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  const net = createNet({
    cell: CELL,
    initial: () => ({ items: [], n: NaN }),
    apply: (s, action, p) =>
      action === "add"
        ? {
          ...s,
          items: [...(s.items as Todo[]), { id: String(p), text: String(p) }],
        }
        : s,
    engine: { pureReducer: true },
  });
  try {
    const a = net.addClient("a");
    const b = net.addClient("b");
    await a.engine.requestSync();
    await b.engine.requestSync();
    await net.pump();
    for (let i = 0; i < 5; i++) {
      await a.engine.handleLocalAction(CELL, "add", i);
    }
    await net.pump();
    assertEquals(b.confirmed().items, net.live().items);
    assertEquals(errors.filter((e) => /not deterministic/.test(e)), []);
  } finally {
    console.error = origError;
    await net.close();
  }
});

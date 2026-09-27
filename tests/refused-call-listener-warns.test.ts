// tests/refused-call-listener-warns.test.ts — a refused CALL still runs its
// `listensTo` listeners (frozen 1.0.9 behavior, docs/state/composition.md).
// That stays; what changes is that dev SAYS so, once per action+listener, so
// a tally that counts refused adds is found in dev instead of in the data.
// A sync op (no reaction) and an accepted call say nothing.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { composeCells } from "../src/state/cell-compose.ts";
import { _resetSwallowedRefusals } from "../src/state/cell-compose-reduce.ts";

function makeCells() {
  const notes = cell("notes", {
    state: { items: [] as string[] },
    methods: {
      add(s, t: string) {
        s.items.push(t);
      },
    },
    validate: (s) => s.items.includes("bad") ? "no bad" : true as const,
  });
  const tally = cell("tally", {
    state: { n: 0 },
    methods: {
      onAdd(s) {
        s.n += 1;
      },
    },
    listensTo: { onAdd: "notes:add" },
  });
  return [notes, tally];
}

function captured(fn: () => void): string[] {
  const out: string[] = [];
  const keep = { warn: console.warn, log: console.log, error: console.error };
  const g = globalThis as Record<string, unknown>;
  const dev = g.__aioDev;
  console.warn = console.log = console.error = (...a: unknown[]) => {
    out.push(a.map(String).join(" "));
  };
  g.__aioDev = true;
  _resetSwallowedRefusals();
  try {
    fn();
  } finally {
    Object.assign(console, keep);
    g.__aioDev = dev;
  }
  return out.filter((l) => l.includes("still ran"));
}

Deno.test("refused call: dev says once that its listensTo listener still ran; a sync op and an accepted call say nothing", () => {
  const composed = composeCells(makeCells());
  let state = composed.initialState as Record<string, unknown>;
  const run = (t: string, extra: Record<string, unknown> = {}) => {
    state = composed.reduce(
      state as never,
      { type: "notes:add", payload: { args: [t] }, ...extra } as never,
    ).state as never;
  };
  assertEquals(captured(() => run("ok")), []);
  assertEquals(captured(() => run("bad", { _syncOp: true })), []);
  const lines = captured(() => {
    run("bad");
    run("bad");
  });
  assertEquals(lines.length, 1, lines.join("\n"));
  const [line = ""] = lines;
  assert(line.includes("notes:add"), line);
  assert(line.includes(`"tally"`), line);
  // Behavior unchanged: the listener ran both times.
  assertEquals((state.tally as { n: number }).n, 3);
});

// A listener that looked at the refused action and changed NOTHING (it checks
// the source cell's state — exactly what the warning tells you to do) is not
// a kept change for a refused action: no warning.
Deno.test("refused call: a listensTo listener that changes nothing is not warned about", () => {
  const notes = makeCells()[0]!;
  const guard = cell("guard", {
    state: { n: 0 },
    methods: {
      onAdd(s) {
        if (s.n > 1000) s.n = 0;
      },
    },
    listensTo: { onAdd: "notes:add" },
  });
  const composed = composeCells([notes, guard]);
  let state = composed.initialState as Record<string, unknown>;
  const lines = captured(() => {
    state = composed.reduce(
      state as never,
      { type: "notes:add", payload: { args: ["bad"] } } as never,
    ).state as never;
  });
  assertEquals(lines, []);
});

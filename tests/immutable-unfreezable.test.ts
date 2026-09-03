// Values in cell state that FREEZING CANNOT PROTECT, said out loud.
//
// Immer drafts plain objects and arrays and nothing else. A `Date`, a typed
// array or a class instance in state is therefore not a draft: mutating it in
// place inside a SYNC method changes it in this process, produces NO patch,
// and so reaches no client and no `state.db` — while an in-process assertion
// (`testCell`, `testUI`) reads the mutated value back and passes. Freezing is
// what normally turns such a write into a throw at the site, and freezing is
// exactly what does not work here: a Date's time and a typed array's bytes
// live in internal slots, and a typed array cannot be frozen at all.
//
// One shared boolean used to cover Map/Set only, so the first unfreezable kind
// seen silenced every other kind for the rest of the process.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { _unfreezableWarned, deepFreeze } from "../src/state/immutable.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

/** Collect the warnings a body produces. */
function warnings(body: () => void): string[] {
  const out: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, cat: string, msg?: string) => {
        if (lvl === "warn") out.push(msg ?? cat);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
    } as Any,
  );
  try {
    body();
  } finally {
    setLogger(prev);
  }
  return out;
}

class Account {
  balance = 0;
  deposit(n: number) {
    this.balance += n;
  }
}

Deno.test("deepFreeze: every kind freezing cannot protect is named, once per KIND", () => {
  _unfreezableWarned.clear();
  const got = warnings(() => {
    deepFreeze({ when: new Date(0) });
    deepFreeze({ bytes: new Uint8Array([1, 2]) });
    deepFreeze({ acct: new Account() });
    deepFreeze({ m: new Map([["k", 1]]) });
    deepFreeze({ s: new Set([1]) });
  });
  // Before: one boolean, so exactly ONE of these five was ever reported.
  assertEquals(got.length, 5, got.join("\n"));
  for (
    const needle of ["Date", "typed array", "Account instance", "Map", "Set"]
  ) {
    assert(
      got.some((w) => w.includes(needle)),
      `${needle} not named — ${got.join("\n")}`,
    );
  }
  // Each one says what the silence COSTS, not just that freezing was skipped.
  for (const w of got) {
    assertStringIncludes(w, "commit NO patch");
  }
});

Deno.test("deepFreeze: the same kind twice is one line, not two", () => {
  _unfreezableWarned.clear();
  const got = warnings(() => {
    deepFreeze({ a: new Date(0) });
    deepFreeze({ b: new Date(1) });
  });
  assertEquals(got.length, 1, got.join("\n"));
});

Deno.test("deepFreeze: plain state is silent, and still frozen", () => {
  _unfreezableWarned.clear();
  const obj = { a: 1, nested: { b: [1, 2] } };
  const got = warnings(() => deepFreeze(obj));
  assertEquals(got, []);
  assert(Object.isFrozen(obj.nested));
  assert(Object.isFrozen(obj.nested.b));
});

// The hazard itself: this is what the warning is ABOUT.
Deno.test("deepFreeze: a frozen Date still mutates in place — which is why it is announced", () => {
  _unfreezableWarned.clear();
  const d = new Date(0);
  warnings(() => deepFreeze({ d }));
  assert(Object.isFrozen(d));
  d.setTime(5_000); // no throw: freezing does not reach the internal slot
  assertEquals(d.getTime(), 5_000);
});

// …and the wiring, which is the half a helper test cannot see: a real boot
// freezes committed state, so a Date in a real cell reaches deepFreeze.
Deno.test("deepFreeze: a real cell with a Date in state is warned about once", async () => {
  const { cell } = await import("../src/state/cell-create.ts");
  const { bootCells } = await import("../src/testing/cell-test.ts");
  _unfreezableWarned.clear();
  const c = cell("unfreezableprobe", {
    state: { when: null as unknown },
    methods: {
      stamp(s: { when: unknown }) {
        s.when = new Date(0);
      },
    },
  });
  const out: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, cat: string, msg?: string) => {
        if (lvl === "warn") out.push(msg ?? cat);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
    } as Any,
  );
  let h: { dispose(): void } | undefined;
  try {
    h = await bootCells([c] as never);
    await (c as unknown as { stamp: () => Promise<void> }).stamp();
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    setLogger(prev);
    h?.dispose();
  }
  const hit = out.filter((w) => w.includes("cannot be frozen"));
  assertEquals(hit.length, 1, out.join("\n") || "(no warning at all)");
  assertStringIncludes(hit[0]!, "Date");
});

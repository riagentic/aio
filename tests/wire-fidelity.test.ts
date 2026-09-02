// State the wire cannot carry is reported where it is WRITTEN.
//
// A Map in cell state is a real Map to the method that wrote it and to any
// in-process test that reads it back, and `{}` to every client and to
// state.db — measured, not assumed:
//
//   IN-PROCESS  m: Map  s: Set  d: Date
//   OVER WIRE   {"m":{},"s":{},"d":"2020-01-02T03:04:05.000Z"}
//
// So `testCell` asserting `state.m.get("k") === 1` passes while the same app is
// broken in a browser: green-test-broken-prod, which the dev==prod doctrine
// names as the thing never to allow. EFFECTS have been guarded against exactly
// this since `cloneEffects` ("JSON loses undefined/NaN/Infinity/Date/Map/Set
// and silently corrupted the executor's payload contract"); state — the surface
// that also gets persisted — never was.
import { assert, assertEquals } from "@std/assert";
import {
  _wireLossSeen,
  findWireLoss,
  warnWireLoss,
} from "../src/state/wire-fidelity.ts";

Deno.test("wire fidelity: the destructive kinds are named, with what is lost", () => {
  for (
    const [v, kind] of [
      [new Map([["k", 1]]), "Map"],
      [new Set([1]), "Set"],
      [() => {}, "function"],
      [Symbol("s"), "symbol"],
      [10n, "bigint"],
    ] as const
  ) {
    const hit = findWireLoss(v, "x");
    assert(hit, `${kind} not detected`);
    assertEquals(hit.kind, kind);
    assert(hit.lost.length > 0, `${kind} does not say what is lost`);
  }
});

Deno.test("wire fidelity: finds it nested, and names the path", () => {
  const hit = findWireLoss({ a: [0, { b: new Set([1]) }] }, "root");
  assert(hit);
  assertEquals(hit.path, "root.a[1].b");
});

Deno.test("wire fidelity: plain JSON data is silent — including the shapes that only CHANGE", () => {
  assertEquals(findWireLoss({ a: 1, b: [1, "x"], c: null }, "p"), null);
  // Deliberately out of scope: a Date becomes its ISO string and NaN becomes
  // null, but no DATA is destroyed, and dates in state are far too common for
  // a warning about them to stay readable. If that ever changes, this line is
  // the one to argue with.
  assertEquals(findWireLoss({ d: new Date(0), n: NaN }, "p"), null);
});

Deno.test("wire fidelity: a cycle does not hang the walk", () => {
  const a: Record<string, unknown> = { n: 1 };
  a.self = a;
  assertEquals(findWireLoss(a, "p"), null);
});

Deno.test("wire fidelity: warns once per cell+path+kind, not once per write", () => {
  _wireLossSeen.clear();
  const prevDev = (globalThis as Record<string, unknown>).__aioDev;
  (globalThis as Record<string, unknown>).__aioDev = true;
  try {
    const patches = [{ path: ["m"], value: new Map([["k", 1]]) }];
    let reports = 0;
    for (let i = 0; i < 3; i++) {
      const before = _wireLossSeen.size;
      warnWireLoss("probe", patches);
      if (_wireLossSeen.size > before) reports++;
    }
    assertEquals(reports, 1, "a value written every tick would flood the log");
  } finally {
    (globalThis as Record<string, unknown>).__aioDev = prevDev;
  }
});

// …and the wiring, which is the half a helper test cannot see.
Deno.test("wire fidelity: a real cell commit reports it", async () => {
  const { cell } = await import("../src/state/cell-create.ts");
  const { bootCells } = await import("../src/testing/cell-test.ts");
  const { getLogger, setLogger } = await import(
    "../src/diagnostics/logger-api.ts"
  );
  _wireLossSeen.clear();
  const c = cell("wfprobe", {
    state: { m: null as unknown },
    methods: {
      put(s: { m: unknown }) {
        s.m = new Map([["k", 1]]);
      },
    },
  });
  const warnings: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _cat: string, msg: string) => {
        if (lvl === "warn") warnings.push(msg);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  try {
    await bootCells([c] as never);
    (c as unknown as { put: () => void }).put();
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    setLogger(prev);
  }
  const hit = warnings.filter((w) => w.includes("the wire cannot carry"));
  assertEquals(hit.length, 1, warnings.join("\n") || "(no warnings at all)");
  assert(hit[0]!.includes("state.m"), hit[0]);
});

// There are TWO producers of patches in cell-compose-reduce — the
// state-machine path and the plain one — and the first version of this check
// sat inline after ONE of them, silently covering half the cells. That is the
// "two deciders" shape this repo keeps paying for, so the structure is pinned
// rather than trusted: every commit that narrows patches must report on them.
Deno.test("wire fidelity: BOTH commit paths report — not just the one I hooked first", async () => {
  const src = await Deno.readTextFile(
    new URL("../src/state/cell-compose-reduce.ts", import.meta.url),
  );
  const narrows = [...src.matchAll(/narrowPatches\(cellState/g)].length;
  const guards = [...src.matchAll(/warnWireLoss\(cellName/g)].length;
  assertEquals(
    guards,
    narrows,
    `${narrows} commit path(s) narrow patches but only ${guards} report ` +
      `unwireable state — a cell taking the unguarded path keeps the silence`,
  );
  assert(narrows >= 2, `expected both commit paths, found ${narrows}`);
});

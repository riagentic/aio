// `serverImport` + `bootCells({ stub })` — the rung that did not exist.
//
// A field report named a cell there is no safe tier for (report 9 §8.6, §9.3): it
// owns an OS process, `testCell` never reaches the spawn, and `bootCells`
// spawns the REAL child — so "random actions against a real runtime" means a
// real subprocess per action. Cassettes wrap a function you can reach; they
// cannot wrap `await import("./claude.server.ts")` inside a method.
//
// Nothing can intercept a raw dynamic import in Deno. There is no loader hook
// a test process can install after the fact, so the seam has to be a function
// the app calls on purpose — and the price of that is stated plainly rather
// than hidden behind a stub that silently does not apply.
import { assert, assertEquals } from "@std/assert";
import {
  _stubbedSpecifiers,
  resetServerImportStubs,
  serverImport,
  setServerImportStubs,
} from "../src/state/server-import.ts";

const HERE = import.meta.url;

Deno.test("unstubbed, it is exactly the import it replaces", async () => {
  resetServerImportStubs();
  const mod = await serverImport<{ run: () => string }>(
    "./fixtures-server-import/real.server.ts",
    HERE,
  );
  assertEquals(
    mod.run(),
    "REAL",
    "the real module must load — a helper that quietly resolved to nothing " +
      "would be worse than a raw import",
  );
});

Deno.test("a stub stands in, keyed by the specifier AS WRITTEN", () => {
  // A test stubs the string it can SEE in the cell, never a `file:///…` it
  // would have to compute.
  try {
    setServerImportStubs({
      "./fixtures-server-import/real.server.ts": { run: () => "CANNED" },
    });
    assertEquals(_stubbedSpecifiers(), [
      "./fixtures-server-import/real.server.ts",
    ]);
    return serverImport<{ run: () => string }>(
      "./fixtures-server-import/real.server.ts",
      HERE,
    ).then((m) => assertEquals(m.run(), "CANNED"));
  } finally {
    resetServerImportStubs();
  }
});

Deno.test("a specifier nobody stubbed still loads for real", async () => {
  // The stub map is not a whitelist. A cell that imports two modules and stubs
  // one must get the real other — otherwise installing a stub silently breaks
  // everything beside it.
  try {
    setServerImportStubs({ "./nothing-like-this.ts": { x: 1 } });
    const mod = await serverImport<{ run: () => string }>(
      "./fixtures-server-import/real.server.ts",
      HERE,
    );
    assertEquals(mod.run(), "REAL");
  } finally {
    resetServerImportStubs();
  }
});

Deno.test("setting REPLACES — one boot's stubs never leak into the next", () => {
  try {
    setServerImportStubs({ "./a.ts": {} });
    setServerImportStubs({ "./b.ts": {} });
    assertEquals(_stubbedSpecifiers(), ["./b.ts"]);
    setServerImportStubs(undefined);
    assertEquals(
      _stubbedSpecifiers(),
      [],
      "a green test over a module nobody meant to fake is the failure this " +
        "replacement prevents",
    );
  } finally {
    resetServerImportStubs();
  }
});

Deno.test("bootCells passes `stub` through, and the runtime reset clears it", async () => {
  const { bootCells } = await import("../src/cell-test.ts");
  const { cell } = await import("../mod.ts");
  // deno-lint-ignore no-explicit-any
  type D = any;
  const owner = cell("stubowner", {
    state: { out: "" },
    methods: {
      async go(s: { out: string }) {
        const m = await serverImport<{ run: () => string }>(
          "./fixtures-server-import/real.server.ts",
          HERE,
        );
        s.out = m.run();
      },
    },
  } as D);
  const boot = await bootCells([owner], {
    stub: {
      "./fixtures-server-import/real.server.ts": { run: () => "STUBBED" },
    },
  } as D);
  try {
    await (owner as D).go();
    await boot.settle();
    // Read through the CELL, which is how an app reads it — `BootHandle` has
    // no getState, and asserting through the same door the app uses is the
    // point of this tier.
    assertEquals(
      (owner as D).out,
      "STUBBED",
      "the cell reached the real module — the stub never applied",
    );
  } finally {
    boot.dispose();
  }
  // `_resetAioRuntime` runs in every harness teardown; the stub must not
  // survive it.
  const { _resetAioRuntime } = await import("../src/state/runtime-reset.ts");
  _resetAioRuntime();
  assertEquals(_stubbedSpecifiers(), []);
});

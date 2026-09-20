// Committed state is frozen in a PRODUCTION boot, not just in dev.
//
// A prod boot logs `freezeState: false (prod default)`, which reads as "state
// is not frozen in production" — the opposite of CLAUDE.md's rule that Immer
// `autoFreeze` is never disabled and an illegal mutation throws in dev AND
// prod. Measured: the rule holds for every commit (Immer freezes what a
// method produced, and a restored slice too); `freezeState` only gates the
// EXTRA full-tree freeze pass after each commit. So the log was misleading —
// and there was one real hole behind it:
//
//   `app.loadSnapshot(json)` put the parsed JSON in place unfrozen. In BOTH
//   modes a write to it succeeded until the next dispatch; in dev the next
//   dispatch (any cell) froze the whole tree, while in prod a cell's slice
//   stayed writable until THAT cell committed — dev and prod disagreeing
//   about whether `getState().cell.x.y = 1` throws. The initial state has the
//   same rule and is frozen in both modes (`cell-compose.ts`); a snapshot is
//   now frozen the same way.
import { assert, assertStringIncludes, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { _resetParsedCli } from "../src/server/aio-cli.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const _argsDesc = Object.getOwnPropertyDescriptor(Deno, "args")!;

async function withProdApp(
  mode: "dev" | "prod",
  fn: (app: Any, c: Any, other: Any, dir: string) => Promise<void>,
  reuseDir?: string,
): Promise<void> {
  const dir = reuseDir ?? await tempDir("aio-prod-frozen-");
  Object.defineProperty(Deno, "args", {
    value: mode === "prod" ? ["--prod"] : [],
    configurable: true,
    enumerable: true,
  });
  _resetParsedCli();
  _resetAioRuntime();
  const c = cell("pfrz", {
    state: { a: { n: 0 }, b: { deep: { m: 1 } }, list: [{ v: 1 }] },
    methods: {
      touchA(s: Any) {
        s.a.n++;
      },
      setB(s: Any, v: Any) {
        s.b = v;
      },
    },
  });
  const other = cell("pfrzo", {
    state: { k: 0 },
    methods: {
      bump(s: Any) {
        s.k++;
      },
    },
  });
  const app = await aio.run({
    cells: [c, other],
    appId: `prod-frozen-${mode}`,
    client: "server-only",
    libraryMode: true,
    port: freePort(),
    dbPath: join(dir, "state.db"),
    baseDir: dir,
    persistDebounceMs: 10,
  } as Any);
  try {
    await fn(app, c, other, dir);
  } finally {
    await app.close();
    Object.defineProperty(Deno, "args", _argsDesc);
    _resetParsedCli();
    _resetAioRuntime();
    if (!reuseDir) await dropTempDir(dir);
  }
}

function assertCannotWrite(write: () => void, where: string): void {
  assertThrows(
    write,
    TypeError,
    undefined,
    `${where}: a write to committed state OUTSIDE a method succeeded`,
  );
}

for (const mode of ["prod", "dev"] as const) {
  Deno.test(`${mode} boot: committed state cannot be mutated outside a method`, async () => {
    await withProdApp(mode, async (app, c, other) => {
      // Initial state.
      assertCannotWrite(() => {
        app.getState().pfrz.b.deep.m = 99;
      }, "initial");
      // A sync method's fresh value, from an argument.
      const arg = { deep: { m: 2 } };
      await c.setB(arg);
      assertCannotWrite(() => {
        app.getState().pfrz.b.deep.m = 99;
      }, "after setB");
      // An untouched slice after another cell committed.
      await other.bump();
      assertCannotWrite(() => {
        app.getState().pfrz.list[0].v = 99;
      }, "untouched, after another cell's commit");
      // The ROOT of committed state, not only the slices under it. The
      // composed reduce hands back `{ ...fullState, [cell]: nextSlice }` — a
      // FRESH object that Immer never produced and so never froze. Dev's
      // full-tree pass froze it; prod had nothing, so swapping or deleting a
      // whole cell's slice from outside a method succeeded there and threw
      // here — and the swap stuck, surviving the next method.
      assertCannotWrite(() => {
        app.getState().pfrz = {
          a: { n: -1 },
          b: { deep: { m: -1 } },
          list: [],
        };
      }, "a whole slice swapped on the root");
      assertCannotWrite(() => {
        delete app.getState().pfrzo;
      }, "a slice deleted from the root");
      assertCannotWrite(() => {
        app.getState().smuggled = { in: true };
      }, "a new top-level key added to the root");
      // A loaded snapshot — BEFORE any dispatch, and after a commit that did
      // not touch this cell.
      app.loadSnapshot(JSON.stringify({
        pfrz: { a: { n: 5 }, b: { deep: { m: 7 } }, list: [{ v: 3 }] },
        pfrzo: { k: 1 },
      }));
      assertCannotWrite(() => {
        app.getState().pfrz.b.deep.m = 99;
      }, "right after loadSnapshot");
      await other.bump();
      assertCannotWrite(() => {
        app.getState().pfrz.list[0].v = 99;
      }, "after loadSnapshot + another cell's commit");
      assert(app.getState().pfrz.b.deep.m === 7);
    });
  });
}

Deno.test("prod boot: state RESTORED from disk is frozen before any method runs", async () => {
  const dir = await tempDir("aio-prod-frozen-restore-");
  try {
    await withProdApp("prod", async (_app, c) => {
      await c.touchA();
    }, dir);
    await withProdApp("prod", async (app) => {
      assert(app.getState().pfrz.a.n === 1, "the restore must have happened");
      assertCannotWrite(() => {
        app.getState().pfrz.b.deep.m = 99;
      }, "restored slice, before any method");
    }, dir);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("prod boot: the freezeState log line does not claim state is unfrozen", async () => {
  const lines: string[] = [];
  const prev = getLogger();
  const tap = new Proxy(prev ?? {}, {
    get(t, p) {
      if (p === "pub") {
        return (lvl: string, cat: string, m: string, ...rest: unknown[]) => {
          lines.push(m);
          return (t as Any).pub?.(lvl, cat, m, ...rest);
        };
      }
      return Reflect.get(t as object, p);
    },
  });
  setLogger(tap as Any);
  try {
    await withProdApp("prod", async () => {});
  } finally {
    setLogger(prev);
  }
  const line = lines.find((l) => l.startsWith("freezeState:"));
  assert(line, `no freezeState line in:\n${lines.join("\n")}`);
  assertStringIncludes(line, "committed state is frozen in every mode");
});

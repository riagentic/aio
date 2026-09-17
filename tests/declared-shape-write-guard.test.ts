// The declared shape is guarded at the WRITE, not one restart later.
//
// `state:` is the restore template: every declared key is filled back in on
// boot, and a stored key it does not declare under a closed object is drift
// (dev refuses to boot, prod warns and drops it). Two writes break that
// contract silently at every door and fail only after a restart:
//
//  (a) `delete s.key` / `s.key = undefined` of a DECLARED key — the restore
//      refills it, and the boot line called the resurrection "new field(s)".
//  (b) `s.obj.y = …` where `obj` is declared closed (`{ x: 0 }`) — accepted
//      now, refused (dev) or dropped (prod) on the next boot.
//
// Restore semantics are unchanged. The write is made LOUD: one warning per
// (cell, path), identical in dev and prod (observe-only), from one post-commit
// walk over the Immer patches against the declared template. Open shapes —
// a declared `{}` record, an array element, a `null`-declared field — are
// data and never warned about.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { _resetParsedCli } from "../src/server/aio-cli.ts";
import { newFieldsSummary } from "../src/server/aio-boot.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const DELETE_ADVICE =
  "deleting a declared key does not survive a restart — set it to null instead, or remove it from `state:`";

type St = {
  x: number;
  y: number;
  z: number;
  obj: { deep: { deeper: { x: number } } };
  map: Record<string, number>;
  list: { id: number }[];
  user: { name: string } | null;
  cache: { a: number };
};

const _argsDesc = Object.getOwnPropertyDescriptor(Deno, "args")!;
function setMode(mode: "dev" | "prod"): void {
  Object.defineProperty(Deno, "args", {
    value: mode === "prod" ? ["--prod"] : [],
    configurable: true,
    enumerable: true,
  });
  _resetParsedCli();
}

type Calls = Record<
  "delX" | "undefY" | "addDeeper" | "openWrites" | "replaceDeep",
  () => Promise<unknown>
>;

async function withApp(
  mode: "dev" | "prod",
  fn: (m: Calls) => Promise<void>,
): Promise<string[]> {
  const dir = await tempDir("aio-shape-guard-");
  setMode(mode);
  _resetAioRuntime();
  const g = cell("shapeguard", {
    state: {
      x: 1,
      y: 1,
      z: 1,
      obj: { deep: { deeper: { x: 0 } } },
      map: {} as Record<string, number>,
      list: [] as { id: number }[],
      user: null as { name: string } | null,
      cache: { a: 0 },
    } as St,
    persist: { exclude: ["cache"] },
    methods: {
      delX(s: St) {
        delete (s as Partial<St>).x;
      },
      undefY(s: St) {
        (s as Partial<St>).y = undefined;
      },
      addDeeper(s: St) {
        (s.obj.deep.deeper as Record<string, number>).y = 1;
      },
      openWrites(s: St) {
        s.map.k = 1;
        s.list.push({ id: 1 });
        (s.list[0] as Record<string, number>).extra = 2;
        s.user = { name: "ada" };
        (s.user as Record<string, unknown>).extra = true;
        (s.cache as Record<string, number>).b = 1;
        delete (s.map as Record<string, number>).k;
      },
      replaceDeep(s: St) {
        s.obj.deep = { deeper: { x: 1, w: 2 } } as St["obj"]["deep"];
      },
    },
  });
  const warned: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => warned.push(a.map(String).join(" "));
  try {
    const app = await aio.run({
      cells: [g],
      appId: `shape-guard-${mode}`,
      client: "server-only",
      libraryMode: true,
      port: freePort(),
      dbPath: join(dir, "state.db"),
      baseDir: dir,
      persistDebounceMs: 10,
    });
    try {
      await fn(g as unknown as Calls);
    } finally {
      await app.close();
    }
  } finally {
    console.warn = orig;
    Object.defineProperty(Deno, "args", _argsDesc);
    _resetParsedCli();
    _resetAioRuntime();
    await dropTempDir(dir);
  }
  return warned.filter((l) => l.includes("shapeguard"));
}

for (const mode of ["dev", "prod"] as const) {
  Deno.test(`declared-shape guard (${mode}): deleting a declared key warns once, with the advice`, async () => {
    const w = await withApp(mode, async (m) => {
      await m.delX();
      await m.delX(); // same path again — already said
      await m.undefY();
    });
    const del = w.filter((l) => l.includes(DELETE_ADVICE));
    assertEquals(del.length, 2, w.join("\n"));
    // One fact, one line: the dev persist-time watcher does not repeat it.
    assertEquals(w.length, del.length, w.join("\n"));
    assert(del[0]!.includes("shapeguard.x"), del[0]);
    assert(del[0]!.includes("shapeguard:delX"), del[0]);
    assert(del[1]!.includes("shapeguard.y"), del[1]);
  });

  Deno.test(`declared-shape guard (${mode}): adding a key under a closed declared object warns once`, async () => {
    const w = await withApp(mode, async (m) => {
      await m.addDeeper();
      await m.addDeeper();
      await m.replaceDeep();
    });
    const add = w.filter((l) => l.includes("does not declare"));
    assertEquals(add.length, 2, w.join("\n"));
    assertEquals(w.length, add.length, w.join("\n"));
    assert(add[0]!.includes("shapeguard.obj.deep.deeper.y"), add[0]);
    assert(add[0]!.includes("shapeguard:addDeeper"), add[0]);
    assert(add[0]!.includes("declare it in `state:`"), add[0]);
    assert(add[0]!.includes("keep it out of state"), add[0]);
    // A replaced subtree carrying an undeclared key is the same failure.
    assert(add[1]!.includes("shapeguard.obj.deep.deeper.w"), add[1]);
  });

  Deno.test(`declared-shape guard (${mode}): open shapes and excluded fields are data — nothing said`, async () => {
    const w = await withApp(mode, async (m) => {
      await m.openWrites();
    });
    assertEquals(w, []);
  });
}

Deno.test("boot line: a refilled declared key is not called a NEW field", () => {
  const line = newFieldsSummary([
    { cell: "cfg", path: "retries", declaredType: "number" },
  ]);
  assert(!line.includes("new field(s)"), line);
  assert(line.includes("deleted"), line);
  assert(line.includes("cfg.retries (number)"), line);
});

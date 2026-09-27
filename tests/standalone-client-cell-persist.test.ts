// A `scope: "client"` cell is never persisted — on the standalone runtime too.
//
// docs/state/cell-contexts.md: "`scope: \"client\"` is never persisted at
// all" — the server skips client cells at compose time (aio-composition.ts),
// so nothing of theirs is ever written or read back. The standalone runtime
// (the APK, bootCells/testUI) composes them like any cell, and the persist
// decider counted them: every change wrote the client cell's stale declared
// slice, and the boot restore merged a stored one back and pushed it into the
// cell's own signal. The same app restored a client cell only once packaged.
import { assert, assertEquals } from "@std/assert";
import { _reset, aio, cell } from "../src/standalone-air.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";
import { composeCells } from "../src/state/cell-compose.ts";
import {
  buildDBStateGetter,
  persistingCellIds,
} from "../src/state/cell-persist-filter.ts";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  },
  configurable: true,
  writable: true,
});

/** Run `fn` with the boot's `[aio] persistence: …` line (and the carried-slice
 *  note) kept off the test output — collected, so a test can assert on it. */
async function quiet(fn: (infos: string[]) => Promise<void>): Promise<void> {
  const info = console.info;
  const infos: string[] = [];
  console.info = (...a: unknown[]) => void infos.push(a.join(" "));
  storage.clear();
  _reset();
  try {
    await fn(infos);
  } finally {
    console.info = info;
    _reset();
    _resetAioRuntime();
  }
}

Deno.test('persist decider: a scope:"client" cell is not a persisting cell', () => {
  const prefs = cell("sccpDecPrefs", {
    scope: "client",
    state: { theme: "light" },
    methods: {},
  });
  const kept = cell("sccpDecKept", { state: { n: 0 }, methods: {} });
  const composed = composeCells([prefs, kept], { appId: "sccpDec" });
  assertEquals([...persistingCellIds(composed)], ["sccpDecKept"]);
  assertEquals(buildDBStateGetter(composed)(composed.initialState), {
    sccpDecKept: { n: 0 },
  });
});

Deno.test('standalone: a scope:"client" cell is never restored from the store', async () => {
  await quiet(async (infos) => {
    // A stored slice under the client cell's name — written by an earlier
    // build (this runtime used to persist client cells), or an older build
    // where the cell was server-scoped.
    storage.set(
      "aio:sccp1",
      JSON.stringify({ sccpPrefs: { theme: "dark" }, __versions: {} }),
    );
    const prefs = cell("sccpPrefs", {
      scope: "client",
      state: { theme: "light" },
      methods: {
        setTheme(s, t: string) {
          s.theme = t;
        },
      },
    });
    const kept = cell("sccpKept", {
      state: { n: 0 },
      methods: {
        inc(s) {
          s.n++;
        },
      },
    });
    const app = await aio.run({ appId: "sccp1", cells: [prefs, kept] });
    try {
      // The browser/server runtime starts a client cell from its declaration.
      assertEquals(prefs.theme, "light");
      assert(
        infos.some((l) => l.includes('"sccpPrefs"') && l.includes("client")),
        `the carried slice is said at boot: ${infos.join(" | ")}`,
      );
      await kept.inc();
    } finally {
      await app.close();
    }
    // …and the stored slice is not destroyed: carried through every write
    // untouched, like a slice no declared cell owns (the server's rule).
    const doc = JSON.parse(storage.get("aio:sccp1")!) as Record<
      string,
      unknown
    >;
    assertEquals(doc.sccpPrefs, { theme: "dark" });
    assertEquals(doc.sccpKept, { n: 1 });
  });
});

Deno.test('standalone: a scope:"client" cell never reaches the store', async () => {
  await quiet(async () => {
    const prefs = cell("sccpPrefs2", {
      scope: "client",
      state: { theme: "light" },
      methods: {
        setTheme(s, t: string) {
          s.theme = t;
        },
      },
    });
    const kept = cell("sccpKept2", {
      state: { n: 0 },
      methods: {
        inc(s) {
          s.n++;
        },
      },
    });
    const app = await aio.run({ appId: "sccp2", cells: [prefs, kept] });
    await prefs.setTheme("dark");
    await kept.inc();
    // A server-cell commit must not reset the client cell either.
    assertEquals(prefs.theme, "dark");
    await app.close();
    const raw = storage.get("aio:sccp2");
    assert(raw, "the persisting cell was written");
    const doc = JSON.parse(raw) as Record<string, unknown>;
    assertEquals((doc.sccpKept2 as { n: number }).n, 1);
    assertEquals("sccpPrefs2" in doc, false, `client cell stored: ${raw}`);
    assertEquals(
      "sccpPrefs2" in (doc.__versions as Record<string, unknown>),
      false,
    );
  });
});

Deno.test('standalone: a versioned scope:"client" cell gets no version stamp or migration', async () => {
  await quiet(async () => {
    let migrated = 0;
    storage.set(
      "aio:sccp3",
      JSON.stringify({ sccpPrefs3: { old: 1 }, __versions: {} }),
    );
    const prefs = cell("sccpPrefs3", {
      scope: "client",
      version: 2,
      onMigrate: (s) => {
        migrated++;
        return s;
      },
      state: { theme: "light" },
      methods: {},
    });
    const kept = cell("sccpKept3", {
      state: { n: 0 },
      methods: {
        inc(s) {
          s.n++;
        },
      },
    });
    const app = await aio.run({ appId: "sccp3", cells: [prefs, kept] });
    await kept.inc();
    await app.close();
    assertEquals(migrated, 0);
    const doc = JSON.parse(storage.get("aio:sccp3")!) as Record<
      string,
      unknown
    >;
    assertEquals(doc.__versions, {});
    assertEquals(doc.sccpPrefs3, { old: 1 });
  });
});

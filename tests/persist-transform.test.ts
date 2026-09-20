// `persist: { transform }` — shaping what goes OUT, not only repairing what
// comes back.
//
// aio let you repair a restore (`onRestore`) and not shape a write (report 9 §8.4).
// The reporter got lucky — their fat field was dead weight, so an `exclude`
// covered it — and said plainly that had the field been needed ON SCREEN, the
// only move left was a second mirrored cell kept in sync by hand.
//
// `transform` and `onRestore` are a PAIR, read in that order: transform
// decides the on-disk shape, onRestore turns it back into live state.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { freePort } from "../src/testing/server-test.ts";

// deno-lint-ignore no-explicit-any
type D = any;

Deno.test("onPersist is a known cell key, and `persist` is untouched", () => {
  // ADDITIVE BY CONSTRUCTION. Widening `persist` to carry the callback was the
  // first shape of this change and check:api refused it: a caller who reads
  // `MethodsCellConfig["persist"]` and assigns it to a `CellFieldFilter` would
  // stop compiling, and aio's surface promise has no exceptions. `onPersist`
  // adds a key and moves nothing — and it pairs by NAME with `onRestore`,
  // which is what the shape should have been all along.
  const c = cell("onpersistkey", {
    state: { a: 1, b: 2 },
    persist: { exclude: ["b"] },
    onPersist: (s: { a: number }) => ({ a: s.a }),
    methods: {},
  } as D);
  assertEquals(
    (c as D).__aio.persist,
    { exclude: ["b"] },
    "the filter is unchanged",
  );
  assertEquals(typeof (c as D).__aio.persistTransform, "function");

  // A cell with neither carries neither — the hook costs nothing to anyone
  // who does not use it.
  const plain = cell("onpersistnone", { state: { a: 1 }, methods: {} } as D);
  assertEquals((plain as D).__aio.persistTransform, undefined);

  // …and a typo is still refused, so adding a key did not make the validator
  // permissive.
  let threw = "";
  try {
    cell("onpersisttypo", {
      state: { a: 1 },
      onPersistt: (s: D) => s,
      methods: {},
    } as D);
  } catch (e) {
    threw = e instanceof Error ? e.message : String(e);
  }
  assert(
    threw.includes("onPersistt"),
    `a typo must still be refused: ${threw}`,
  );
});

Deno.test("a sync cell refuses onPersist, and the message says TRANSFORM", () => {
  // Already refused by the existing rule (a transform is not `"all"`), and the
  // message had to learn the word — saying "include: " for a transform names a
  // filter the author never wrote, so it reads as being about someone else's
  // cell.
  const e = assertThrows(() =>
    cell("synctransform", {
      state: { n: 0 },
      sync: true,
      onPersist: (s: Record<string, unknown>) => s,
      methods: {},
    } as D)
  );
  const msg = String(e);
  assert(msg.includes("transform"), `it must name what is in the file: ${msg}`);
  assert(!msg.includes("include:"), `it must not invent a filter: ${msg}`);
  assert(msg.includes("op-log"), "…and still explain why");
});

Deno.test("a throwing transform is LOUD, and /health says the write failed", async () => {
  // On the persist path, "the write quietly stopped happening" is the worst
  // outcome aio has: the app keeps running on state that is not on disk, and
  // finds out at the next boot. So the transform's throw is re-thrown with the
  // cell named, and the persistence layer reports it like any failed write.
  const dir = await tempDir("persist-transform-throw-");
  const port = freePort();
  const bad = cell("badtf", {
    state: { n: 0 },
    onPersist: () => {
      throw new Error("boom from the app");
    },
    methods: {
      inc(s: { n: number }) {
        s.n++;
      },
    },
  } as D);
  const app = await aio.run({
    cells: [bad],
    appId: `persisttf-throw-${Deno.pid}`,
    client: "server-only",
    libraryMode: true,
    singleton: false,
    port,
    baseDir: dir,
  } as D);
  try {
    await (bad as D).inc();
    await new Promise((r) => setTimeout(r, 300));
    const h = await (await fetch(`http://127.0.0.1:${port}/__aio/health`))
      .json() as { status: string; persist: { ok: boolean; error?: string } };
    assertEquals(
      h.persist.ok,
      false,
      "a transform that throws must surface as a FAILED WRITE — silently " +
        "skipping the cell is the outcome this whole path exists to prevent",
    );
    assert(
      (h.persist.error ?? "").includes("badtf"),
      `the cell must be named: ${h.persist.error}`,
    );
    assertEquals(h.status, "degraded");
  } finally {
    await app.close();
    await dropTempDir(dir);
  }
});

Deno.test("end to end: the shaped slice is what reaches disk, and onRestore reads it back", async () => {
  const dir = await tempDir("persist-transform-");
  const port = freePort();
  // A big decoded blob in live state; a key on disk. The exact shape the
  // report could not express.
  const photos = cell("photos", {
    state: { blob: "", key: "", restoredFrom: "" },
    persist: { exclude: ["restoredFrom"] },
    // 40 MB in memory, 200 bytes on disk.
    onPersist: (s: { blob: string; key: string }) => ({ key: s.key }),
    // ONE argument: the already-restored state. `onRestore` REPAIRS what came
    // back; it does not receive the raw row.
    onRestore: (s: D) => {
      s.blob = ""; // re-fetched from the key, never stored
      s.restoredFrom = s.key ?? "";
    },
    methods: {
      load(s: { blob: string; key: string }, key: string) {
        s.key = key;
        s.blob = "X".repeat(5000);
      },
    },
  } as D);
  const appId = `persisttf-${Deno.pid}`;
  const app = await aio.run({
    cells: [photos],
    appId,
    client: "server-only",
    libraryMode: true,
    singleton: false,
    port,
    baseDir: dir,
  } as D);
  try {
    await (photos as D).load("k-123");
    assertEquals((app.getState() as D).photos.blob.length, 5000);
  } finally {
    await app.close();
  }

  // What actually landed.
  const port2 = freePort();
  const app2 = await aio.run({
    cells: [photos],
    appId,
    client: "server-only",
    libraryMode: true,
    singleton: false,
    port: port2,
    baseDir: dir,
  } as D);
  try {
    const s = (app2.getState() as D).photos;
    assertEquals(s.key, "k-123", "the shaped field survived the round trip");
    assertEquals(
      s.blob,
      "",
      "the 5000-char blob must NOT be on disk — shaping it away is the whole feature",
    );
    assertEquals(
      s.restoredFrom,
      "k-123",
      "onRestore read the shape the transform wrote — the two are a pair",
    );
  } finally {
    await app2.close();
    await dropTempDir(dir);
  }
});

// The documented RESHAPE pair (`cell-config-types.ts`): `onPersist` writes a
// key the cell does not declare, `onRestore` reads it. The restore merge
// pruned `key` before the hook ran, so the value was gone: dev refused to
// boot over "shape drift", prod booted with `thumbKey: ""`. The hook is now
// handed what the store holds, and the result is narrowed to the declared
// shape — no `key` in live state.
Deno.test("end to end: a RESHAPING onPersist round-trips through its onRestore partner", async () => {
  const dir = await tempDir("persist-transform-reshape-");
  const mk = () =>
    cell("thumbs", {
      state: { thumbKey: "", thumb: "" },
      onPersist: (s: { thumbKey: string }) => ({ key: s.thumbKey }),
      onRestore: (s: D) => {
        s.thumbKey = s.key ?? "";
        s.thumb = `T(${s.key})`;
      },
      methods: {
        set(s: { thumbKey: string; thumb: string }, k: string) {
          s.thumbKey = k;
          s.thumb = `LIVE(${k})`;
        },
      },
    } as D);
  const appId = `persisttf-reshape-${Deno.pid}`;
  const boot = (c: unknown) =>
    aio.run({
      cells: [c],
      appId,
      client: "server-only",
      libraryMode: true,
      singleton: false,
      port: freePort(),
      baseDir: dir,
    } as D);
  try {
    const first = mk();
    const app = await boot(first);
    try {
      await (first as D).set("k-9");
    } finally {
      await app.close();
    }
    const app2 = await boot(mk());
    try {
      assertEquals((app2.getState() as D).thumbs, {
        thumbKey: "k-9",
        thumb: "T(k-9)",
      });
    } finally {
      await app2.close();
    }
  } finally {
    await dropTempDir(dir);
  }
});

// A shape that changes a field's type (a record stored as a list) restores
// through its onRestore — also on the boot that first stamps a `version:`,
// which converts nothing: the slice is still the store's, not a migration's.
Deno.test("end to end: a type-changing shape restores on the boot that first stamps a version", async () => {
  const dir = await tempDir("persist-transform-retype-stamp-");
  const mk = (version: number) =>
    cell("recs", {
      version,
      state: { items: {} as Record<string, { id: string }> },
      onPersist: (s: D) => ({ items: Object.values(s.items) }),
      onRestore: (s: D) => {
        if (Array.isArray(s.items)) {
          s.items = Object.fromEntries(s.items.map((i: D) => [i.id, i]));
        }
      },
      methods: {
        add(s: D, id: string) {
          s.items[id] = { id };
        },
      },
    } as D);
  const appId = `persisttf-retype-stamp-${Deno.pid}`;
  const boot = (c: unknown) =>
    aio.run({
      cells: [c],
      appId,
      client: "server-only",
      libraryMode: true,
      singleton: false,
      port: freePort(),
      baseDir: dir,
    } as D);
  try {
    const first = mk(0);
    const app = await boot(first);
    try {
      await (first as D).add("a");
    } finally {
      await app.close();
    }
    const app2 = await boot(mk(1));
    try {
      assertEquals((app2.getState() as D).recs, { items: { a: { id: "a" } } });
    } finally {
      await app2.close();
    }
  } finally {
    await dropTempDir(dir);
  }
});

// A shape is not a licence to drift. `onPersist: ({ cache, ...rest }) => rest`
// — the commonest shape there is — writes every other top-level key, and the
// drift gate exempted any stored path under a key the shape writes: a nested
// field renamed without a version bump (`settings.old`) booted in dev with the
// stored value silently pruned, where the same cell without `onPersist`
// refuses. A shaped cell's stored slice is read against what its `onPersist`
// writes for the declared state — the shape — not exempted from the check.
Deno.test("end to end: a shaped cell's nested drift is still refused in dev", async () => {
  const dir = await tempDir("persist-transform-nested-drift-");
  const appId = `persisttf-nested-drift-${Deno.pid}`;
  const mk = (state: D) =>
    cell("s", {
      state,
      onPersist: ({ cache: _c, ...rest }: D) => rest,
      methods: {
        set(s: D) {
          s.settings.old = "x";
          s.cache = 5;
        },
      },
    } as D);
  const boot = (c: unknown) =>
    aio.run({
      cells: [c],
      appId,
      client: "server-only",
      libraryMode: true,
      singleton: false,
      port: freePort(),
      baseDir: dir,
    } as D);
  try {
    const first = mk({ settings: { theme: "light", old: "" }, cache: 0 });
    const app = await boot(first);
    try {
      await (first as D).set();
    } finally {
      await app.close();
    }
    let refused = "";
    try {
      const app2 = await boot(mk({ settings: { theme: "light" }, cache: 0 }));
      await app2.close();
    } catch (e) {
      refused = e instanceof Error ? e.message : String(e);
    }
    assert(
      refused.includes("settings.old"),
      `the renamed nested field must be refused as drift: ${refused}`,
    );
  } finally {
    await dropTempDir(dir);
  }
});

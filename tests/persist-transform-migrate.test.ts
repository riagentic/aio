// A cell whose `onPersist` changes a field's TYPE, and which also migrates.
//
// `onPersist: (s) => ({ items: Object.values(s.items) })` stores a list where
// the cell declares a record; its `onRestore` turns the list back. On the boot
// that migrated such a cell, the migration's output was narrowed to the
// DECLARED shape — so the list it returned (the stored form, which is what it
// was handed) became the declared `{}`, and onRestore had nothing left to
// turn back: every item gone, on the one boot that must not lose data. The
// hook was not even handed the list (only the declared `{}`), so a migration
// that maps over the stored list threw and refused the boot.
//
// The migration's output is read against what the cell STORES (its shape) as
// well as what it declares, and onRestore is handed it the way it is handed a
// stored slice on every other boot.
import { assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { freePort } from "../src/testing/server-test.ts";

// deno-lint-ignore no-explicit-any
type D = any;

const toRecord = (s: D) => {
  if (Array.isArray(s.items)) {
    s.items = Object.fromEntries(s.items.map((i: D) => [i.id, i]));
  }
};

const mk = (version: number, onMigrate?: (s: D, from: number) => D) =>
  cell("recs", {
    version,
    state: { items: {} as Record<string, { id: string; tag?: string }> },
    onPersist: (s: D) => ({ items: Object.values(s.items) }),
    onRestore: toRecord,
    ...(onMigrate ? { onMigrate } : {}),
    methods: {
      add(s: D, id: string) {
        s.items[id] = { id };
      },
    },
  } as D);

async function upgrade(
  name: string,
  onMigrate: (s: D, from: number) => D,
): Promise<unknown> {
  const dir = await tempDir(`persist-transform-migrate-${name}-`);
  const appId = `persisttf-migrate-${name}-${Deno.pid}`;
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
    const first = mk(1);
    const app = await boot(first);
    try {
      await (first as D).add("a");
    } finally {
      await app.close();
    }
    const app2 = await boot(mk(2, onMigrate));
    try {
      return (app2.getState() as D).recs;
    } finally {
      await app2.close();
    }
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("migrate: a type-changing shape's list survives an identity onMigrate", async () => {
  assertEquals(await upgrade("identity", (s) => s), {
    items: { a: { id: "a" } },
  });
});

Deno.test("migrate: onMigrate is handed the STORED list, and its list output reaches onRestore", async () => {
  assertEquals(
    await upgrade("map", (s) => {
      s.items = s.items.map((i: D) => ({ ...i, tag: "v2" }));
      return s;
    }),
    { items: { a: { id: "a", tag: "v2" } } },
  );
});

Deno.test("migrate: an onMigrate that returns the runtime shape itself is kept", async () => {
  assertEquals(
    await upgrade("record", (s) => {
      toRecord(s);
      return s;
    }),
    { items: { a: { id: "a" } } },
  );
});

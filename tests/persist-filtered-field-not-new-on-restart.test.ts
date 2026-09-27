// A field a cell does not PERSIST is never in the stored data, by design. The
// boot's "declared field(s) not in the stored data" walk read that as news, so
// every restart of every app with `updates` configured said the built-in
// cell's twelve unpersisted fields were "new in this build, or a method deleted
// it" (measured on a real Windows install, the first boot after an update).
// A field that IS new must still be said.

import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const inc = () =>
  cell("inc", {
    state: { kept: 0, draft: "", status: "idle" },
    persist: { include: ["kept"] },
    methods: {
      bump(s) {
        s.kept += 1;
      },
    },
  });
// The next build: one more PERSISTED field.
const incAdded = () =>
  cell("inc", {
    state: { kept: 0, draft: "", status: "idle", added: 0 },
    persist: { include: ["kept", "added"] },
    methods: {},
  });
const exc = () =>
  cell("exc", {
    state: { n: 0, ui: { open: false, tab: "a" } },
    persist: { exclude: ["ui.open"] },
    methods: {
      bump(s) {
        s.n += 1;
      },
    },
  });

Deno.test("persist: fields a cell never persists are not reported as new on restart — a new one still is", async () => {
  const dir = await tempDir("persist-filter-not-new-");
  const said: string[] = [];
  const orig = { log: console.log, info: console.info };
  const spy = (...a: unknown[]) => said.push(a.map(String).join(" "));
  // deno-lint-ignore no-explicit-any
  const boot = (cells: any[]) =>
    aio.run({
      cells,
      appId: "persist-filter-not-new",
      client: "server-only",
      libraryMode: true,
      port: freePort(),
      dbPath: join(dir, "state.db"),
      baseDir: dir,
      persistDebounceMs: 10,
    });
  // deno-lint-ignore no-explicit-any
  const restart = async (cells: any[]) => {
    said.length = 0;
    console.log = spy;
    console.info = spy;
    try {
      return await boot(cells);
    } finally {
      console.log = orig.log;
      console.info = orig.info;
    }
  };
  try {
    const [i1, e1] = [inc(), exc()];
    let app = await boot([i1, e1]);
    try {
      await i1.bump();
      await e1.bump();
    } finally {
      await app.close();
    }

    app = await restart([inc(), exc()]);
    try {
      const st = app.getState() as {
        inc: { kept: number };
        exc: { n: number };
      };
      assertEquals(st.inc.kept, 1, "the restart restored — the premise");
      assertEquals(st.exc.n, 1);
      assert(said.length > 0, "the boot logged nothing — spy not wired");
      assertEquals(
        said.filter((l) => l.includes("not in the stored data")),
        [],
      );
    } finally {
      await app.close();
    }

    // The note is not simply gone: a persisted field that IS new is said.
    app = await restart([incAdded(), exc()]);
    try {
      const lines = said.filter((l) => l.includes("not in the stored data"));
      assertEquals(lines.length, 1, said.join("\n"));
      assert(lines[0]!.includes("inc.added"), lines[0]);
      assert(!lines[0]!.includes("draft"), lines[0]);
      assert(!lines[0]!.includes("ui.open"), lines[0]);
    } finally {
      await app.close();
    }
  } finally {
    await dropTempDir(dir);
  }
});

// A `listensTo` pair across the `sync` line is SUPPORTED (journal.ts J6/J7 —
// see sync-listens-cross-boot.test.ts), but the two cells then run on two
// different paths, and nothing said so. Boot says it now: ONE warn line per
// pair, naming both cells and which one syncs — through `aio.run` (testServer)
// and the in-process harnesses (bootCells) alike. Silent when they agree.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { syncListensMismatches } from "../src/server/aio-cells-bridge.ts";

function defineCells(tag: string) {
  const notes = cell(`notes${tag}`, {
    version: 1,
    sync: true,
    state: { items: [] as string[] },
    methods: {
      add(s: { items: string[] }, t: string) {
        s.items.push(t);
      },
      drop(s: { items: string[] }) {
        s.items.pop();
      },
    },
  });
  // Plain listener of a sync source — TWO of its actions: still one line.
  const tally = cell(`tally${tag}`, {
    state: { n: 0 },
    methods: {
      onAdd(s: { n: number }) {
        s.n++;
      },
      onDrop(s: { n: number }) {
        s.n--;
      },
    },
    listensTo: { onAdd: notes.add, onDrop: notes.drop },
  });
  const inbox = cell(`inbox${tag}`, {
    state: { posts: 0 },
    methods: {
      post(s: { posts: number }) {
        s.posts++;
      },
    },
  });
  // Sync listener of a plain source.
  const feed = cell(`feed${tag}`, {
    version: 1,
    sync: true,
    state: { seen: 0 },
    methods: {
      onPost(s: { seen: number }) {
        s.seen++;
      },
    },
    listensTo: { onPost: inbox.post },
  });
  // Agreeing pairs — silent: sync ← sync, plain ← plain.
  const mirror = cell(`mirror${tag}`, {
    version: 1,
    sync: true,
    state: { got: 0 },
    methods: {
      onAdd(s: { got: number }) {
        s.got++;
      },
    },
    listensTo: { onAdd: notes.add },
  });
  const audit = cell(`audit${tag}`, {
    state: { posts: 0 },
    methods: {
      onPost(s: { posts: number }) {
        s.posts++;
      },
    },
    listensTo: { onPost: inbox.post },
  });
  return { notes, tally, inbox, feed, mirror, audit };
}

async function captureWarns(fn: () => Promise<void>): Promise<string[]> {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    console.warn = orig;
  }
  return warns.filter((w) => w.includes("listensTo:"));
}

function assertPairs(lines: string[], tag: string): void {
  assertEquals(lines.length, 2, lines.join("\n"));
  const plain = lines.filter((l) =>
    l.includes(`"tally${tag}" (not sync) listens to "notes${tag}" (sync: true)`)
  );
  const sync = lines.filter((l) =>
    l.includes(`"feed${tag}" (sync: true) listens to "inbox${tag}" (not sync)`)
  );
  assertEquals(plain.length, 1, "the plain←sync pair is said exactly once");
  assertEquals(sync.length, 1, "the sync←plain pair is said exactly once");
  assert(plain[0]!.includes("lags"), plain[0]);
  assert(sync[0]!.includes("server write"), sync[0]);
  for (const quiet of ["mirror", "audit"]) {
    assert(
      !lines.some((l) => l.includes(`"${quiet}${tag}"`)),
      `${quiet}: an agreeing pair is silent`,
    );
  }
}

Deno.test("syncListensMismatches: one line per mismatched pair, none for agreeing pairs", () => {
  const c = defineCells("P");
  assertPairs(syncListensMismatches(Object.values(c)), "P");
  assertEquals(
    syncListensMismatches([c.notes, c.mirror, c.inbox, c.audit]),
    [],
  );
});

Deno.test("aio.run (testServer) warns once per mismatched pair at boot", async () => {
  const c = defineCells("S");
  const lines = await captureWarns(async () => {
    const srv = await testServer({ cells: Object.values(c) });
    await srv.close();
  });
  assertPairs(lines, "S");
});

Deno.test("bootCells says the same line as aio.run — and nothing when all agree", async () => {
  const c = defineCells("B");
  const lines = await captureWarns(async () => {
    const h = await bootCells(Object.values(c));
    h.dispose();
  });
  assertPairs(lines, "B");
  const q = defineCells("Q");
  const quiet = await captureWarns(async () => {
    const h = await bootCells([q.notes, q.mirror, q.inbox, q.audit]);
    h.dispose();
  });
  assertEquals(quiet, []);
});

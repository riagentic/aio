// A closed app is garbage — its scope, its state, its config, its logger.
//
// Hosts and test files boot apps repeatedly in ONE process. Measured on
// v1.0.11: 0 of 20 (and 0 of 80) closed apps' scopes were ever finalized, and
// the post-gc() data heap grew ~110 KB per boot/close cycle, for good. Two
// retainers, both process-wide and both reached from every app:
//
//  1. the cell def. `cell()` registers it process-wide, and `bindCell` left
//     the closed app's dispatch/getState closures on it — so the def (alive
//     for the life of the process) held the whole app. Released at close by
//     re-binding it to a tombstone that answers as the closed app did.
//  2. the diagnostic bus. Each app's `initDiagnostics` subscribed a bridge to
//     the logger and never unsubscribed; the subscription closes over that
//     instance's checkpoint view and health getter — i.e. the app's config.
//
// The measurement runs in a CHILD with a real `gc()` (tests/memory.test.ts
// explains why it cannot be this process). What stays per cycle after the
// fix is keyed by the app's IDENTITY, on purpose: the resolved dirs of every
// appId booted in the process (`app-dirs`), and one blob store per directory.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const N = 30;
/** Post-gc() data heap per cycle. Before the fix: ~110 KB. After: ~15 KB,
 *  the per-appId registries above (every cycle is a new appId). */
const MAX_PER_CYCLE = 40_000;

async function probe(): Promise<
  { n: number; finalized: number; perCycle: number }
> {
  const root = await tempDir("aio-gc-scope-");
  try {
    for (const d of ["apps", "run", "versions", "apps-root"]) {
      await Deno.mkdir(`${root}/${d}`, { recursive: true, mode: 0o700 });
    }
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--v8-flags=--expose-gc",
        "--config",
        new URL("../deno.json", import.meta.url).pathname,
        new URL("./fixtures/closed-app-gc/probe.ts", import.meta.url).pathname,
        String(N),
        `${root}/apps-root`,
      ],
      env: {
        AIO_APPS_DIR: `${root}/apps`,
        XDG_RUNTIME_DIR: `${root}/run`,
        AIO_VERSIONS_DIR: `${root}/versions`,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout);
    const line = text.split("\n").find((l) => l.startsWith("RESULT "));
    assert(
      out.success && line,
      `probe exited ${out.code}:\n` +
        new TextDecoder().decode(out.stderr).slice(-3000) + text.slice(-2000),
    );
    return JSON.parse(line.slice(7));
  } finally {
    await dropTempDir(root);
  }
}

Deno.test({
  name:
    "closed apps are collected: most scopes finalize, heap per cycle bounded",
  // The child's servers and sockets are its own; this process only waits.
  sanitizeResources: false, // aio-ok: the child owns its servers and sockets; this process only waits
  async fn() {
    const r = await probe();
    // The newest app, and an app the process pins at most once, may stay.
    assert(
      r.finalized >= N - 3,
      `only ${r.finalized} of ${N} closed app scopes were collected`,
    );
    assert(
      r.perCycle < MAX_PER_CYCLE,
      `the heap grew ${Math.round(r.perCycle)} B per boot/close cycle ` +
        `(ceiling ${MAX_PER_CYCLE}) — a closed app is being kept`,
    );
  },
});

// The release must not change what a closed app's cell DOES — only what it
// keeps. Same rejection, same state reads, and the def binds to the next app.
Deno.test("a closed app's cell answers as before, and binds to the next app", async () => {
  const c = cell("tomb", {
    state: { n: 0 },
    methods: {
      inc(s: { n: number }) {
        s.n++;
      },
    },
    selectors: { twice: (s: { n: number }) => s.n * 2 },
  });
  const m = c as unknown as {
    inc(): Promise<unknown>;
    n: number;
    twice(): number;
  };
  const boot = async (dir: string) =>
    await aio.run({
      cells: [c],
      appId: `tomb-${crypto.randomUUID().slice(0, 8)}`,
      appDir: dir,
      client: "server-only",
      libraryMode: true,
      singleton: false,
      persist: false,
      port: freePort(),
    } as never) as unknown as { close(): Promise<void> };
  const dir = await tempDir("aio-tomb-");
  try {
    const a = await boot(`${dir}/a`);
    await m.inc();
    assertEquals([m.n, m.twice()], [1, 2]);
    await a.close();
    // Closed: the state it ended with (destroy reset it to the declared
    // one — a worker cell keeps its own: closed-app-cells-answer-as-before),
    // and a call is refused, not lost
    // silently — the error the closed app itself gave.
    assertEquals([m.n, m.twice()], [0, 0]);
    const err = await assertRejects(() => m.inc());
    assertEquals(
      (err as Error).message,
      "dispatch after close() — action dropped, not applied",
    );
    assertEquals((err as { code?: string }).code, "DISPATCH_CLOSED");
    // …and the def is free: the next app binds it and it works.
    const b = await boot(`${dir}/b`);
    try {
      await m.inc();
      assertEquals(m.n, 1);
    } finally {
      await b.close();
    }
  } finally {
    await dropTempDir(dir);
  }
});

// A rollback must not destroy data, and a roll-forward must not migrate twice.
//
// Two proven data-loss bugs, both invisible while they happened:
//
// 1. The persistence manager stamped the RUNNING build's `cellVersions` after
//    every commit — including on a boot it had just classified as a DOWNGRADE.
//    So rolling back re-stamped v2 → v1, and rolling forward then saw an
//    "upgrade" that wasn't one: `onMigrate` ran a SECOND time over
//    already-migrated data (a cents→dollars migration applied twice → balance
//    zeroed), with no warning on that step at all. The downgrade boot also
//    persisted a `deepMerge`-narrowed slice over the newer shape, while the
//    warning claimed "State kept as-is".
//
// 2. A throwing `onMigrate` reset the cell to `initialState` and carried on —
//    and ~5ms later the debounced persist wrote that empty slice over the
//    stored data, so a FIXED build found nothing left to migrate.
//
// Each phase is a real process, because a rollback IS a different process.
import { assert, assertEquals } from "@std/assert";
// @ts-ignore node:sqlite types unavailable when an old @types/node shadows them
import { DatabaseSync } from "node:sqlite";
import { join } from "@std/path";

const REPO = new URL("..", import.meta.url).pathname;
const MOD = new URL("../mod.ts", import.meta.url).href;

function freePort(): number {
  const l = Deno.listen({ port: 0 });
  const port = (l.addr as Deno.NetAddr).port;
  l.close();
  return port;
}

/** Run one "build" of an app against `dir` and return what it printed. */
async function phase(
  dir: string,
  appId: string,
  body: string,
  args: string[] = [],
): Promise<{ code: number; out: string; err: string }> {
  const file = join(dir, `phase-${crypto.randomUUID().slice(0, 8)}.ts`);
  await Deno.writeTextFile(
    file,
    `import { aio, cell } from ${JSON.stringify(MOD)};
const APP_ID = ${JSON.stringify(appId)};
const DIR = ${JSON.stringify(dir)};
const PORT = ${freePort()};
${body}
`,
  );
  const p = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", join(REPO, "deno.json"), file, ...args],
    env: { AIO_APPS_DIR: dir, NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
  });
  const { code, stdout, stderr } = await p.output();
  return {
    code,
    out: new TextDecoder().decode(stdout),
    err: new TextDecoder().decode(stderr),
  };
}

const BOOT = (extra = "") =>
  `const app = await aio.run({
  cells: [wallet],
  appId: APP_ID,
  appVersion: "0.0.0",
  client: "server-only",
  libraryMode: true,
  singleton: false,
  port: PORT,
  appDir: DIR,
  baseDir: DIR,
  persistDebounceMs: 10,
  ${extra}
});
`;

const REPORT = `await new Promise((r) => setTimeout(r, 120));
console.log("STATE " + JSON.stringify(app.getState().wallet));
await app.close();
Deno.exit(0);
`;

const V1 = `const wallet = cell("wallet", {
  version: 1,
  state: { cents: 0 },
  methods: { set(s: { cents: number }, n: number) { s.cents = n; } },
});
`;

const V2 = `const wallet = cell("wallet", {
  version: 2,
  state: { dollars: 0 },
  onMigrate(s: Record<string, unknown>, _from: number) {
    return { dollars: (s.cents as number ?? 0) / 100 };
  },
  methods: { set(s: { dollars: number }, n: number) { s.dollars = n; } },
});
`;

function storedVersions(dir: string, appId: string): Record<string, number> {
  const db = new DatabaseSync(join(dir, "data", "state.db"));
  const rows = db.prepare("SELECT v FROM aio_kv WHERE k = ?").all(
    `${appId}:__versions`,
  ) as Array<{ v: string }>;
  db.close();
  return rows[0] ? JSON.parse(rows[0].v) : {};
}

function storedState(dir: string): Record<string, unknown> {
  const db = new DatabaseSync(join(dir, "data", "state.db"));
  const rows = db.prepare("SELECT v FROM aio_kv WHERE k = 'state'")
    .all() as Array<{ v: string }>;
  db.close();
  return rows[0] ? JSON.parse(rows[0].v) : {};
}

Deno.test({
  name:
    "migrate: a rollback never re-stamps versions downward, so rolling forward does not migrate twice",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "aio-rollback-" });
    const appId = "app"; // AIO_APPS_DIR/<appId> — appDir pins it anyway
    try {
      // v1 writes real money.
      const p1 = await phase(
        dir,
        appId,
        V1 + BOOT() + `await wallet.set(1234);\n` + REPORT,
      );
      assertEquals(p1.code, 0, p1.err);
      assert(p1.out.includes(`"cents":1234`), p1.out);

      // v2 migrates it once.
      const p2 = await phase(dir, appId, V2 + BOOT() + REPORT);
      assertEquals(p2.code, 0, p2.err);
      assert(p2.out.includes(`"dollars":12.34`), `v2 migrated once: ${p2.out}`);
      assertEquals(storedVersions(dir, appId).wallet, 2);

      // …then someone rolls back to v1. It must boot, warn, and neither
      // lower the stamp nor delete the newer shape.
      const p3 = await phase(
        dir,
        appId,
        V1 + BOOT() + `await wallet.set(1);\n` + REPORT,
      );
      assertEquals(p3.code, 0, p3.err);
      assert(
        /is NEWER than code v1/.test(p3.out + p3.err),
        `the downgrade is loud: ${(p3.out + p3.err).slice(-1200)}`,
      );
      assertEquals(
        storedVersions(dir, appId).wallet,
        2,
        "the version stamp must never regress",
      );
      const afterRollback = storedState(dir).wallet as Record<string, unknown>;
      assertEquals(
        afterRollback.dollars,
        12.34,
        "the newer build's field survives the older build's write",
      );
      assert(
        "__downgraded:wallet" in storedState(dir),
        `a verbatim copy is parked: ${JSON.stringify(storedState(dir))}`,
      );

      // Roll forward again: already-migrated data must NOT be migrated again.
      // The rollback's v1 write left `cents` on disk beside `dollars` — a
      // stored field v2 does not declare and (stamp 2 == code 2) no onMigrate
      // accounts for. Since alpha70 a DEV boot refuses that drift by name…
      const p4dev = await phase(dir, appId, V2 + BOOT() + REPORT);
      assert(p4dev.code !== 0, "dev refuses unmigrated shape drift");
      assert(
        /REFUSING to boot \(dev\)[\s\S]*wallet[\s\S]*cents/.test(p4dev.err),
        `the refusal names the cell and the field: ${p4dev.err.slice(-800)}`,
      );
      assertEquals(
        storedVersions(dir, appId).wallet,
        2,
        "a refusal writes nothing",
      );
      // …and a PROD boot (the machine that actually rolled back) warns, loads
      // the stale field, and still does not migrate twice.
      const p4 = await phase(dir, appId, V2 + BOOT() + REPORT, ["--prod"]);
      assertEquals(p4.code, 0, p4.err);
      assert(
        p4.out.includes(`"dollars":12.34`),
        `onMigrate must not run a second time: ${p4.out}`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "migrate: a throwing onMigrate refuses to boot and leaves the data on disk",
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "aio-migrate-throw-" });
    const appId = "app";
    const NOTES_V1 = `const wallet = cell("wallet", {
  version: 1,
  state: { items: [] as string[] },
  methods: { add(s: { items: string[] }, v: string) { s.items.push(v); } },
});
`;
    const NOTES_V2_THROWS = `const wallet = cell("wallet", {
  version: 2,
  state: { items: [] as string[] },
  onMigrate(_s: Record<string, unknown>, _from: number) {
    throw new Error("migration is broken");
  },
  methods: { add(s: { items: string[] }, v: string) { s.items.push(v); } },
});
`;
    try {
      const p1 = await phase(
        dir,
        appId,
        NOTES_V1 + BOOT() +
          `await wallet.add("one"); await wallet.add("two");\n` + REPORT,
      );
      assertEquals(p1.code, 0, p1.err);
      assertEquals(
        (storedState(dir).wallet as { items: string[] }).items,
        ["one", "two"],
      );

      // The broken build must NOT come up…
      const p2 = await phase(
        dir,
        appId,
        NOTES_V2_THROWS +
          BOOT(
            `onError: (e: { message: string }) => console.log("ONERROR " + e.message),`,
          ) +
          `await new Promise((r) => setTimeout(r, 300));\nconsole.log("BOOTED");\nawait app.close();\nDeno.exit(0);\n`,
      );
      assert(
        p2.code !== 0,
        `a failed migration must refuse to boot: ${p2.out}`,
      );
      assert(!p2.out.includes("BOOTED"), p2.out);
      assert(
        /onMigrate .* threw|refusing to boot/.test(p2.err + p2.out),
        `the refusal names the cause: ${(p2.err + p2.out).slice(-800)}`,
      );

      // …and the notes are still exactly where they were.
      assertEquals(
        (storedState(dir).wallet as { items: string[] }).items,
        ["one", "two"],
        "the stored data must survive a failed migration",
      );
      assertEquals(
        storedVersions(dir, appId).wallet,
        1,
        "no version was stamped",
      );

      // A fixed build still finds something to migrate.
      const FIXED = `const wallet = cell("wallet", {
  version: 2,
  state: { items: [] as string[] },
  onMigrate(s: Record<string, unknown>, _from: number) {
    return { items: (s.items as string[]).map((i) => i.toUpperCase()) };
  },
  methods: { add(s: { items: string[] }, v: string) { s.items.push(v); } },
});
`;
      const p3 = await phase(dir, appId, FIXED + BOOT() + REPORT);
      assertEquals(p3.code, 0, p3.err);
      assert(
        p3.out.includes(`["ONE","TWO"]`),
        `the fix migrates it: ${p3.out}`,
      );
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

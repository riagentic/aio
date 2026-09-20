// Journal replay keeps a DOTTED `persist: { exclude }` path out of recovered
// state, the way the store keeps it out.
//
// `tests/journal-replay-persist-exclude.test.ts` pins a top-level exclude. The
// replay guard read only top-level flags, and a nested exclude leaves its
// top-level key "persisted", so it fell straight through. Measured against a
// real SIGKILL beside a real clean stop of the same run:
// `exclude: ["meta.cache"]` came back `meta.cache: 0` after the clean stop and
// `meta.cache: 4242` after the kill — the replayed write resurrected it. The
// by-id map spelling (`accounts.secret` over `accounts: { alice: {…} }`, the
// container `deepExcludePaths` descends) is pinned beside it, because that is the
// shape an excluded secret usually lives in, and so is a list (`rows.tmp`).
import { assertEquals } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

const CHILD = `
import { aio, cell } from "${MOD}";
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const PHASE = Deno.env.get("PHASE");
const w = cell("w", {
  state: { data: 0, meta: { cache: 0, keep: 0 }, accounts: {}, rows: [] },
  persist: { exclude: ["meta.cache", "accounts.secret", "rows.tmp"] },
  methods: {
    setAll(s, v) {
      s.data = v; s.meta.cache = v; s.meta.keep = v;
      s.accounts.alice = { name: "n" + v, secret: "s" + v };
      s.rows.push({ id: v, tmp: v });
    },
  },
});
const app = await aio.run({
  cells: [w],
  appId: "journal-nested-probe",
  client: "server-only",
  journal: true,
  // No snapshot inside the run: the writes live only in the journal.
  persistDebounceMs: 999999,
  port: PORT,
  appDir: DIR,
});
if (PHASE === "read") {
  Deno.writeTextFileSync(
    DIR + "/out.json",
    JSON.stringify(app.getState().w),
  );
  Deno.exit(0);
}
await w.setAll(4242);
if (PHASE === "kill") Deno.kill(Deno.pid, "SIGKILL");
await app.close();
Deno.exit(0);
`;

async function run(dir: string, phase: string): Promise<void> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, `${dir}/app.ts`],
    env: {
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      PHASE: phase,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (phase !== "kill" && !out.success) {
    throw new Error(
      `${phase} child failed:\n${new TextDecoder().decode(out.stderr)}`,
    );
  }
}

async function restartAfter(stop: "kill" | "clean") {
  const dir = await tempDir(`aio-journal-nested-${stop}-`);
  await Deno.writeTextFile(`${dir}/app.ts`, CHILD);
  await run(dir, stop);
  await run(dir, "read");
  return JSON.parse(await Deno.readTextFile(`${dir}/out.json`));
}

Deno.test("journal replay: a nested persist exclude restarts after SIGKILL exactly as after a clean stop", async () => {
  const clean = await restartAfter("clean");
  // The clean stop is the reference, so pin what it says first.
  assertEquals(clean, {
    data: 4242,
    meta: { cache: 0, keep: 4242 },
    accounts: { alice: { name: "n4242" } },
    rows: [{ id: 4242 }],
  });
  const killed = await restartAfter("kill");
  assertEquals(
    killed,
    clean,
    "a SIGKILL restart must match a clean one — the persisted fields are " +
      "recovered by replay, the nested excluded ones are not resurrected by it",
  );
});

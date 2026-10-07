// A write the declared shape does not survive must not survive a SIGKILL
// either.
//
// The write guard says it at the write, in dev and prod: deleting a declared
// key "does not survive a restart … Restore fills every declared key back in
// with its default", and a key the cell's `state:` does not declare "the next
// boot will NOT restore". A clean stop honours that — restore is
// `deepMerge(declared, stored)`. Journal replay after a SIGKILL re-reduces the
// method on the restored state and keeps its result as-is: the deleted
// declared key stays deleted and the undeclared key stays — so the app's state
// after a restart depends on how the process ended (the same divergence
// `persist.exclude` and `onPersist` were fixed for).
import { assertEquals } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { fromFileUrl } from "@std/path";
import { spec } from "./module-spec-helper.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = fromFileUrl(new URL("../deno.json", import.meta.url));

const CHILD = `
import { aio, cell } from "${spec(MOD)}";
const DIR = Deno.env.get("DIR");
const w = cell("w", {
  state: { m: { a: 1, b: 2 }, n: 0 },
  methods: { drop(s) { delete s.m.a; s.m.extra = 5; s.n++; } },
});
const app = await aio.run({
  cells: [w],
  appId: "journal-replay-declared-shape",
  client: "server-only",
  journal: true,
  persistDebounceMs: 999999,
  port: Number(Deno.env.get("PORT")),
  appDir: DIR,
});
const phase = Deno.env.get("PHASE");
if (phase === "read") {
  Deno.writeTextFileSync(DIR + "/out.json", JSON.stringify({ m: w.m, n: w.n }));
  await app.close();
  Deno.exit(0);
}
await w.drop();
if (phase === "kill") Deno.kill(Deno.pid, "SIGKILL");
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
    throw new Error(`${phase}: ${new TextDecoder().decode(out.stderr)}`);
  }
}

async function restartAfter(stop: "kill" | "clean") {
  const dir = await tempDir(`journal-replay-declared-shape-${stop}-`);
  try {
    await Deno.writeTextFile(`${dir}/app.ts`, CHILD);
    await run(dir, stop);
    await run(dir, "read");
    return JSON.parse(await Deno.readTextFile(`${dir}/out.json`));
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("journal replay: a deleted declared key / an undeclared key come back as after a clean stop", async () => {
  const clean = await restartAfter("clean");
  assertEquals(
    clean,
    { m: { a: 1, b: 2 }, n: 1 },
    "clean-stop baseline: restore fills the declared key and drops the undeclared one",
  );
  const killed = await restartAfter("kill");
  assertEquals(
    killed,
    clean,
    "a SIGKILL restart must restore the same declared shape a clean one does",
  );
});

// A `persist: { exclude }` field comes back the same way whatever stopped the
// app.
//
// Journal replay re-runs the actions after the last snapshot, and those
// actions write excluded fields as readily as persisted ones. Measured: a
// `setCache(4242)` came back as 4242 after a SIGKILL (the journal replayed it)
// and as the default 0 after a clean stop — the app's own declaration of what
// survives a restart depended on how the process ended. Pinned against a real
// SIGKILL, next to a real clean stop of the same run.
import { assertEquals } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

const CHILD = `
import { aio, cell } from "${MOD}";
const DIR = Deno.env.get("DIR");
const w = cell("w", {
  state: { data: 0, cache: 0 },
  persist: { exclude: ["cache"] },
  methods: { setBoth(s, v) { s.data = v; s.cache = v; } },
});
const app = await aio.run({
  cells: [w],
  appId: "journal-exclude-probe",
  client: "server-only",
  journal: true,
  // No snapshot inside the run: the write lives only in the journal.
  persistDebounceMs: 999999,
  port: Number(Deno.env.get("PORT")),
  appDir: DIR,
});
const phase = Deno.env.get("PHASE");
if (phase === "read") {
  Deno.writeTextFileSync(DIR + "/out.json", JSON.stringify({ data: w.data, cache: w.cache }));
  Deno.exit(0);
}
await w.setBoth(4242);
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
    throw new Error(
      `${phase} child failed:\n${new TextDecoder().decode(out.stderr)}`,
    );
  }
}

async function restartAfter(stop: "kill" | "clean") {
  const dir = await tempDir(`aio-journal-exclude-${stop}-`);
  await Deno.writeTextFile(`${dir}/app.ts`, CHILD);
  await run(dir, stop);
  await run(dir, "read");
  return JSON.parse(await Deno.readTextFile(`${dir}/out.json`));
}

Deno.test("journal replay: a persist-excluded field restarts at its default after SIGKILL, as after a clean stop", async () => {
  const clean = await restartAfter("clean");
  assertEquals(clean, { data: 4242, cache: 0 }, "the clean-stop baseline");
  const killed = await restartAfter("kill");
  assertEquals(
    killed,
    clean,
    "a SIGKILL restart must match a clean one — the persisted field is " +
      "recovered by replay, the excluded one is not resurrected by it",
  );
});

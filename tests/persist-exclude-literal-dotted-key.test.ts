// `persist: { exclude: ["a.b"] }` spells a dot path the same way `visible`
// does, so it reads the same way — the path a → b AND a key literally called
// "a.b" (a settings map keyed by dotted names is the ordinary case). See
// visible-exclude-literal-dotted-key.test.ts for the wire half.
//
// The store's projection is one walker, so the literal key stays off disk the
// moment that rule lands. Journal replay has to agree: it re-runs the actions
// after the last snapshot, and those write an excluded field as readily as any
// other — so a value the store never held would come back after a SIGKILL and
// not after a clean stop, which is the app's own declaration depending on how
// the process ended. Pinned against a real SIGKILL beside a real clean stop.
import { assertEquals } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

const CHILD = `
import { aio, cell } from "${MOD}";
const DIR = Deno.env.get("DIR");
const w = cell("w", {
  // BOTH readings live in this cell: a key literally called "a.b", and the
  // path a → b. (A cell with only the literal key is refused at boot — the
  // head segment is not a state field — so the ambiguous shape is the one
  // that can silently ship the wrong answer.)
  state: { data: 0, "a.b": 0, a: { b: 0 } },
  persist: { exclude: ["a.b"] },
  methods: { setBoth(s, v) { s.data = v; s["a.b"] = v; s.a.b = v; } },
});
const app = await aio.run({
  cells: [w],
  appId: "persist-literal-dotted-probe",
  client: "server-only",
  journal: true,
  // No snapshot inside the run: the write lives only in the journal.
  persistDebounceMs: 999999,
  port: Number(Deno.env.get("PORT")),
  appDir: DIR,
});
const phase = Deno.env.get("PHASE");
if (phase === "read") {
  Deno.writeTextFileSync(
    DIR + "/out.json",
    JSON.stringify({ data: w.data, dotted: w["a.b"], nested: w.a.b }),
  );
  Deno.exit(0);
}
await w.setBoth(4242);
if (phase === "kill") Deno.kill(Deno.pid, "SIGKILL");
await app.close();
Deno.exit(0);
`;

async function runChild(dir: string, phase: string): Promise<void> {
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
  const dir = await tempDir(`aio-persist-dotted-${stop}-`);
  await Deno.writeTextFile(`${dir}/app.ts`, CHILD);
  await runChild(dir, stop);
  await runChild(dir, "read");
  return JSON.parse(await Deno.readTextFile(`${dir}/out.json`));
}

Deno.test("persist.exclude: a literal dotted key restarts at its default, however the app stopped", async () => {
  const clean = await restartAfter("clean");
  assertEquals(
    clean,
    { data: 4242, dotted: 0, nested: 0 },
    "the clean-stop baseline: neither reading of the exclude is on disk",
  );
  const killed = await restartAfter("kill");
  assertEquals(
    killed,
    clean,
    "a SIGKILL restart must match a clean one — replay must not resurrect " +
      "the field the store never wrote",
  );
});

// A crash and a clean stop restore to the SAME state — including what the
// app-level `onRestore` (and a plain cell's own `onRestore`) repair.
//
// Boot runs the restore hooks on the snapshot, and journal recovery then
// replays the tail on top. A clean stop snapshots the final state, so the
// hooks see it all; a SIGKILL left the tail to replay AFTER the hooks, so what
// they repair ("nobody is online after a restart") was undone by the replayed
// action that set it. Measured: `online: false` after a clean stop,
// `online: true` after a crash — the repair silently skipped.
import { assertEquals } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

const APP = `
import { aio, cell } from "${MOD}";
const DIR = Deno.env.get("DIR");
const p = cell("p", {
  state: { online: false, n: 0 },
  methods: { join(s) { s.online = true; s.n += 1; } },
});
const q = cell("q", {
  state: { busy: false, n: 0 },
  onRestore: (s) => { s.busy = false; },
  methods: { work(s) { s.busy = true; s.n += 1; } },
});
const app = await aio.run({
  cells: [p, q],
  appId: "journal-app-onrestore-probe",
  client: "server-only",
  journal: true,
  persistDebounceMs: Number(Deno.env.get("DEBOUNCE")),
  port: Number(Deno.env.get("PORT")),
  appDir: DIR,
  onRestore: (s) => ({ ...s, p: { ...s.p, online: false } }),
});
const phase = Deno.env.get("PHASE");
if (phase === "read") {
  Deno.writeTextFileSync(DIR + "/out.json", JSON.stringify({ p: { online: p.online, n: p.n }, q: { busy: q.busy, n: q.n } }));
  await app.close();
  Deno.exit(0);
}
await p.join();
await q.work();
await new Promise((r) => setTimeout(r, 600));
await p.join();
await q.work();
if (phase === "kill") Deno.kill(Deno.pid, "SIGKILL");
await app.close();
Deno.exit(0);
`;

async function run(dir: string, phase: string, debounce: number) {
  await Deno.writeTextFile(`${dir}/app.ts`, APP);
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, `${dir}/app.ts`],
    env: {
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      PHASE: phase,
      DEBOUNCE: String(debounce),
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  if (phase !== "kill" && !out.success) {
    throw new Error(`${phase} child failed:\n${text}`);
  }
  return text;
}

async function restart(stop: "kill" | "clean"): Promise<unknown> {
  const dir = await tempDir(`aio-journal-app-onrestore-${stop}-`);
  try {
    // 100 ms debounce: the first join/work is snapshotted in the pause, the
    // second lives only in the journal when the process is killed.
    await run(dir, stop, 100);
    const log = await run(dir, "read", 999999);
    const out = JSON.parse(await Deno.readTextFile(`${dir}/out.json`));
    return { ...out, recovered: log.includes("recovered") };
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("journal replay: the app-level and a plain cell's onRestore see the replayed state, as after a clean stop", async () => {
  const clean = await restart("clean") as Record<string, unknown>;
  const killed = await restart("kill") as Record<string, unknown>;
  assertEquals(killed.recovered, true, "the tail was really replayed");
  assertEquals(
    { p: killed.p, q: killed.q },
    { p: clean.p, q: clean.q },
  );
  assertEquals(clean.p, { online: false, n: 2 });
  assertEquals(clean.q, { busy: false, n: 2 });
});

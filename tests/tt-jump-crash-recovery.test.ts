// A time-travel jump must survive a crash like any other change of state.
//
// `goto`/`undo`/`redo` assign live state directly — no action, so nothing was
// journalled and nothing scheduled a persist. The journal's replay tail then
// described actions taken AFTER the jump, and boot replayed them onto the
// PRE-jump snapshot: a state the app never had. Measured: eight `inc(1)` from
// 14 (22, snapshotted), `goto` the entry after the third (17), `resume`,
// `inc(100)` (117), SIGKILL — the restart said "journal: recovered 1 action"
// and came back at 122.
//
// Pinned against a real SIGKILL on a real disk, because the property is about
// what is on disk at the instant the process dies.
import { assertEquals } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

const CHILD = `
import { aio, cell } from "${MOD}";
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const ttc = cell("ttc", {
  state: { n: 14, hist: [] },
  methods: { inc(s, by) { s.n += by; s.hist.push(by); } },
});
const app = await aio.run({
  cells: [ttc],
  appId: "tt-crash-probe",
  client: "server-only",
  journal: true,
  persistDebounceMs: 40,
  port: PORT,
  appDir: DIR,
});
const url = (r) => "http://127.0.0.1:" + PORT + "/__aio/trojan/" + r;
const post = async (r, body) => {
  const res = await fetch(url(r), {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AIO": "1" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(r + " " + res.status + " " + text);
};
const PHASE = Deno.env.get("PHASE");
if (PHASE === "paused-kill" || PHASE === "paused-clean") {
  for (let i = 0; i < 8; i++) {
    await post("dispatch", { type: "ttc:inc", payload: { args: [1] } });
  }
  await new Promise((r) => setTimeout(r, 400));
  const hist = await (await fetch(url("history"))).json();
  const incs = hist.entries.filter((e) => e.type === "ttc:inc");
  await post("tt", { cmd: "goto", arg: incs[2].id }); // stays paused at 17
  Deno.writeTextFileSync(DIR + "/expected.json", JSON.stringify(ttc.n));
  if (PHASE === "paused-kill") Deno.kill(Deno.pid, "SIGKILL");
  await app.close();
  Deno.exit(0);
} else if (PHASE === "crash") {
  for (let i = 0; i < 8; i++) {
    await post("dispatch", { type: "ttc:inc", payload: { args: [1] } });
  }
  // Long enough for the 40ms debounce to snapshot n = 22.
  await new Promise((r) => setTimeout(r, 400));
  const hist = await (await fetch(url("history"))).json();
  const incs = hist.entries.filter((e) => e.type === "ttc:inc");
  await post("tt", { cmd: "goto", arg: incs[2].id }); // after the third inc
  await post("tt", { cmd: "resume" });
  await post("dispatch", { type: "ttc:inc", payload: { args: [100] } });
  Deno.writeTextFileSync(DIR + "/expected.json", JSON.stringify(ttc.n));
  Deno.kill(Deno.pid, "SIGKILL");
} else {
  Deno.writeTextFileSync(DIR + "/recovered.json", JSON.stringify(ttc.n));
  Deno.exit(0);
}
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
  if (!phase.endsWith("kill") && phase !== "crash" && !out.success) {
    throw new Error(
      `${phase} child failed:\n${new TextDecoder().decode(out.stderr)}`,
    );
  }
}

Deno.test("time travel: a jump then SIGKILL recovers the state the app had, not pre-jump + tail", async () => {
  const dir = await tempDir("aio-tt-crash-");
  await Deno.writeTextFile(`${dir}/app.ts`, CHILD);
  await runChild(dir, "crash");
  const expected = JSON.parse(await Deno.readTextFile(`${dir}/expected.json`));
  assertEquals(expected, 117, "the live app: 14 + 3 (after the jump) + 100");
  await runChild(dir, "read");
  const recovered = JSON.parse(
    await Deno.readTextFile(`${dir}/recovered.json`),
  );
  assertEquals(
    recovered,
    expected,
    `restart after SIGKILL must come back at ${expected}, the state the app ` +
      `had — 122 is the pre-jump snapshot (22) with inc(100) replayed on top`,
  );
});

Deno.test("time travel: ending paused on a jump — SIGKILL and a clean stop restart at the same state", async () => {
  const restartAfter = async (phase: string) => {
    const dir = await tempDir(`aio-tt-${phase}-`);
    await Deno.writeTextFile(`${dir}/app.ts`, CHILD);
    await runChild(dir, phase);
    await runChild(dir, "read");
    return JSON.parse(await Deno.readTextFile(`${dir}/recovered.json`));
  };
  const clean = await restartAfter("paused-clean");
  const killed = await restartAfter("paused-kill");
  assertEquals(
    killed,
    clean,
    "how the process ended must not decide which state comes back",
  );
});

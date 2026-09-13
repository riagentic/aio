// A snapshot load is as durable as the actions around it.
//
// `loadSnapshot` (the `app.loadSnapshot()` API, and `POST
// /__aio/trojan/snapshot` / `am snapshot load`, which call it) replaces live
// state wholesale — no action runs — and only SCHEDULES a persist. So it reached
// no durable sink: an action acked right after the load went into the journal,
// the process died before the debounced write, and boot replayed that action
// onto the PRE-load database. Measured: balance 5 persisted, load a snapshot
// at 1000, `deposit(1)`, SIGKILL — the restart came back at 6, a state the app
// never had, with "journal: recovered 1 action".
//
// The load is now journalled as the state it put in place, exactly as a
// time-travel jump is (`_recordTimeTravel` in aio.ts).
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

const CHILD = `
import { aio, cell } from "${MOD}";
const DIR = Deno.env.get("DIR");
const PORT = Number(Deno.env.get("PORT"));
const bank = cell("bank", {
  state: { balance: 0, history: [] },
  methods: {
    deposit(s, n) { s.balance += n; s.history.push("+" + n); },
  },
});
const app = await aio.run({
  cells: [bank],
  appId: "journal-snapshot-probe",
  client: "server-only",
  journal: true,
  // A wide debounce: the crash below lands well inside it, as a real one can.
  persistDebounceMs: 5000,
  port: PORT,
  appDir: DIR,
});
const SNAP = JSON.stringify({ bank: { balance: 1000, history: ["snap"] } });
const phase = Deno.env.get("PHASE");
if (phase === "base") {
  await bank.deposit(5);
  await app.close(); // persisted; the journal compacts empty
  Deno.exit(0);
} else if (phase === "api") {
  app.loadSnapshot(SNAP);
  await bank.deposit(1); // acked on the loaded state
  Deno.kill(Deno.pid, "SIGKILL");
} else if (phase === "route") {
  const res = await fetch(\`http://127.0.0.1:\${PORT}/__aio/trojan/snapshot\`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-AIO": "1" },
    body: SNAP,
  });
  console.log("ROUTE", res.status, await res.text());
  await bank.deposit(1);
  Deno.kill(Deno.pid, "SIGKILL");
} else {
  Deno.writeTextFileSync(
    DIR + "/recovered.json",
    JSON.stringify({ balance: bank.balance, history: bank.history }),
  );
  await app.close();
  Deno.exit(0);
}
`;

async function runChild(dir: string, phase: string): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, join(dir, "app.ts")],
    env: {
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      PHASE: phase,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  if ((phase === "read" || phase === "base") && !out.success) {
    throw new Error(`${phase} child failed:\n${text}`);
  }
  return text;
}

for (const door of ["api", "route"] as const) {
  Deno.test(`journal: a crash after a snapshot load (${door}) recovers the LOADED state, not the pre-load one`, async () => {
    const dir = await tempDir(`aio-journal-snapshot-${door}-`);
    try {
      await Deno.writeTextFile(join(dir, "app.ts"), CHILD);
      await runChild(dir, "base");
      const crashLog = await runChild(dir, door);
      const bootLog = await runChild(dir, "read");
      const recovered = JSON.parse(
        await Deno.readTextFile(join(dir, "recovered.json")),
      );
      assertEquals(
        recovered,
        { balance: 1001, history: ["snap", "+1"] },
        `the deposit was acked on the loaded snapshot — replaying it onto the ` +
          `pre-load database invents a state the app never had.\n--- crash:\n${crashLog}\n--- boot:\n${bootLog}`,
      );
    } finally {
      await dropTempDir(dir);
    }
  });
}

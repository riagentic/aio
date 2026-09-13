// `journal: true` must protect a `sync: true` cell's acked server-side writes
// the way it protects every other cell's — and must not apply one twice.
//
// A server-origin write to a sync cell (a trojan/CLI call, an effect, cron) is
// acked at commit and folded into the cell's CRDT snapshot up to 500 ms later
// (`noteServerWrite`: 100 ms debounce, 500 ms max wait). It was never
// journalled, so a SIGKILL inside that window lost it under the option that
// exists to prevent exactly that. Measured (r3 chaos hunt, bound CLI calls):
// SIGKILL at 300 ms → acked 36, restored 0; at 2050 ms → 28 of 141 lost, the
// oldest acked 465 ms before the kill. The same run without `sync: true`: 0.
//
// The fix journals those writes by the cell's OWN watermark, written inside
// the fold's transaction. Three kill points, each against a real SIGKILL on a
// real disk:
//   • before any fold — the writes exist only in the journal;
//   • after a fold, with more writes past it — part folded, part journal-only;
//   • between a fold's commit and the journal compaction that follows it —
//     every write is in BOTH the snapshot and the journal, and replaying them
//     would duplicate them.
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
const PHASE = Deno.env.get("PHASE");
const log = cell("log", {
  sync: true,
  version: 1,
  state: { items: [] },
  methods: { add(s, id) { s.items.push(id); } },
});
await aio.run({
  cells: [log],
  appId: "sync-journal-probe",
  client: "server-only",
  journal: true,
  port: PORT,
  appDir: DIR,
});
const post = async (body) => {
  const res = await fetch("http://127.0.0.1:" + PORT + "/__aio/trojan/dispatch", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AIO": "1" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(res.status + " " + text);
};
const burst = async (from, n) => {
  for (let i = 0; i < n; i++) {
    await post({ type: "log:add", payload: { args: [from + i] } });
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = () => {
  Deno.writeTextFileSync(DIR + "/expected.json", JSON.stringify(log.items));
  Deno.kill(Deno.pid, "SIGKILL");
};
const journal = DIR + "/data/journal";
if (PHASE === "before-fold") {
  await burst(1, 30);
  done();
} else if (PHASE === "after-fold") {
  await burst(1, 20);
  await sleep(1500); // folded (≤ 500 ms) and the journal compacted
  await burst(21, 10);
  done();
} else if (PHASE === "between-commit-and-compaction") {
  await burst(1, 20);
  // The journal as it stands before the fold…
  const stash = [journal, journal + ".base"].map((p) => {
    try { return [p, Deno.readFileSync(p)]; } catch { return [p, null]; }
  });
  await sleep(1500); // …the fold commits, and compaction drops the lines…
  // …and the process dies before compaction ran: put the lines back.
  for (const [p, bytes] of stash) if (bytes) Deno.writeFileSync(p, bytes);
  done();
} else {
  Deno.writeTextFileSync(DIR + "/recovered.json", JSON.stringify(log.items));
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
  if (phase === "read" && !out.success) {
    throw new Error(`read child failed:\n${text}`);
  }
  return text;
}

async function crashAndRestart(phase: string) {
  const dir = await tempDir(`aio-sync-journal-${phase}-`);
  try {
    await Deno.writeTextFile(join(dir, "app.ts"), CHILD);
    const crashLog = await runChild(dir, phase);
    const expected = JSON.parse(
      await Deno.readTextFile(join(dir, "expected.json")).catch(() => {
        throw new Error(`${phase} child never reached its kill:\n${crashLog}`);
      }),
    ) as number[];
    const bootLog = await runChild(dir, "read");
    const recovered = JSON.parse(
      await Deno.readTextFile(join(dir, "recovered.json")),
    ) as number[];
    return { expected, recovered, bootLog };
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("sync cell + journal: SIGKILL before the fold keeps every acked server write", async () => {
  const { expected, recovered, bootLog } = await crashAndRestart(
    "before-fold",
  );
  assertEquals(expected.length, 30, "the live app acked 30 writes");
  assertEquals(
    recovered,
    expected,
    `every acked write must survive — it was in the journal and nowhere ` +
      `else. restored ${recovered.length} of ${expected.length}.\n${bootLog}`,
  );
});

Deno.test("sync cell + journal: SIGKILL after a fold keeps the folded writes and the tail, once each", async () => {
  const { expected, recovered, bootLog } = await crashAndRestart("after-fold");
  assertEquals(expected.length, 30);
  assertEquals(recovered, expected, bootLog);
});

Deno.test("sync cell + journal: a fold that committed before the journal compacted is not replayed twice", async () => {
  const { expected, recovered, bootLog } = await crashAndRestart(
    "between-commit-and-compaction",
  );
  assertEquals(expected.length, 20);
  assertEquals(
    recovered,
    expected,
    `the snapshot already holds these writes — replaying the journal lines ` +
      `that also hold them duplicates every one.\n${bootLog}`,
  );
});

// A time-travel line replayed into a cell whose `onPersist` RESHAPES its
// state must come back as that state, not as the shape spread over it.
//
// The line carries what the store writes — `{ saved: 2 }` for
// `onPersist: (s) => ({ saved: s.n })` — and replay spread it over the live
// slice: `{ n: 0, saved: 2 }`. The shaped-cell round trip then re-ran
// `onPersist` on `n: 0` and the jump was gone after a SIGKILL (external
// review, rev4 — found through a `listensTo` reaction line, which shares this
// replay path). Replay now rebuilds such a cell the way a restart does:
// declared state, the stored shape merged in, the cell's `onRestore`.
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
const c = cell("c", {
  state: { n: 0 },
  onPersist: (s) => ({ saved: s.n }),
  onRestore: (s) => { if (typeof s.saved === "number") s.n = s.saved; delete s.saved; },
  methods: { inc(s) { s.n++; } },
});
const app = await aio.run({
  cells: [c],
  appId: "journal-tt-shaped-recovery",
  client: "server-only",
  journal: true,
  persistDebounceMs: 999999,
  port: PORT,
  appDir: DIR,
});
if (Deno.env.get("PHASE") === "read") {
  Deno.writeTextFileSync(DIR + "/recovered.json", JSON.stringify(app.getState().c));
  Deno.exit(0);
}
await c.inc();
await c.inc();
await c.inc();
const res = await fetch("http://127.0.0.1:" + PORT + "/__aio/trojan/tt", {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-AIO": "1" },
  body: JSON.stringify({ cmd: "undo" }),
});
await res.text();
Deno.writeTextFileSync(DIR + "/expected.json", JSON.stringify(app.getState().c));
Deno.kill(Deno.pid, "SIGKILL");
`;

async function run(dir: string, phase: string): Promise<string> {
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
  return new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
}

Deno.test("journal: a jump into an onPersist-shaped cell survives a SIGKILL as state", async () => {
  const dir = await tempDir("aio-journal-tt-shaped-");
  try {
    await Deno.writeTextFile(join(dir, "app.ts"), CHILD);
    const log = await run(dir, "crash");
    const expected = JSON.parse(
      await Deno.readTextFile(join(dir, "expected.json")).catch(() => {
        throw new Error(`the child never reached its kill:\n${log}`);
      }),
    );
    assertEquals(expected, { n: 2 }, "live: three incs, one undo");
    const boot = await run(dir, "read");
    const recovered = JSON.parse(
      await Deno.readTextFile(join(dir, "recovered.json")),
    );
    assertEquals(recovered, expected, boot);
  } finally {
    await dropTempDir(dir);
  }
});

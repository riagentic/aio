// A journal that refuses its appends for a while: one WARN when it starts,
// one line when writes land again, with the count — and no "will be lost".
//
// Measured on Windows: a program held the journal (share=Read) for 10 s and
// 40 s while the app was clicked once a second — 23 and 119 ERROR lines, each
// refused append said twice: a PERSIST_ERROR saying "changes are in memory
// but will be lost on restart", and `journal: degraded`. Nothing was lost:
// every refused append is saved by an immediate snapshot, and the counters
// after a restart were equal.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { journalRefusals } from "../src/server/journal.ts";
import {
  _quietDegraded,
  degraded,
  degradedReport,
} from "../src/diagnostics/degraded.ts";
import { setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";
import { childEnv } from "./e2e-app-harness.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";

const REPO = join(import.meta.dirname!, "..");

/** The reporter on a hand-driven clock. */
function reporter() {
  const said: string[] = [];
  const health: string[] = [];
  let t = 0;
  const r = journalRefusals({
    path: () => "/data/journal",
    warn: (m) => void said.push(`warn ${m}`),
    info: (m) => void said.push(`info ${m}`),
    health: {
      fail: () => void health.push("fail"),
      ok: () => void health.push("ok"),
    },
    settleMs: 5_000,
    now: () => t,
  });
  return { r, said, health, advance: (ms: number) => (t += ms) };
}

Deno.test("journalRefusals: one WARN per episode, the count once appends land 5 s after the last refusal — a refusal in between is the same episode", () => {
  const x = reporter();
  const held = new Error("used by another process (os error 32)");
  x.r.refused(held);
  x.advance(1_000);
  x.r.refused(held);
  x.r.landed(); // lands once, at once…
  x.advance(1_000);
  x.r.refused(held); // …and is refused again: the same episode
  x.advance(8_000);
  x.r.landed(); // 8 s after the last refusal: over
  x.r.landed();
  assertEquals(x.said.length, 2, x.said.join("\n"));
  assert(
    x.said[0]!.startsWith("warn journal: writes to /data/journal are refused"),
  );
  assertStringIncludes(x.said[0]!, "os error 32");
  assertStringIncludes(x.said[0]!, "nothing is lost");
  assert(!x.said.join("\n").includes("will be lost"), x.said.join("\n"));
  assert(
    x.said[1]!.startsWith("info journal: writes to /data/journal land again"),
  );
  assertStringIncludes(x.said[1]!, "3 refused over 2 s");
  // Health follows each append: down while refused, up when one lands.
  assertEquals(x.health, ["fail", "fail", "ok", "fail", "ok", "ok"]);
  // A new episode is said again.
  x.r.refused(held);
  assertEquals(x.said.length, 3);
});

Deno.test("a tracker whose caller says its episodes: health still shows it down and up again, the log says nothing", () => {
  const name = `quiet-${crypto.randomUUID().slice(0, 8)}`;
  const said: string[] = [];
  setLogger({
    pub: (lvl: string, _c: string, msg: string) =>
      void said.push(`${lvl} ${msg}`),
  } as unknown as LogSink);
  try {
    _quietDegraded(name);
    const d = degraded(name, { after: 1 });
    d.fail(new Error("held"));
    assert(degradedReport().some((r) => r.name === name), "down in health");
    d.ok();
    assert(!degradedReport().some((r) => r.name === name), "up again");
    assertEquals(said.filter((l) => l.includes(name)), []);
  } finally {
    setLogger(null);
  }
});

// ── a real app whose journal refuses its appends ──

const APP = `import { aio, cell } from "aio";
import { join } from "@std/path";
import { appDirs } from "aio/server/app-dirs.ts";
import { JOURNAL_SETTLE_MS } from "aio/server/journal.ts";
JOURNAL_SETTLE_MS.value = 200;
const appId = Deno.env.get("APP_ID")!;
const c = cell("c", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });
const app = await aio.run({ appId, cells: [c], client: "server-only",
  port: 0, journal: true });
const file = join(appDirs(appId).data, "journal");
const tick = async () => {
  await app.dispatch({ type: "c:inc", payload: { args: [] } } as never);
  await new Promise((r) => setTimeout(r, 30));
};
await tick();
Deno.chmodSync(file, 0o444); // the journal refuses: held by another program
for (let i = 0; i < 5; i++) await tick();
Deno.chmodSync(file, 0o644);
await tick();
await new Promise((r) => setTimeout(r, 300)); // past the settle: over
await tick();
console.log("COUNT " + JSON.stringify(app.getState()));
await app.stop?.();
Deno.exit(0);
`;

Deno.test({
  name:
    "a journal refused while five writes come in: one WARN, one 'land again' with the count, no PERSIST_ERROR, no 'will be lost' — and every write kept",
  ignore: Deno.uid() === 0, // chmod stands in, and root ignores it
  async fn() {
    const dir = await tempDir("journal-refused-");
    try {
      await Deno.writeTextFile(
        join(dir, "deno.json"),
        JSON.stringify({
          imports: {
            "aio": `${spec(REPO)}/mod.ts`,
            "aio/": `${spec(REPO)}/src/`,
            "immer": "npm:immer@10.2.0",
            "@std/path": "jsr:@std/path@1.1.2",
          },
        }),
      );
      await Deno.writeTextFile(join(dir, "app.ts"), APP);
      const appId = `journal-refused-${Deno.pid}`;
      const run = () =>
        new Deno.Command(Deno.execPath(), {
          args: ["run", "-A", join(dir, "app.ts")],
          cwd: dir,
          env: childEnv({ AIO_APPS_DIR: join(dir, "apps"), APP_ID: appId }),
          stdin: "null",
          stdout: "piped",
          stderr: "piped",
          signal: AbortSignal.timeout(60_000),
        }).output();
      const r = await run();
      const dec = new TextDecoder();
      const out = dec.decode(r.stdout) + dec.decode(r.stderr);
      assertEquals(r.code, 0, out);
      const lines = out.split("\n");
      const refused = lines.filter((l) => l.includes("are refused ("));
      const again = lines.filter((l) => l.includes("land again —"));
      assertEquals(refused.length, 1, out);
      assert(/ WARN /.test(refused[0]!), refused[0]);
      assertEquals(again.length, 1, out);
      // (A refused append is followed by a snapshot that may replace the
      // file — a fresh, writable one — so the count is how many met the
      // read-only file, at least the first.)
      assert(/land again — [1-5] refused over/.test(again[0]!), again[0]);
      // …and the torn-tail note too is said once, not once per append.
      assert(
        lines.filter((l) => l.includes("could not cut a refused append"))
          .length <= 1,
        out,
      );
      assert(!out.includes("PERSIST_ERROR"), out);
      assert(!out.includes("will be lost"), out);
      assert(!/degraded — \d+ consecutive/.test(out), out);
      assertStringIncludes(out, `COUNT {"c":{"n":8}}`);
    } finally {
      await dropTempDir(dir);
    }
  },
});

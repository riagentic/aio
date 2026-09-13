// `am record` on a RUNNING app records what it ran.
//
// Measured on a scaffolded app with `journal: true`: dispatch twice, then
// `am record` → "journal … has no replayable actions". The journal is the
// crash-recovery tail — every persist compacts away what the snapshot holds —
// so on a running app it is empty nearly always, while `am help` sold the verb
// as "a bug you reproduced becomes a test". The live timeline holds the same
// actions with their payloads, under the same redaction rule; with no
// `--from`, a running app is recorded from it.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";

const REPO = dirname(dirname(fromFileUrl(import.meta.url)));
const DENO_JSON = join(REPO, "deno.json");

Deno.test({
  name: "am record: a running journal:true app is recorded from its timeline",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "aio-am-record-live-" });
    const apps = join(dir, "apps");
    const appId = `rec-${crypto.randomUUID().slice(0, 8)}`;
    const port = freePort();
    await Deno.mkdir(apps);
    await Deno.writeTextFile(
      join(dir, "app.ts"),
      `import { aio, cell } from "${REPO}/mod.ts";
const c = cell("c", { state: { n: 0, k: "" }, visible: "all", methods: {
  add(s: { n: number }, by: number) { s.n += by; },
  unlock(s: { k: string }, key: string) { s.k = key.slice(0, 1); },
} });
await aio.run({
  cells: [c], appId: ${JSON.stringify(appId)}, port: ${port},
  journal: true, redactActions: ["c:unlock"],
  appDir: ${JSON.stringify(join(dir, "home"))},
});
await new Promise(() => {});
`,
    );
    const env = { ...Deno.env.toObject(), AIO_APPS_DIR: apps, NO_COLOR: "1" };
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        DENO_JSON,
        join(dir, "app.ts"),
        "--client=server-only",
      ],
      cwd: dir,
      env,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let log = "";
    const drain = (s: ReadableStream<Uint8Array>) =>
      s.pipeTo(
        new WritableStream({
          write: (c) => {
            log = (log + new TextDecoder().decode(c)).slice(-8000);
          },
        }),
      ).catch(() => {});
    const drained = Promise.all([drain(child.stdout), drain(child.stderr)]);
    const am = async (...args: string[]) => {
      const r = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--config",
          DENO_JSON,
          join(REPO, "src/am.ts"),
          ...args,
          `--app=${appId}`,
          `--port=${port}`,
        ],
        cwd: dir,
        env: { ...env, AIO_AM_NO_DELEGATE: "1" },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const d = new TextDecoder();
      return {
        code: r.code,
        stdout: d.decode(r.stdout),
        stderr: d.decode(r.stderr),
      };
    };
    try {
      const deadline = Date.now() + 90_000;
      for (;;) {
        if ((await am("state")).code === 0) break;
        if (Date.now() > deadline) throw new Error(`app never up:\n${log}`);
        await new Promise((r) => setTimeout(r, 300));
      }
      for (
        const a of [["c:add", "5"], ["c:add", "2"], ["c:unlock", "hunter2"]]
      ) {
        const r = await am("dispatch", ...a);
        assertEquals(r.code, 0, `dispatch ${a}: ${r.stdout}${r.stderr}`);
      }
      // Past the persist debounce, so the journal really has been compacted —
      // the state this used to fail in.
      await am("persist");

      const out = join(dir, "flow.test.ts");
      const r = await am("record", out);
      assertEquals(r.code, 0, `am record: ${r.stdout}${r.stderr}\n${log}`);
      const test = await Deno.readTextFile(out);
      assertStringIncludes(test, "await c.add(5);");
      assertStringIncludes(test, "await c.add(2);");
      assertStringIncludes(test, "from the running app's timeline");
      // Redaction is the timeline's, applied before `am` ever sees it.
      assert(!test.includes("hunter2"), `a redacted payload leaked:\n${test}`);
      assertStringIncludes(test, "UNREPRODUCIBLE: c:unlock was redacted");
    } finally {
      try {
        child.kill("SIGTERM");
      } catch { /* already gone */ }
      await child.status;
      await drained;
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

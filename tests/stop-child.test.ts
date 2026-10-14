// `stopChild` asks; it does not end.
//
// On Windows `proc.kill("SIGTERM")` is TerminateProcess, so for as long as
// the helper sent that, every file using it stopped its app with no `onStop`
// and no final save there — and "an app that needs a hard kill is a defect"
// could not fire. Pinned on every OS: the app's `onStop` RAN (it wrote a
// file), whether the child handed over is the app or a parent of it, and the
// exit is the app's own (code 0).
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { childEnv, freePort } from "./e2e-app-harness.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";
import { sleeper } from "./proc-helper.ts";
import { stopChild } from "./stop-child.ts";

const REPO = fromFileUrl(new URL("../", import.meta.url));

/** Boot a real app (as the child, or under it), `stopChild` it, and say how
 *  it ended: its exit code, and whether its `onStop` ran. */
async function stopped(
  via: "direct" | "parent",
): Promise<{ code: number | undefined; onStopRan: boolean; log: string }> {
  const dir = await tempDir("stop-child-");
  const port = freePort();
  const marker = join(dir, "on-stop-ran");
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({
      imports: {
        "aio": `${spec(REPO)}mod.ts`,
        "aio/": `${spec(REPO)}src/`,
        "immer": "npm:immer@10.2.0",
        "@std/path": "jsr:@std/path@1.1.2",
      },
    }),
  );
  const app = join(dir, "app.ts");
  await Deno.writeTextFile(
    app,
    `import { aio, cell } from "aio";
const c = cell("c", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });
await aio.run({ appId: "stop-child-${via}-${Deno.pid}", cells: [c],
  client: "server-only", port: ${port},
  onStop: () => Deno.writeTextFileSync(${JSON.stringify(marker)}, "ran") });
`,
  );
  // "parent": what `deno task dev` is — a process that is not the app, with
  // the app under it, ending when the app ends.
  const args = via === "direct" ? ["run", "-A", app] : [
    "eval",
    `const p = new Deno.Command(Deno.execPath(), { args: ["run", "-A", ${
      JSON.stringify(app)
    }], stdin: "null" }).spawn(); Deno.exit((await p.status).code);`,
  ];
  const proc = new Deno.Command(Deno.execPath(), {
    args,
    cwd: dir,
    env: childEnv({ AIO_APPS_DIR: join(dir, "apps") }),
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let log = "";
  const dec = new TextDecoder();
  const pump = (s: ReadableStream<Uint8Array>) =>
    (async () => {
      for await (const c of s) log += dec.decode(c);
    })().catch(() => {});
  const pumps = [pump(proc.stdout), pump(proc.stderr)];
  try {
    const deadline = Date.now() + 60_000;
    let up = false;
    while (!up && Date.now() < deadline) {
      up = await fetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(1_000),
      }).then(async (r) => (await r.body?.cancel(), true), () => false);
      if (!up) await new Promise((r) => setTimeout(r, 100));
    }
    assert(up, `app never started:\n${log}`);
    const st = await stopChild(proc, { label: via, log: () => log });
    await Promise.all(pumps);
    const until = Date.now() + 30_000;
    let ran = false;
    while (!ran && Date.now() < until) {
      ran = await Deno.readTextFile(marker).then(
        (t) => t === "ran",
        () => false,
      );
      if (!ran) await new Promise((r) => setTimeout(r, 50));
    }
    return { code: st?.code, onStopRan: ran, log };
  } finally {
    await stopChild(proc, { quiet: true, graceMs: 5_000 });
    await Promise.all(pumps);
    await dropTempDir(dir);
  }
}

Deno.test("stopChild: the app is asked to stop — its onStop runs, exit 0", async () => {
  const r = await stopped("direct");
  assert(r.onStopRan, `onStop never ran — ended, not asked:\n${r.log}`);
  assertEquals(r.code, 0, r.log);
});

Deno.test({
  name: "stopChild: an app UNDER the child handed over is asked too",
  // POSIX: the signal goes to the parent alone, and `deno task` passes it on —
  // this stand-in parent does not; the tree lookup is the Windows path.
  ignore: Deno.build.os !== "windows", // the lock-record lookup under a parent is the Windows stop
  async fn() {
    const r = await stopped("parent");
    assert(r.onStopRan, `onStop never ran — ended, not asked:\n${r.log}`);
    assertEquals(r.code, 0, r.log);
  },
});

Deno.test("stopChild: a child with nothing to ask is ended, within the grace", async () => {
  const proc = sleeper({ stdin: "null", stdout: "null", stderr: "null" });
  const t0 = Date.now();
  // POSIX: a default-action SIGTERM ends it. Windows: no lock record, ended outright.
  await stopChild(proc, { graceMs: 20_000 });
  assert(Date.now() - t0 < 20_000, "waited out the whole grace");
});

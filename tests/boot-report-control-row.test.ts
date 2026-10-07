// The boot report names the control listener for what it is.
//
// Under TLS a second, plain-HTTP listener on 127.0.0.1 serves `am`. The boot
// report printed it as `trojan  http://localhost:<port>` — the internal name
// of the control API, which on a production boot bound to 0.0.0.0 read as "a
// dev door is open". The row is `control` now, and says who it is for; the
// machine-read names (`trojanPort`, `/__aio/trojan/*`) are surface, unchanged.
//
// A real `aio.run` child, so the row under test is the one a boot prints.
import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";

const REPO = dirname(dirname(fromFileUrl(import.meta.url)));

Deno.test("boot report: the TLS control listener's row is `control`, not `trojan`", async () => {
  const dir = await tempDir("aio-boot-control-row-");
  const home = join(dir, "home");
  await Deno.writeTextFile(
    join(dir, "app.ts"),
    `import { aio, cell } from "${spec(REPO)}/mod.ts";
const c = cell("c", { state: { n: 1 }, methods: { inc(s: { n: number }) { s.n++; } } });
await aio.run({ cells: [c], appId: "boot-control-row", client: "server-only",
  persist: false, appDir: ${JSON.stringify(home)} });
await new Promise(() => {});
`,
  );
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--config",
      join(REPO, "deno.json"),
      join(dir, "app.ts"),
      "--prod",
      "--expose",
      "--host=0.0.0.0",
      `--port=${freePort()}`,
    ],
    cwd: dir,
    env: { ...Deno.env.toObject(), AIO_APPS_DIR: join(dir, "apps") },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let out = "";
  const drain = (s: ReadableStream<Uint8Array>) =>
    s.pipeTo(
      new WritableStream({
        write: (c) => {
          out += new TextDecoder().decode(c);
        },
      }),
    ).catch(() => {});
  const drained = Promise.all([drain(child.stdout), drain(child.stderr)]);
  try {
    const row =
      /^.*?\bcontrol\s+http:\/\/localhost:(\d+) \(am, loopback only\)$/m;
    const deadline = Date.now() + 90_000;
    // deno-lint-ignore no-control-regex
    const plain = () => out.replace(/\x1b\[[0-9;]*m/g, "");
    while (!/^.*\bpid\s+\d+/m.test(plain()) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const port = row.exec(plain())?.[1];
    assert(port, `no control row in the boot report:\n${plain()}`);
    assert(!/^\S*\s*trojan\s/m.test(plain()), plain());
    assert(!/\btrojan\b/.test(plain()), plain());
    // It is the keyed control listener: the routes keep their names, and
    // answer nobody without the key.
    const r = await fetch(`http://127.0.0.1:${port}/__aio/trojan/state`);
    await r.body?.cancel();
    assertEquals(r.status, 401);
  } finally {
    child.kill("SIGTERM");
    await child.status;
    await drained;
    await dropTempDir(dir);
  }
});

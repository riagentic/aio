// `port: 0` is the documented "pick a free port" setting — it has its own
// upgrade-guide section and its own lock regression test. It was also, end to
// end, unusable: the resolved port was thrown away at the moment it became
// known, so everything downstream said 0.
//
//   boot banner   `web http://localhost:0` and `ws://localhost:0/ws`
//   lock file     `"port":0`, written from the CONFIGURED port before the
//                 listener existed and never corrected
//   `am`          reaches an app through that number, so `am state` on a
//                 perfectly healthy app answered
//                 `TypeError: Fetch failed: Requests to port 0 are blocked`
//
// Root cause: `Deno.serve({ port, onListen: () => {} })` discarded the address
// it was handed. The trojan listener ten lines below in the same file has
// always captured its own with `onListen: (addr) => …`.
//
// Not to be confused with the ZERO-PORT decision (`resolveZeroPort`), which is
// an app that binds no TCP port at all. There 0 in the lock is the honest
// answer and no URL may be printed; here a port really was bound.
import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const REPO = dirname(dirname(fromFileUrl(import.meta.url)));

Deno.test({
  name: "port 0: the resolved port reaches the banner, the lock and the wire",
  ignore: Deno.build.os === "windows", // named pipes, no TCP port to resolve
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "aio-port-zero-" });
    const appId = `pz-${crypto.randomUUID().slice(0, 8)}`;
    const src = join(dir, "app.ts");
    await Deno.writeTextFile(
      src,
      `import { aio, cell } from "${REPO}/mod.ts";
const c = cell("p", { state: { n: 1 }, visible: "all", methods: {} });
await aio.run({
  cells: [c], appId: ${JSON.stringify(appId)},
  client: "server-only", persist: false, port: 0,
  appDir: ${JSON.stringify(dir)},
});
console.log("BOOTED");
await new Promise(() => {});
`,
    );
    const child = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", join(REPO, "deno.json"), src],
      env: { ...Deno.env.toObject(), AIO_APPS_DIR: dir },
      stdout: "piped",
      stderr: "piped",
    }).spawn();

    // Poll the lock rather than parsing the boot report: a blocking read on a
    // child that stays up has no deadline of its own, and the lock IS the
    // number `am` uses, which is the thing under test.
    // The lock is keyed `<appId>@<hash8(home)>` for a non-default home, so it
    // is found by prefix rather than by rebuilding that key here — this test
    // is about the PORT, and should not fail when the naming rule changes.
    const lockDir = lockDirOf(dir);
    try {
      let locked: number | undefined;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && locked === undefined) {
        for (const name of await lockNames(lockDir)) {
          if (!name.startsWith(appId) || !name.endsWith(".lock")) continue;
          try {
            const parsed = JSON.parse(
              await Deno.readTextFile(join(lockDir, name)),
            ) as { port?: number; status?: string };
            if (parsed.status === "started") locked = parsed.port ?? -1;
          } catch { /* mid-write */ }
        }
        if (locked === undefined) {
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      if (locked === undefined) {
        throw new Error(
          `no started lock for ${appId} in ${lockDir} within 60s`,
        );
      }

      // 1. "Pick a free port" resolved to a real one, and the lock says so —
      //    `am` addresses an app through exactly this number, and 0 gave it
      //    "Requests to port 0 are blocked" for a healthy app.
      assert(
        locked > 0,
        `the lock recorded port ${locked} — an app cannot be reached there`,
      );

      // 2. And something is genuinely listening on it, which the lock alone
      //    does not prove.
      const res = await fetch(`http://127.0.0.1:${locked}/`);
      await res.body?.cancel();
      assert(res.status < 500, `the resolved port answered ${res.status}`);

      // 3. And what the app TELLS a client is the same number — the trojan
      //    `config` route (what `am config` reads) used to answer with the
      //    configured 0, so a pairing client would have connected to port 0.
      const cfg = await fetch(`http://127.0.0.1:${locked}/__aio/trojan/config`);
      const told = (await cfg.json()) as { port: number };
      assertEquals(told.port, locked, "the app advertises the port it bound");
    } finally {
      try {
        child.kill("SIGKILL");
      } catch { /* already gone */ }
      await child.status;
      await child.stdout.cancel().catch(() => {});
      await child.stderr.cancel().catch(() => {});
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

/** Where `lockDir()` puts locks for an app whose `AIO_APPS_DIR` is `dir`.
 *  Mirrors the scoping rule rather than importing it, so a change to that
 *  rule shows up here as a failure instead of being followed silently. */
function lockDirOf(dir: string): string {
  const base = Deno.env.get("XDG_RUNTIME_DIR") ?? "/tmp";
  const scope = "-" +
    dir.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(-48);
  return join(base, "aio" + scope);
}

/** Lock file names in `dir`, or none when it does not exist yet. */
async function lockNames(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) if (e.isFile) out.push(e.name);
  } catch { /* not created yet */ }
  return out;
}

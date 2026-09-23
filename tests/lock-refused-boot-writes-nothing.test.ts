// A boot the singleton lock REFUSES writes nothing into `<data>/`.
//
// The boot used to stamp `.heap-notice`, run the legacy-layout migration and
// rewrite `meta.json` (in place — truncate, then write) BEFORE it asked for the
// lock. So an app launched while `am backup` held the lock was refused, yet
// had already rewritten `meta.json` under the copy (a torn `meta.json` in the
// backup), and one launched while `am restore` swapped data/ could refill the
// directory the restore had just moved aside. Measured on 1.0.10 pre-release:
// meta.json's mtime moved and `.heap-notice` appeared during a hold.
//
// Pinned end to end: a real `aio.run` boot against a live maintenance hold
// exits 1 naming the op, and data/ is byte-identical afterwards — same
// entries, same bytes, same mtimes.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join, toFileUrl } from "@std/path";
import { childEnv } from "./e2e-app-harness.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = join(import.meta.dirname!, "..");
const APP_ID = `refused-boot-${Deno.pid}`;

function snapshot(dir: string): string {
  const rows: string[] = [];
  const walk = (d: string) => {
    for (
      const e of [...Deno.readDirSync(d)].sort((a, b) =>
        a.name < b.name ? -1 : 1
      )
    ) {
      const p = join(d, e.name);
      const st = Deno.lstatSync(p);
      if (e.isDirectory) {
        rows.push(`d ${p}`);
        walk(p);
      } else {
        rows.push(
          `f ${p} ${st.mtime?.getTime()} ${
            new TextDecoder().decode(Deno.readFileSync(p))
          }`,
        );
      }
    }
  };
  walk(dir);
  return rows.join("\n");
}

Deno.test({
  name: "refused boot: a maintenance hold's app launch leaves data/ untouched",
  ignore: Deno.build.os === "windows", // `sleep` stands in for the holder
  async fn() {
    const dir = await tempDir("refused-boot-");
    const apps = join(dir, "apps");
    const home = join(apps, APP_ID);
    const data = join(home, "data");
    const holder = new Deno.Command("sleep", {
      args: ["60"],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      await Deno.mkdir(data, { recursive: true, mode: 0o700 });
      await Deno.writeTextFile(
        join(data, "meta.json"),
        JSON.stringify({ appId: APP_ID, aio: "0.0.0-old", createdAt: "x" }),
      );
      await Deno.writeTextFile(join(data, "state.db"), "STATE");
      // Plant the hold exactly as `am backup` leaves it, from a child with
      // the boot's own AIO_APPS_DIR (the lock dir is scoped by it).
      const mod = toFileUrl(join(REPO, "src/server/single-instance-lock.ts"));
      const planted = await new Deno.Command(Deno.execPath(), {
        args: [
          "eval",
          "--config",
          join(REPO, "deno.json"),
          `const m = await import(${JSON.stringify(mod.href)});
           m.writeLock({ appId: ${JSON.stringify(APP_ID)},
             pid: ${holder.pid}, port: 0, startedAt: Date.now(),
             status: "starting", maintenance: { op: "am backup" },
             cwd: "/", home: ${JSON.stringify(home)} });`,
        ],
        env: { AIO_APPS_DIR: apps },
        stdout: "null",
        stderr: "piped",
      }).output();
      assert(planted.success, new TextDecoder().decode(planted.stderr));
      await Deno.writeTextFile(
        join(dir, "deno.json"),
        JSON.stringify({
          imports: {
            "aio": `${REPO}/mod.ts`,
            "aio/": `${REPO}/src/`,
            "immer": "npm:immer@10.2.0",
            "@std/path": "jsr:@std/path@1.1.2",
          },
        }),
      );
      await Deno.writeTextFile(
        join(dir, "app.ts"),
        `import { aio, cell } from "aio";
const probe = cell("probe", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });
await aio.run({ appId: ${JSON.stringify(APP_ID)}, cells: [probe],
  client: "server-only", persist: false });
`,
      );
      const before = snapshot(data);
      const boot = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", join(dir, "app.ts")],
        cwd: dir,
        env: childEnv({ AIO_APPS_DIR: apps }),
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
        // A boot that is NOT refused would serve forever: end it, and let the
        // assertions below say why, instead of the test timing out.
        signal: AbortSignal.timeout(30_000),
      }).output();
      const out = new TextDecoder().decode(boot.stdout) +
        new TextDecoder().decode(boot.stderr);
      assertEquals(boot.code, 1, out);
      assertStringIncludes(out, "am backup is running");
      assertEquals(
        snapshot(data),
        before,
        `a refused boot wrote data/:\n${out}`,
      );
    } finally {
      try {
        holder.kill("SIGKILL");
      } catch { /* aio-ok: already gone */ }
      await holder.status;
      await dropTempDir(dir);
    }
  },
});

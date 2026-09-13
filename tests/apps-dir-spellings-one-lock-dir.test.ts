// Two spellings of one `AIO_APPS_DIR` are one lock dir, one CA root — and `am`
// in one spelling finds the app started under the other.
//
// `appsDirEnv()` normalized the DATA readers, but the lock/socket dir is NAMED
// after the variable's string (`<runtime>/aio-<scope>`), and `lockDir()`,
// `pruneLockDir()` and `aioRootDir()` still read it raw. So an app started with
// `AIO_APPS_DIR=demo/../apps` wrote its lock in `aio-…-demo-apps`, `am` run
// with `AIO_APPS_DIR=apps` searched `aio-…-apps`, and answered "not running"
// about an app whose data sat in the directory it was pointed at.
import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { lockDir } from "../src/server/single-instance-lock.ts";
import { aioRootDir } from "../src/server/tls.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = dirname(dirname(fromFileUrl(import.meta.url)));
const DENO_JSON = join(REPO, "deno.json");

Deno.test("AIO_APPS_DIR spellings: one lock dir and one CA root, whichever cwd-relative form", async () => {
  const dir = Deno.realPathSync(await tempDir("aio-appsdir-lock-"));
  const prevEnv = Deno.env.get("AIO_APPS_DIR");
  const prevCwd = Deno.cwd();
  const made = new Set<string>();
  try {
    await Deno.mkdir(join(dir, "demo"));
    await Deno.mkdir(join(dir, "apps"));
    Deno.chdir(dir);
    const seen = ["apps", "demo/../apps", `${dir}/demo/../apps`].map((s) => {
      Deno.env.set("AIO_APPS_DIR", s);
      const lock = lockDir();
      made.add(lock);
      return { s, lock, ca: aioRootDir() };
    });
    for (const r of seen) {
      assertEquals(r.lock, seen[0]!.lock, `lock dir for ${r.s}`);
      assertEquals(r.ca, join(dir, "apps", ".aio-ca"), `CA root for ${r.s}`);
    }
  } finally {
    for (const d of made) {
      await Deno.remove(d, { recursive: true }).catch(() => {});
    }
    Deno.chdir(prevCwd);
    if (prevEnv === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prevEnv);
    await dropTempDir(dir);
  }
});

Deno.test({
  name:
    "AIO_APPS_DIR spellings: am with `apps` finds the app started with `demo/../apps`",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = Deno.realPathSync(await tempDir("aio-appsdir-am-"));
    await Deno.mkdir(join(dir, "demo"));
    await Deno.mkdir(join(dir, "apps"));
    const appId = `spell-${crypto.randomUUID().slice(0, 8)}`;
    await Deno.writeTextFile(
      join(dir, "app.ts"),
      `import { aio, cell } from "${REPO}/mod.ts";
const c = cell("c", { state: { n: 1 }, methods: {
  inc(s: { n: number }) { s.n++; },
} });
await aio.run({ cells: [c], appId: ${JSON.stringify(appId)}, persist: false });
await new Promise(() => {});
`,
    );
    const baseEnv = Deno.env.toObject();
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
      env: { ...baseEnv, AIO_APPS_DIR: "demo/../apps" },
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

    /** `am instances --json` from the app's cwd, under `spelling`. */
    const listed = async (spelling: string) => {
      const r = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "--config",
          DENO_JSON,
          join(REPO, "src/am.ts"),
          "instances",
          "--json",
        ],
        cwd: dir,
        env: { ...baseEnv, AIO_APPS_DIR: spelling },
        stdout: "piped",
        stderr: "piped",
      }).output();
      try {
        const rows = JSON.parse(new TextDecoder().decode(r.stdout)) as {
          appId: string;
          status: string;
        }[];
        return rows.find((i) => i.appId === appId && i.status === "started");
      } catch {
        return undefined;
      }
    };

    try {
      // The app is up — seen under the spelling it was started with, so the
      // assertion below cannot pass (or fail) for a boot that never happened.
      const deadline = Date.now() + 90_000;
      while (!(await listed("demo/../apps"))) {
        assert(Date.now() < deadline, `the app never came up; log:\n${log}`);
        await new Promise((r) => setTimeout(r, 300));
      }
      assert(
        await listed("apps"),
        "am under AIO_APPS_DIR=apps must find the app started under " +
          "AIO_APPS_DIR=demo/../apps — one directory, one lock dir",
      );
    } finally {
      child.kill("SIGTERM");
      await child.status;
      await drained;
      await dropTempDir(dir);
    }
  },
});

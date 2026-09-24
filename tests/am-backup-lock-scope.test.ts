// `am backup` / `am restore` refuse an app that is running from ANOTHER lock
// scope.
//
// The lock dir is scoped by AIO_APPS_DIR (`lockDir()`), so an instance of the
// same app booted under another apps root (or `--instance`, or an appDir app)
// files its lock where this `am` never looks: `livePid` says "not running" and
// the app lock acquires cleanly. The only thing that still sees it is the data
// folder's OS lock (`claimHome`), and copying or swapping data/ under a live
// writer is the torn copy both locks exist to prevent. This pins that the
// second check fires, by name, and that nothing was copied or moved.
//
// The holder is a REAL second process (an flock is per open file description
// — an in-process claim would not prove the cross-process refusal), under its
// own AIO_APPS_DIR, on the very home this `am` resolves.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { cmdBackup, cmdRestore } from "../src/am/am-cmd-data.ts";
import {
  _resetAppDirs,
  appDirs,
  ensureAppDirs,
  writeAppMeta,
} from "../src/server/app-dirs.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const APP = "scopeapp";
const SUITE_HOME = Deno.env.get("AIO_APPS_DIR");
const CONFIG = new URL("../deno.json", import.meta.url).pathname;
const LOCK_MOD = new URL(
  "../src/server/single-instance-lock.ts",
  import.meta.url,
).href;

async function run(
  fn: (args: string[], flags: Record<string, unknown>) => void | Promise<void>,
  args: string[],
): Promise<{ out: string; exited: number | null }> {
  const chunks: string[] = [];
  const [log, err, exit] = [console.log, console.error, Deno.exit];
  let exited: number | null = null;
  console.log = (...a: unknown[]) => chunks.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => chunks.push(a.map(String).join(" "));
  // deno-lint-ignore no-explicit-any
  (Deno as any).exit = (code = 0) => {
    exited = code;
    throw new Error("__exit__");
  };
  try {
    await fn(args, { app: APP, json: true });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "__exit__") throw e;
  } finally {
    console.log = log;
    console.error = err;
    // deno-lint-ignore no-explicit-any
    (Deno as any).exit = exit;
  }
  return { out: chunks.join("\n"), exited };
}

/** A second process holding `home`'s OS lock from ANOTHER apps root — the
 *  claim an instance booted there takes. Released by closing its stdin. */
async function holdFromOtherScope(base: string, home: string) {
  const script = join(base, "holder.ts");
  await Deno.writeTextFile(
    script,
    `import { claimHome } from ${JSON.stringify(LOCK_MOD)};\n` +
      `const c = claimHome(Deno.args[0], { appId: ${
        JSON.stringify(APP)
      }, port: 0, key: ${JSON.stringify(APP)} });\n` +
      `if (!c.ok) Deno.exit(3);\n` +
      `console.log("held");\n` +
      `await Deno.stdin.readable.pipeTo(new WritableStream());\n` +
      `c.close();\n`,
  );
  const env = Deno.env.toObject();
  env.AIO_APPS_DIR = join(base, "other-apps");
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, script, home],
    env,
    clearEnv: true,
    stdin: "piped",
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let seen = "";
  while (!seen.includes("held")) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += value;
  }
  assertStringIncludes(seen, "held", "the holder never took the claim");
  const stdin = child.stdin.getWriter();
  return {
    async release() {
      await stdin.close();
      await reader.cancel();
      assertEquals((await child.status).code, 0);
    },
  };
}

async function world() {
  const base = await tempDir("am-scope-");
  Deno.env.set("AIO_APPS_DIR", join(base, "apps"));
  _resetAppDirs();
  const d = appDirs(APP);
  ensureAppDirs(d);
  Deno.writeTextFileSync(d.stateDb, "LIVE");
  writeAppMeta(d, { appId: APP, aio: "1.0.0-test" });
  return { base, d };
}

async function done(base: string) {
  if (SUITE_HOME === undefined) Deno.env.delete("AIO_APPS_DIR");
  else Deno.env.set("AIO_APPS_DIR", SUITE_HOME);
  _resetAppDirs();
  await dropTempDir(base);
}

const REFUSED = "under another lock scope — stop it first";

Deno.test("am backup: an app running under another lock scope is refused, nothing written", async () => {
  const { base, d } = await world();
  const holder = await holdFromOtherScope(base, d.home);
  try {
    const dest = join(base, "bk");
    const r = await run(cmdBackup, [dest]);
    assertEquals(r.exited, 1, r.out);
    const { error } = JSON.parse(r.out) as { error: string };
    assert(error.startsWith(`"${APP}" is running from ${d.home}`), error);
    assertStringIncludes(error, REFUSED);
    for (const p of [dest, `${dest}.partial`]) {
      assert(
        !(() => {
          try {
            return Deno.statSync(p), true;
          } catch {
            return false;
          }
        })(),
        `${p} was written under a live writer`,
      );
    }
  } finally {
    await holder.release();
    await done(base);
  }
});

Deno.test("am restore: an app running under another lock scope is refused, data/ untouched", async () => {
  const { base, d } = await world();
  const src = join(base, "archive");
  Deno.mkdirSync(src);
  Deno.writeTextFileSync(join(src, "state.db"), "ARCHIVE");
  const holder = await holdFromOtherScope(base, d.home);
  try {
    const r = await run(cmdRestore, [src]);
    assertEquals(r.exited, 1, r.out);
    assertStringIncludes(r.out, REFUSED);
    assertEquals(Deno.readTextFileSync(d.stateDb), "LIVE");
    const left = [...Deno.readDirSync(d.home)].map((e) => e.name)
      .filter((n) => n.startsWith("data."));
    assertEquals(left, [], "a restore sibling was left beside data/");
  } finally {
    await holder.release();
    await done(base);
  }
});

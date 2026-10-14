// `clean:tmp` and the temp dirs of a test that is RUNNING.
//
// The sweep leaves a dir some live process refers to — on its command line,
// in its environment or cwd — or that the suite runner's owner file covers.
// A bare `deno test -A tests/x.test.ts` has no runner, its temp dirs are on
// no command line, and Windows shows nobody another process's environment:
// a dir such a test had not touched for ten minutes was deleted under it.
// So every process that makes one writes down that it did
// (`<test root>/.live-<pid>`, src/testing/temp-dir.ts), and the sweep reads
// that on every OS.
//
// The real script and the real writer, against a throwaway root.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { dropTempDir, LIVE_OWNER, tempDir } from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));
const OLD = new Date(Date.now() - 60 * 60_000);
const exists = (p: string) => Deno.stat(p).then(() => true).catch(() => false);
const records = (testRoot: string) =>
  [...Deno.readDirSync(testRoot)].map((e) => e.name)
    .filter((n) => n.startsWith(LIVE_OWNER));

async function sweep(root: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", `${ROOT}scripts/check-orphans.ts`, ...args],
    cwd: root,
    env: {
      AIO_ORPHANS_LOCK_ROOTS: root,
      AIO_TEST_ROOT: join(root, "test-root"),
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
}

/** A process that makes one temp dir through `tempDirSync`, prints it, and
 *  then either stays (until killed) or exits on its own. */
function maker(root: string, stay: boolean): Deno.ChildProcess {
  return new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      `import { tempDirSync } from ${
        JSON.stringify(spec(`${ROOT}src/testing/temp-dir.ts`))
      };
       console.log(tempDirSync("mine-"));
       ${stay ? "setInterval(() => {}, 1e6);" : ""}`,
    ],
    cwd: ROOT,
    env: { AIO_TEST_ROOT: join(root, "test-root") },
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
}

async function firstLine(p: Deno.ChildProcess): Promise<string> {
  const r = p.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await r.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  await r.cancel();
  return text.trim();
}

Deno.test("clean:tmp: a temp dir whose recorded owner is alive is never swept; once the owner is gone it is, and so is the record", async () => {
  const root = await tempDir("orphans-live-owner-");
  const testRoot = join(root, "test-root");
  const owner = maker(root, true);
  let killed = false;
  try {
    const mine = await firstLine(owner);
    assertEquals(await exists(mine), true, mine);
    assertEquals(records(testRoot), [`${LIVE_OWNER}${owner.pid}`]);
    // Untouched for an hour, on nobody's command line.
    await Deno.utime(mine, OLD, OLD);

    const kept = await sweep(root, "--clean");
    assertEquals(await exists(mine), true, kept);
    assertStringIncludes(kept, "0 ownerless temp dir(s)");

    // SIGKILLed: no exit sweep ran, the record is still there — and names a
    // process that is gone.
    owner.kill("SIGKILL");
    await owner.status;
    killed = true;
    assertEquals(records(testRoot).length, 1);
    const report = await sweep(root);
    assertStringIncludes(report, "1 ownerless temp dir(s)");
    const cleaned = await sweep(root, "--clean");
    assertEquals(await exists(mine), false, cleaned);
    assertEquals(records(testRoot), [], cleaned);
  } finally {
    if (!killed) {
      owner.kill("SIGKILL");
      await owner.status;
    }
    await dropTempDir(root);
  }
});

Deno.test("temp dirs: a process that exits on its own takes its owner record with it", async () => {
  const root = await tempDir("orphans-live-exit-");
  try {
    const p = maker(root, false);
    const mine = await firstLine(p);
    assertEquals((await p.status).code, 0);
    assertEquals(await exists(mine), false, "the exit sweep removes the dir");
    assertEquals(records(join(root, "test-root")), []);
  } finally {
    await dropTempDir(root);
  }
});

Deno.test("clean:tmp: a dir from aioTestDir() is in its maker's owner record — made before or after temp-dir.ts loaded", async () => {
  const root = await tempDir("orphans-live-strict-");
  const testRoot = join(root, "test-root");
  const owner = new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      `import { aioTestDir } from ${
        JSON.stringify(spec(`${ROOT}src/testing/test-strict.ts`))
      };
       const early = aioTestDir("early-");
       await import(${JSON.stringify(spec(`${ROOT}src/testing/temp-dir.ts`))});
       console.log(early + " " + aioTestDir("late-"));
       setInterval(() => {}, 1e6);`,
    ],
    cwd: ROOT,
    env: { AIO_TEST_ROOT: testRoot },
    stdout: "piped",
    stderr: "inherit",
  }).spawn();
  try {
    const dirs = (await firstLine(owner)).split(" ");
    assertEquals(dirs.length, 2);
    for (const d of dirs) await Deno.utime(d, OLD, OLD);
    const kept = await sweep(root, "--clean");
    for (const d of dirs) assertEquals(await exists(d), true, kept);
    assertStringIncludes(kept, "0 ownerless temp dir(s)");
  } finally {
    owner.kill("SIGKILL");
    await owner.status;
    await dropTempDir(root);
  }
});

// A test store that provisioned a framework version registered a worktree in
// the CHECKOUT's `.git`; `clean:tmp` removes the store and left the
// registration (the suite runner forgets them at its start — a bare run, or
// a round of killed ones, never reaches that).
Deno.test("clean:tmp: the worktree registration of a test store it removed is forgotten — one whose checkout still exists is kept", async () => {
  const root = await tempDir("orphans-worktrees-");
  const testRoot = join(root, "test-root");
  const reg = join(root, ".git", "worktrees");
  const gone = join(testRoot, "store-gone", "v1");
  const here = join(testRoot, "store-here", "v2");
  try {
    for (const [name, checkout] of [["v1", gone], ["v2", here]] as const) {
      await Deno.mkdir(join(reg, name), { recursive: true });
      await Deno.writeTextFile(
        join(reg, name, "gitdir"),
        join(checkout, ".git") + "\n",
      );
      await Deno.mkdir(checkout, { recursive: true });
      await Deno.writeTextFile(join(checkout, ".git"), "gitdir: x\n");
    }
    // The store of `v1`: abandoned an hour ago. `v2`'s was touched just now.
    await Deno.utime(join(testRoot, "store-gone"), OLD, OLD);
    const cleaned = await sweep(root, "--clean");
    assertEquals(await exists(gone), false, cleaned);
    assertStringIncludes(cleaned, "1 worktree registration(s)");
    assertEquals(
      [...Deno.readDirSync(reg)].map((e) => e.name),
      ["v2"],
      cleaned,
    );
  } finally {
    await dropTempDir(root);
  }
});

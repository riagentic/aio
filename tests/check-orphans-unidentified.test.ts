// `check:orphans`: a lock with no start token whose LIVE pid cannot be
// identified is red.
//
// Such a lock is judged by what its process is. "Positively another program"
// is a stale lock, said and passed. "Cannot tell" — a live pid this account
// may not read — was said and passed too: an app left running under such a
// pid went through the gate with one printed line. It is never signalled
// (it may be anybody's), and it fails the gate.
//
// The real script, against a throwaway root (`AIO_ORPHANS_LOCK_ROOTS`).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url));

async function run(
  root: string,
  ...args: string[]
): Promise<{ code: number; text: string }> {
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
  const d = new TextDecoder();
  return { code: out.code, text: d.decode(out.stdout) + d.decode(out.stderr) };
}

Deno.test({
  name:
    "check-orphans: a tokenless lock naming a live pid that cannot be identified fails the gate, unsignalled",
  ignore: Deno.build.os === "windows" || Deno.uid() === 0, // a live pid nobody but root can read: pid 1; Windows names every pid's image (tasklist), so none is unidentifiable
  fn: async () => {
    const root = await tempDir("orphans-unidentified-");
    try {
      const dir = join(root, "aio-whose");
      await Deno.mkdir(dir, { recursive: true });
      const lock = join(dir, "whose.lock");
      await Deno.writeTextFile(
        lock,
        JSON.stringify({
          appId: "whose",
          pid: 1,
          port: 0,
          status: "started",
          cwd: root,
          home: root,
          startedAt: Date.now() - 5 * 60 * 60_000,
        }),
      );
      const report = await run(root);
      assertStringIncludes(
        report.text,
        "unverifiable (no start token)  pid 1  whose",
      );
      assertStringIncludes(report.text, `lock: ${lock}`);
      assertStringIncludes(report.text, "1 lock(s) with no start token");
      assertEquals(report.code, 1, report.text);
      // Not in the list `clean:tmp` signals.
      assert(!report.text.includes("ORPHAN  pid 1 "), report.text);
      const cleaned = await run(root, "--clean");
      assertStringIncludes(cleaned.text, "0 orphan(s) signalled");
    } finally {
      await dropTempDir(root);
    }
  },
});

// `install-record.ts` as a COMMAND: what `run.sh` / `run.ps1` read.
//
// Both scripts take its stdout as the value — `prev_src=$(… conflict …)`,
// `pruned=$(… prune …)`. It was printed through the logger, so the value was
// "2026-10-12 12:19:12.020+02:00  INFO   aio         <value>": `run.sh` said
// "pruned older version(s): 2026-… INFO aio 0.1.1-…", and the refusal of a
// second source named a log line as where the app was "installed from".
import { assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

// (`fromFileUrl`: a URL's pathname is `/C:/…` on Windows — no path there)
const CLI = fromFileUrl(
  new URL("../src/server/install-record.ts", import.meta.url),
);
const CONFIG = fromFileUrl(new URL("../deno.json", import.meta.url));

Deno.test("install-record CLI: write, conflict and prune answer in plain lines — the value and nothing else", async () => {
  const root = await tempDir("install-record-cli-");
  const run = async (...args: string[]) => {
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--no-check", "--config", CONFIG, CLI, ...args],
      // The install root, and a home of its own: nothing of this test lands
      // in the real one.
      env: { AIO_INSTALL_ROOT: root, HOME: root, USERPROFILE: root },
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: out.code,
      out: new TextDecoder().decode(out.stdout),
      err: new TextDecoder().decode(out.stderr),
    };
  };
  try {
    const dir = join(root, "zz");
    const wrote = await run("write", "--name=zz", "--version=3", "--source=a");
    assertEquals(wrote.code, 0, wrote.err);
    assertEquals(wrote.out.trim().split(/\r?\n/).length, 1, wrote.out);
    assertEquals(
      JSON.parse(await Deno.readTextFile(wrote.out.trim())).source,
      "a",
      "the one line is the record's path",
    );

    // The same source: nothing. Another: the source it was installed from.
    assertEquals((await run("conflict", "--name=zz", "--source=a")).out, "");
    const other = await run("conflict", "--name=zz", "--source=b");
    assertEquals([other.code, other.out], [0, "a\n"]);

    let day = 0;
    for (const v of ["1", "2", "3"]) {
      await Deno.mkdir(join(dir, "versions", v), { recursive: true });
      const when = new Date(2020, 0, ++day);
      await Deno.utime(join(dir, "versions", v), when, when);
    }
    const pruned = await run(
      "prune",
      "--name=zz",
      "--keep=1",
      `--current=${join(dir, "versions", "3")}`,
    );
    assertEquals(pruned.code, 0, pruned.err);
    assertEquals(pruned.out.split(/\r?\n/).filter(Boolean).sort(), ["1", "2"]);

    // A refusal is not an answer: stderr, exit 2, stdout empty.
    const bad = await run("bogus", "--name=zz");
    assertEquals([bad.code, bad.out], [2, ""]);
    assertEquals(bad.err.includes('unknown command "bogus"'), true, bad.err);
  } finally {
    await dropTempDir(root);
  }
});

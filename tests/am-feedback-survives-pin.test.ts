// `am feedback` — the findings file must outlive the framework version it was
// written against.
//
// The project asks every app built on aio to write its rough edges down, and
// `.katana/_aio.md` said, four times, to put them in `dep/aio/feedback/<app>.md`.
// That path was wrong twice over, and both ways cost the project exactly the
// reports it was asking for:
//
//   1. Under a VERSION pin, `dep/aio` is a provisioned worktree of a release,
//      and a release excludes `feedback/` — correctly, it holds other people's
//      private reports. So the named directory did not exist at all, precisely
//      when an app had done the recommended thing and pinned.
//   2. `dep/aio` lives INSIDE the version store. A file written there belongs
//      to one version: `am pin latest` provisions a new directory and the notes
//      are orphaned; pruning the old version deletes them.
//
// The guard that matters is the last test: the location must not be under the
// version store. Everything else is spelling.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { feedbackDir, feedbackFile } from "../src/am/am-cmd-feedback.ts";
import { versionsDir } from "../src/server/framework-pin.ts";

const REPO = new URL("..", import.meta.url).pathname;

async function am(
  args: string[],
  dir: string,
): Promise<{ code: number; out: string }> {
  const p = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", `${REPO}src/am.ts`, ...args, "--json"],
    env: { AIO_FEEDBACK_DIR: dir },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: p.code,
    out: new TextDecoder().decode(p.stdout) +
      new TextDecoder().decode(p.stderr),
  };
}

Deno.test("am feedback: the findings location is NOT inside the version store", () => {
  // THE assertion. A path under the version store is deleted by an upgrade,
  // which is the whole defect. Checked against the real default, so setting
  // the override cannot make this pass vacuously.
  // Both paths are only COMPUTED here (no file is touched), so reading the
  // real defaults is safe — and the harness's store sandbox pins both vars,
  // which would otherwise compare two sandbox paths.
  const original = Deno.env.get("AIO_FEEDBACK_DIR");
  const originalStore = Deno.env.get("AIO_VERSIONS_DIR");
  Deno.env.delete("AIO_FEEDBACK_DIR");
  Deno.env.delete("AIO_VERSIONS_DIR");
  try {
    const dir = feedbackDir();
    const store = versionsDir();
    assert(
      !dir.startsWith(store),
      `findings would be written under the version store (${dir} is inside ` +
        `${store}) — \`am pin latest\` orphans them and pruning deletes them`,
    );
    assert(dir.length > 0 && dir !== "/", `implausible feedback dir: ${dir}`);
  } finally {
    if (original !== undefined) Deno.env.set("AIO_FEEDBACK_DIR", original);
    if (originalStore !== undefined) {
      Deno.env.set("AIO_VERSIONS_DIR", originalStore);
    }
  }
});

Deno.test("am feedback: a name becomes a filename, never a path", () => {
  const dir = feedbackDir();
  // A findings file is named after an app, and an app name is user input. It
  // must reduce to one filename inside the directory — anything that escapes
  // it turns a note into an overwrite.
  for (
    const hostile of [
      "../../etc/passwd",
      "/etc/passwd",
      "a/b/c",
      "..",
      ".",
      "  My App!  ",
      "x".repeat(200),
    ]
  ) {
    const f = feedbackFile(hostile);
    assert(
      f.startsWith(dir + "/"),
      `"${hostile}" escaped the feedback dir: ${f}`,
    );
    const base = f.slice(dir.length + 1);
    assert(
      !base.includes("/") && base !== ".md" && base.endsWith(".md"),
      `"${hostile}" produced a bad filename: ${base}`,
    );
  }
  assertEquals(feedbackFile("My App!"), `${dir}/my-app.md`);
});

Deno.test("am feedback: reports the directory, and creates a file on request", async () => {
  const dir = await tempDir("am-feedback-");
  try {
    const listing = await am(["feedback"], dir);
    assertEquals(listing.code, 0, listing.out);
    const parsed = JSON.parse(listing.out) as {
      dir: string;
      files: string[];
    };
    assertEquals(parsed.dir, dir);
    assertEquals(parsed.files, [], "a fresh directory listed phantom files");

    // Naming an app without --create must NOT write: printing a path is a
    // question, and answering it by creating a file is a side effect nobody
    // asked for.
    const asked = await am(["feedback", "demo"], dir);
    assertEquals(asked.code, 0, asked.out);
    assertEquals((JSON.parse(asked.out) as { exists: boolean }).exists, false);
    assertEquals([...Deno.readDirSync(dir)].length, 0);

    const made = await am(["feedback", "demo", "--create"], dir);
    assertEquals(made.code, 0, made.out);
    const file = (JSON.parse(made.out) as { file: string }).file;
    assertEquals(file, `${dir}/demo.md`);
    const body = await Deno.readTextFile(file);
    assertStringIncludes(body, "demo");
    assertStringIncludes(body, "am pin");

    // Re-creating must not clobber what someone has written.
    await Deno.writeTextFile(file, body + "\n## 2 · my real finding\n");
    await am(["feedback", "demo", "--create"], dir);
    assertStringIncludes(
      await Deno.readTextFile(file),
      "my real finding",
      "--create overwrote an existing findings file",
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("am feedback: the kata points at the command, not the doomed path", async () => {
  const kata = await Deno.readTextFile(`${REPO}.katana/_aio.md`);
  assertStringIncludes(
    kata,
    "am feedback",
    "the kata must name the command; a hard-coded path drifts and this one " +
      "pointed into a directory that does not exist under a version pin",
  );
  assert(
    !/reported into\s+dep\/aio\/feedback/.test(kata),
    "the kata still instructs apps to write into dep/aio/feedback — that is " +
      "inside the version store and absent from a release",
  );
});

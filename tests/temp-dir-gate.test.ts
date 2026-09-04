// The unswept-temp-directory ratchet must be able to SEE an unswept directory.
//
// 50audits §11: `src/testing/temp-dir.ts` claims to be the ONE decider for "this
// test needs a throwaway directory", and 810 direct `Deno.makeTempDir` calls in
// `tests/` disagree — none of them registered, none of them swept, which is
// what left `check:orphans` red at 963 abandoned directories against a ceiling
// of 400. No rule forbade the direct call, so the leak could only grow.
//
// A gate with no test of its own is the "verify the instrument" trap wearing a
// ratchet, so this runs the scanner on TEXT and pins what it must catch, what
// it must not, and that an `aio-ok:` justification is read from the comment the
// code mask blanks.
import { assertEquals } from "@std/assert";
import { scanSource } from "../scripts/check-temp-dirs.ts";

Deno.test("temp-dir gate: it sees both spellings of the direct call", () => {
  const r = scanSource(`
    const a = await Deno.makeTempDir();
    const b = Deno.makeTempDirSync({ prefix: "x" });
    const c = await Deno.makeTempDir({ prefix: "y" });
  `);
  assertEquals(r.hits.length, 3, JSON.stringify(r.hits));
  assertEquals(r.justified, 0);
});

Deno.test("temp-dir gate: the decider itself does not count", () => {
  const r = scanSource(`
    import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
    const dir = await tempDir("ok-");
    const two = tempDirSync("ok-");
    keepTempDir(somewhereElse);
    await dropTempDir(dir);
  `);
  assertEquals(r.hits.length, 0, JSON.stringify(r.hits));
});

Deno.test("temp-dir gate: a makeTempFile is not a directory tree", () => {
  assertEquals(
    scanSource(`const f = await Deno.makeTempFile();`).hits.length,
    0,
  );
});

Deno.test("temp-dir gate: prose about the call is not the call", () => {
  const r = scanSource(`
    // Deno.makeTempDir() is what this used to do.
    /* Deno.makeTempDirSync() too. */
    const s = "Deno.makeTempDir()";
  `);
  assertEquals(r.hits.length, 0, JSON.stringify(r.hits));
});

Deno.test("temp-dir gate: aio-ok on the line, or the one above, justifies", () => {
  const here = scanSource(
    `const d = await Deno.makeTempDir(); // aio-ok: this test reads /tmp itself`,
  );
  assertEquals(here.hits.length, 0);
  assertEquals(here.justified, 1);

  const above = scanSource(`
    // aio-ok: this test reads /tmp itself
    const d = await Deno.makeTempDir();
  `);
  assertEquals(above.hits.length, 0);
  assertEquals(above.justified, 1);

  // A bare marker is a mute button, not an acknowledgement.
  const bare = scanSource(`const d = await Deno.makeTempDir(); // aio-ok`);
  assertEquals(bare.hits.length, 1);
  assertEquals(bare.justified, 0);
});

Deno.test("temp-dir gate: it reports the line the call is on", () => {
  const r = scanSource("a();\nb();\nconst d = await Deno.makeTempDir();\n");
  assertEquals(r.hits, [3]);
});

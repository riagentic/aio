// The copied-journal scrub must never cost an acked write.
//
// A journal v1.0.11 (or older) wrote records a `persist: "none"` call WITH its
// arguments and no data line for the `listensTo` reactions it caused: the raw
// call is the only record of what it did to a PERSISTED cell. The copy scrub
// (aio-boot.ts `scrubStoreCopies`) blanked every such call in an `am backup`
// / `data.replaced-*` journal and replay skipped it without a word — so
// restoring that backup came back with `audit.seen` 1 where v1.0.11 itself
// recovers 3. A reaction cannot be re-derived without the argument (this one
// reads it), and re-running it on a blanked one would be a silent wrong
// value. So a call some cell `listensTo` is KEPT in the copy — the copy is
// named in a warning, as a quarantined `.corrupt-*` copy is — and a call no
// cell listens to (nothing to re-derive) is scrubbed.
//
// Built from a data directory v1.0.11-beta really wrote and crashed on
// (tests/fixtures/v1.0.11-crashed-none-listener).
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MOD = new URL("../mod.ts", import.meta.url).href;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;
const FIXTURE =
  new URL("./fixtures/v1.0.11-crashed-none-listener/", import.meta.url)
    .pathname;

async function boot(dir: string): Promise<string> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--config", CONFIG, join(FIXTURE, "app.js")],
    env: {
      DIR: dir,
      PORT: String(freePort()),
      AIO_APPS_DIR: dir,
      XDG_RUNTIME_DIR: dir,
      PHASE: "read",
      MOD,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout) +
    new TextDecoder().decode(out.stderr);
  if (!out.success) throw new Error(text);
  return text;
}

async function copyData(to: string): Promise<void> {
  await Deno.mkdir(to, { recursive: true });
  for await (const f of Deno.readDir(join(FIXTURE, "data"))) {
    await Deno.copyFile(join(FIXTURE, "data", f.name), join(to, f.name));
  }
}

Deno.test(`persist:"none": a v1.0.11 journal copy keeps a listened-to call (named in a warning) and scrubs the rest — restoring it recovers every acked reaction`, async () => {
  const dir = await tempDir("aio-scrub-old-listener-");
  try {
    const expected = JSON.parse(
      await Deno.readTextFile(join(FIXTURE, "v1.0.11-recovered.json")),
    );
    // The crashed data is live AND in an `am backup` copy.
    await copyData(join(dir, "data"));
    const copy = join(dir, "backups", "none-listener-fixture-backup-x", "data");
    await copyData(copy);
    const copyJournal = join(copy, "journal");

    // 1. This build boots: the live journal replays; the copy is scrubbed.
    const first = await boot(dir);
    const after = await Deno.readTextFile(copyJournal);
    assert(
      !after.includes("SECRET-OTHER"),
      `a call no cell listens to still holds its argument:\n${after}`,
    );
    assert(
      after.includes("SECRET-BB") && after.includes("SECRET-CCC"),
      `a listened-to call was scrubbed — its reaction is lost:\n${after}`,
    );
    assert(
      first.includes(copyJournal) && /listensTo/.test(first),
      `the kept copy is not named in a warning:\n${first}`,
    );

    // 2. `am restore` of that backup: the current data moved aside, the copy
    //    put in its place. Every acked reaction comes back.
    await Deno.rename(join(dir, "data"), join(dir, "data.replaced-x"));
    await Deno.rename(copy, join(dir, "data"));
    const restored = await boot(dir);
    assertEquals(
      JSON.parse(await Deno.readTextFile(join(dir, "recovered.json"))),
      expected,
      `restoring the scrubbed copy lost acked reactions:\n${restored}`,
    );

    // 3. Said once: an unchanged copy is not re-read or re-said.
    await copyData(copy);
    await boot(dir); // the fresh copy: said
    const again = await boot(dir);
    assert(!again.includes(copyJournal), again);
  } finally {
    await dropTempDir(dir);
  }
});

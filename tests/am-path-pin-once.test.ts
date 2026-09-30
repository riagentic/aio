// A path-pinned app says "local path pin → …" ONCE per am invocation.
//
// It said it twice: `deno task am` runs ./dep/aio/src/am.ts, which read the
// pin through the framework's announcing reader (line 1), then — because the
// spelling `<app>/dep/aio/src/am.ts` differed from `<checkout>/src/am.ts` even
// when dep/aio is a symlink to that checkout — re-exec'd the SAME am as a new
// process, which read it again (line 2), plus a hand-off note every time.
import { assert, assertEquals } from "@std/assert";
import { tempDir } from "../src/testing/temp-dir.ts";
import { fromFileUrl, join, toFileUrl } from "@std/path";
import { readPinQuiet, sameFile } from "../src/am.ts";

const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

async function app(): Promise<string> {
  const dir = await tempDir("aio-pin-once-");
  await Deno.mkdir(join(dir, ".aio"));
  await Deno.mkdir(join(dir, "dep"));
  await Deno.symlink(ROOT, join(dir, "dep", "aio"));
  await Deno.writeTextFile(join(dir, ".aio", "pin.local"), `${ROOT}\n`);
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ name: "pin-once", aioVersion: "v1.0.0-alpha1" }),
  );
  return dir;
}

Deno.test("readPinQuiet: local override first, deno.json second, no output", async () => {
  const dir = await app();
  try {
    const err: string[] = [];
    const real = console.error;
    console.error = (...a: unknown[]) => err.push(a.join(" "));
    try {
      assertEquals(readPinQuiet(dir), `path:${ROOT}`);
      await Deno.remove(join(dir, ".aio", "pin.local"));
      assertEquals(readPinQuiet(dir), "v1.0.0-alpha1");
    } finally {
      console.error = real;
    }
    assertEquals(err, []);
    assertEquals(readPinQuiet(join(dir, "nowhere")), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("sameFile sees through the dep/aio symlink", async () => {
  const dir = await app();
  try {
    assert(sameFile(join(dir, "dep/aio/src/am.ts"), join(ROOT, "src/am.ts")));
    assert(!sameFile(join(dir, "deno.json"), join(ROOT, "deno.json")));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("delegation compares a real path, not a URL pathname (a space in the path)", async () => {
  // `new URL(import.meta.url).pathname` keeps percent-encoding, so a checkout
  // under `…/My App/…` compared `…/My%20App/…` against `…/My App/…`, never
  // matched, and re-exec'd itself on every command. `fromFileUrl` is the path.
  const dir = await tempDir("aio-pin-space-");
  try {
    const spaced = join(dir, "my app");
    await Deno.mkdir(spaced);
    const entry = join(spaced, "am.ts");
    await Deno.writeTextFile(entry, "// x\n");
    const url = toFileUrl(entry).href;
    assert(
      !sameFile(new URL(url).pathname, entry),
      "precondition: pathname keeps %20",
    );
    assert(sameFile(fromFileUrl(url), entry), "fromFileUrl is the real path");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("`deno task am` in a linked, path-pinned app: one pin line, no hand-off", async () => {
  const dir = await app();
  try {
    const r = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", join(dir, "dep/aio/src/am.ts"), "pin"],
      cwd: dir,
      env: { ...Deno.env.toObject(), NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    // log.info lands on stdout, the hand-off note on stderr: read both.
    const err = new TextDecoder().decode(r.stdout) + "\n" +
      new TextDecoder().decode(r.stderr);
    const pinLines = err.split("\n").filter((l) =>
      l.includes("local path pin")
    );
    assertEquals(pinLines.length, 1, err);
    assert(!err.includes("using the pinned checkout's am"), err);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

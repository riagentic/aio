// The icon the build writes into the one-click Windows exe, read back by
// somebody else's reader: icoutils' `wrestool` and `icotool`. The repo's own
// reader (tests/pe-icon.test.ts) was written beside the writer, and would
// agree with it about a mistake they share.
import { assertEquals, assertExists } from "@std/assert";
import { join } from "@std/path";
import { prebuiltStubPath } from "../src/build/build-windows-exe.ts";
import { appIconIco, ICO_SIZES } from "../src/build/app-icon.ts";
import { icoImages, peWithIcon } from "../src/build/pe-icon.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function run(cmd: string, args: string[]): Promise<Uint8Array | null> {
  try {
    const out = await new Deno.Command(cmd, { args, stderr: "null" }).output();
    return out.success ? out.stdout : null;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}
const ICOUTILS = await run("wrestool", ["--version"]) !== null &&
  await run("icotool", ["--version"]) !== null;

Deno.test({
  name:
    "wrestool lists one icon group and its icons in the stub, and icotool reads the sizes out of it",
  // icoutils is a Linux developer tool, not a dependency: without it the
  // repo's own reader (the test above) is the only witness.
  ignore: !ICOUTILS,
  async fn() {
    const tmp = await tempDir("aio-pe-icon-");
    try {
      const exe = join(tmp, "stub-icon.exe");
      const ICO = await appIconIco("My App", "myapp");
      const made = peWithIcon(await Deno.readFile(prebuiltStubPath()), ICO);
      if ("refused" in made) throw new Error(made.refused);
      await Deno.writeFile(exe, made.pe);
      const listing = new TextDecoder().decode(
        (await run("wrestool", ["-l", exe]))!,
      ).trim().split("\n");
      assertEquals(
        listing.map((l) => l.replace(/ \[.*$/, "")),
        [
          ...ICO_SIZES.map((_, i) =>
            `--type=3 --name=${i + 1} --language=1033`
          ),
          "--type=14 --name=1 --language=1033",
        ],
      );
      const ico = join(tmp, "out.ico");
      await Deno.writeFile(ico, (await run("wrestool", ["-x", "-t14", exe]))!);
      const sizes = new TextDecoder().decode(
        (await run("icotool", ["-l", ico]))!,
      )
        .trim().split("\n");
      assertEquals(
        sizes,
        ICO_SIZES.map((s, i) =>
          `--icon --index=${
            i + 1
          } --width=${s} --height=${s} --bit-depth=32 --palette-size=0`
        ),
      );
      // …and the image it extracts is the one that went in.
      const png = join(tmp, "256.png");
      assertExists(await run("icotool", ["-x", "-i", "1", "-o", png, ico]));
      const want = (icoImages(ICO) as { data: Uint8Array }[])[0]!.data;
      assertEquals([...await Deno.readFile(png)], [...want]);
    } finally {
      await dropTempDir(tmp);
    }
  },
});

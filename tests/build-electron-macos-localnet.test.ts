// macOS 15+ asks, per app, before it may reach a device on the local network —
// and does not ask an app whose Info.plist carries no
// `NSLocalNetworkUsageDescription`: the connection just fails, as if the
// server were down. A packaged aio window pointed at a LAN server had none.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { withLocalNetworkUsage } from "../src/build/build-electron.ts";
import { macAppPlist } from "../src/build/macos-app.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const base = () =>
  macAppPlist({
    name: `Tom & Jerry's <Notes>`,
    executable: "notes",
    identifier: "app.aio.notes",
    iconFile: "icon",
    version: "1.2.3",
  });

Deno.test("macOS bundle: the Info.plist states why the app uses the local network", () => {
  const before = base();
  assert(!before.includes("NSLocalNetworkUsageDescription"));
  const plist = withLocalNetworkUsage(before, `Tom & Jerry's <Notes>`);
  const m =
    /<key>NSLocalNetworkUsageDescription<\/key>\s*<string>([^<]*)<\/string>/
      .exec(plist);
  assert(m, plist);
  // A plain sentence that names the app, escaped once.
  assertEquals(
    m[1],
    "Tom &amp; Jerry&apos;s &lt;Notes&gt; connects to servers and devices " +
      "on your local network.",
  );
  // Nothing else moved: the rest of the plist is byte-for-byte the same.
  assertEquals(
    plist.replace(
      /\s*<key>NSLocalNetworkUsageDescription<\/key>\s*<string>[^<]*<\/string>/,
      "",
    ),
    before,
  );
  // Said once, however often the build runs.
  assertEquals(withLocalNetworkUsage(plist, "x"), plist);
});

Deno.test("macOS bundle: a description the plist already carries is the app's — kept", () => {
  const own = base().replace(
    "</dict>",
    "  <key>NSLocalNetworkUsageDescription</key>\n  <string>Mine.</string>\n</dict>",
  );
  assertEquals(withLocalNetworkUsage(own, "Notes"), own);
});

Deno.test("macOS bundle: the key is written before the bundle is signed or packed", async () => {
  const src = await Deno.readTextFile(
    new URL("../src/build/build-electron.ts", import.meta.url),
  );
  const assemble = src.indexOf("const app = await assembleMacApp(");
  const write = src.indexOf(
    "withLocalNetworkUsage(await Deno.readTextFile(infoPlist)",
  );
  const sign = src.indexOf("if (canFinalizeDmg(cfg.macosHost))");
  const zip = src.indexOf("await zipAppBundle(app, zipOut)");
  assert(assemble > 0 && write > assemble, "not written after assembly");
  assert(sign > write && zip > write, "written after the bundle is packed");
});

Deno.test({
  name: "macOS bundle: plutil accepts the plist and reads the sentence back",
  ignore: Deno.build.os !== "darwin", // plutil is macOS's own plist tool
  async fn() {
    const dir = await tempDir("aio-localnet-plist-");
    try {
      const f = `${dir}/Info.plist`;
      await Deno.writeTextFile(
        f,
        withLocalNetworkUsage(base(), `Tom & Jerry's <Notes>`),
      );
      const run = async (...args: string[]) => {
        const o = await new Deno.Command("plutil", {
          args,
          stdout: "piped",
          stderr: "piped",
        }).output();
        return {
          code: o.code,
          out: new TextDecoder().decode(o.stdout) +
            new TextDecoder().decode(o.stderr),
        };
      };
      const lint = await run("-lint", f);
      assertEquals(lint.code, 0, lint.out);
      const got = await run(
        "-extract",
        "NSLocalNetworkUsageDescription",
        "raw",
        "-o",
        "-",
        f,
      );
      assertStringIncludes(
        got.out,
        "Tom & Jerry's <Notes> connects to servers and devices on your local network.",
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});

// `aio build --web` empties `<root>/<bin>-web` and `--targets=ios-client`
// replaces `<root>/<bin>-ios-client` — with no ownership check, a user folder
// that happened to share the name lost its contents. The dist/ rule now covers
// both: a directory with files but without the build's own signed file was
// never aio's — refused, naming the files, deleting nothing.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { emptyDir, foreignArtifactRefusal } from "../src/build/dist-staging.ts";
import { versionStamp } from "../src/build/build-bundle.ts";
import { VERSION_STAMP } from "../src/protocol/protocol-version.ts";
import { IOS_SIGN } from "../src/build/build-ios.ts";
import { IOS_TEMPLATE } from "../src/build/ios-template.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("artifact dir: absent, empty or dotfiles-only is not foreign; the build's own stamped file makes it aio's", async () => {
  const dir = await tempDir("aio-artifact-dir-");
  try {
    const site = join(dir, "x-web");
    const [js, sign] = ["app.js", `globalThis.${VERSION_STAMP} =`];
    assertEquals(await foreignArtifactRefusal(site, js, sign), null);
    await Deno.mkdir(site);
    await Deno.writeTextFile(join(site, ".DS_Store"), "");
    assertEquals(await foreignArtifactRefusal(site, js, sign), null);
    await Deno.writeTextFile(join(site, "index.html"), "<p>mine</p>");
    const said = await foreignArtifactRefusal(site, js, sign);
    assert(said);
    assertStringIncludes(said, "index.html");
    assertStringIncludes(said, "DELETED");
    // A bundle of the user's own is not ours either.
    await Deno.writeTextFile(join(site, js), "console.log(1);\n");
    assert(await foreignArtifactRefusal(site, js, sign));
    // The one an aio build stamps is.
    await Deno.writeTextFile(join(site, js), versionStamp("1.0.0") + "x();\n");
    assertEquals(await foreignArtifactRefusal(site, js, sign), null);
    // The iOS project the template generates carries its sign.
    assertStringIncludes(IOS_TEMPLATE["App/ViewController.swift"]!, IOS_SIGN);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("artifact dir: a web build over a user folder of that name refuses and deletes nothing", async () => {
  const dir = await tempDir("aio-web-foreign-");
  try {
    const site = join(dir, "probe-web");
    await Deno.mkdir(site);
    await Deno.writeTextFile(join(site, "notes.txt"), "mine\n");
    const script = join(dir, "run.ts");
    await Deno.writeTextFile(
      script,
      `import { buildWeb } from ${
        JSON.stringify(new URL("../src/build/build-web.ts", import.meta.url))
      };\nawait buildWeb({ root: ${JSON.stringify(dir)}, dist: ${
        JSON.stringify(join(dir, "dist"))
      }, binaryName: "probe" } as never);\n`,
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        `--config=${fromFileUrl(new URL("../deno.json", import.meta.url))}`,
        script,
      ],
      env: { NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const said = new TextDecoder().decode(out.stderr);
    assertEquals(out.code, 1, said);
    assertStringIncludes(said, "notes.txt");
    assertEquals(await Deno.readTextFile(join(site, "notes.txt")), "mine\n");
  } finally {
    await dropTempDir(dir);
  }
});

// A build interrupted while it EMPTIES its folder (Ctrl-C, a crash, a full
// disk) must leave one the next build still recognises. Emptied in readdir
// order, the stamped file could go first: the half-emptied folder then read
// as a user's, and every later build refused it until it was deleted by hand.
Deno.test("artifact dir: a clean interrupted at ANY removal leaves a folder the next build accepts", async () => {
  const dir = await tempDir("aio-artifact-interrupt-");
  const realRemove = Deno.remove;
  try {
    const layouts: [string, string, string, Record<string, string>][] = [
      ["x-web", "app.js", `globalThis.${VERSION_STAMP} =`, {
        "app.js": versionStamp("1.0.0") + "x();\n",
      }],
      ["x-ios-client", "App/ViewController.swift", IOS_SIGN, IOS_TEMPLATE],
    ];
    for (const [name, mark, sign, own] of layouts) {
      const site = join(dir, name);
      const fill = async () => {
        for (const [rel, text] of Object.entries(own)) {
          await Deno.mkdir(join(site, rel, ".."), { recursive: true });
          await Deno.writeTextFile(join(site, rel), text);
        }
        await Deno.mkdir(join(site, "App"), { recursive: true });
        for (let i = 0; i < 12; i++) {
          await Deno.writeTextFile(join(site, `f${i}.txt`), "x");
          await Deno.writeTextFile(join(site, "App", `g${i}.txt`), "x");
        }
      };
      let removals = 0;
      for (let stopAt = 0;; stopAt++) {
        await fill();
        assertEquals(await foreignArtifactRefusal(site, mark, sign), null);
        let n = 0;
        Deno.remove = ((path: string | URL, o?: Deno.RemoveOptions) => {
          if (n++ === stopAt) throw new Error("interrupted");
          return realRemove(path, o);
        }) as typeof Deno.remove;
        const done = await emptyDir(site, [mark]).then(() => true, () => false);
        Deno.remove = realRemove;
        assertEquals(
          await foreignArtifactRefusal(site, mark, sign),
          null,
          `${name}: interrupted at removal ${stopAt}`,
        );
        if (done) {
          removals = n;
          break;
        }
      }
      assert(removals > 12, `${name}: the instrument interrupted nothing`);
    }
  } finally {
    Deno.remove = realRemove;
    await dropTempDir(dir);
  }
});

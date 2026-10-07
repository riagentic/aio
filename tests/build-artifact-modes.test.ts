// What a package holds must not depend on who built it.
//
// Every packer (zip, tar, squashfs, hdiutil) stores the modes it finds, and a
// staged tree is written under the builder's umask. Built under umask 077, an
// installed macOS app was `drwx------` with an owner-only Info.plist — another
// account on that Mac could not open it — and an AppImage's inner directories
// were the same. Each test below stages under umask 077, the case that broke,
// and reads the modes of what the packer was handed.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join, relative } from "@std/path";
import {
  artifactMode,
  moveArtifact,
  normalizeArtifactModes,
  runAppimagetool,
} from "../src/build/build-helpers.ts";
import { zipDir } from "../src/build/build-electron.ts";
import { assembleMacApp } from "../src/build/macos-app.ts";
import { localDmgScript, remoteDmgScript } from "../src/build/dmg.ts";
import { buildWeb, webArtifactName } from "../src/build/build-web.ts";
import { buildIos, iosProjectDir } from "../src/build/build-ios.ts";
import { resolveBuildVersion } from "../src/build/build-version.ts";
import { versionStamp } from "../src/build/build-bundle.ts";
import { BUNDLE_JS } from "../src/server/app-files.ts";
import { MAC_WINDOW_LINK } from "../src/electron/electron-runtime-fetch.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const POSIX = Deno.build.os !== "windows";

/** Run `fn` as a builder with umask 077 would; restore the umask after. */
async function ownerOnlyUmask<T>(fn: () => Promise<T>): Promise<T> {
  const was = Deno.umask(0o077);
  try {
    return await fn();
  } finally {
    Deno.umask(was);
  }
}

/** `path → octal mode` for every directory (named with a trailing `/`, the
 *  root as `./`) and regular file under `root`; links left out. */
async function modes(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string) => {
    const st = await Deno.lstat(dir);
    out[`${relative(root, dir) || "."}/`] = (st.mode! & 0o7777).toString(8);
    for await (const e of Deno.readDir(dir)) {
      const p = join(dir, e.name);
      if (e.isDirectory) await walk(p);
      else if (e.isFile) {
        out[relative(root, p)] = ((await Deno.lstat(p)).mode! & 0o7777)
          .toString(8);
      }
    }
  };
  await walk(root);
  return out;
}

/** `path → target` for every symbolic link under `root`. A linked directory
 *  is not entered. */
async function links(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string) => {
    for await (const e of Deno.readDir(dir)) {
      const p = join(dir, e.name);
      if (e.isSymlink) out[relative(root, p)] = await Deno.readLink(p);
      else if (e.isDirectory) await walk(p);
    }
  };
  await walk(root);
  return out;
}

/** Every directory and every named executable is 755, every other file 644. */
function assertStated(found: Record<string, string>, executables: string[]) {
  const want = (p: string) =>
    p.endsWith("/") || executables.includes(p) ? "755" : "644";
  assertEquals(
    Object.entries(found).filter(([p, m]) => m !== want(p)),
    [],
    "modes that follow the builder's umask",
  );
  for (const exe of executables) assertEquals(found[exe], "755", exe);
  assert(Object.values(found).includes("644"), "no plain file was checked");
}

Deno.test("artifact modes: a directory and an executable are 0755, any other file 0644", () => {
  assertEquals(
    [
      artifactMode("dir", 0o700),
      artifactMode("dir", 0o777),
      artifactMode("file", 0o600),
      artifactMode("file", 0o666),
      artifactMode("file", 0o400),
      // Any exec bit is an executable — and group/other never get WRITE.
      artifactMode("file", 0o700),
      artifactMode("file", 0o100),
      artifactMode("file", 0o777),
      artifactMode("file", 0o4755),
    ].map((m) => m.toString(8)),
    ["755", "755", "644", "644", "644", "755", "755", "755", "755"],
  );
});

Deno.test({
  name:
    "artifact modes: a tree staged under umask 077 — or wide open — comes out the same",
  ignore: !POSIX,
  async fn() {
    const tmp = await tempDir("artifact-modes-tree-");
    try {
      const outside = join(tmp, "outside");
      const tree = join(tmp, "tree");
      await ownerOnlyUmask(async () => {
        await Deno.writeTextFile(outside, "not in the package");
        await Deno.mkdir(join(tree, "a", "b"), { recursive: true });
        await Deno.writeTextFile(join(tree, "plain"), "");
        await Deno.writeTextFile(join(tree, "a", "b", "deep"), "");
        await Deno.writeTextFile(join(tree, "a", "tool"), "", { mode: 0o700 });
        await Deno.symlink(outside, join(tree, "link"));
        // A relative link to a directory: kept a link, never walked through.
        await Deno.mkdir(join(tmp, "elsewhere"));
        await Deno.writeTextFile(join(tmp, "elsewhere", "private"), "");
        await Deno.symlink("../../elsewhere", join(tree, "a", "into"));
        await Deno.symlink("b/deep", join(tree, "a", "alias"));
      });
      // The other way round: a builder whose files are group/world-writable.
      await Deno.mkdir(join(tree, "open"));
      await Deno.chmod(join(tree, "open"), 0o777);
      await Deno.writeTextFile(join(tree, "open", "loose"), "");
      await Deno.chmod(join(tree, "open", "loose"), 0o666);
      assertEquals((await modes(tree))["./"], "700", "the umask did not take");

      await normalizeArtifactModes(tree);
      assertEquals(await modes(tree), {
        "./": "755",
        "a/": "755",
        "a/b/": "755",
        "a/b/deep": "644",
        "a/tool": "755",
        "open/": "755",
        "open/loose": "644",
        "plain": "644",
      });
      // A link stays the link it was, and its target is not the package's to
      // change: nothing is chmodded, or walked, through one.
      assertEquals(await links(tree), {
        "a/alias": "b/deep",
        "a/into": "../../elsewhere",
        "link": outside,
      });
      assertEquals(await modes(join(tmp, "elsewhere")), {
        "./": "700",
        "private": "600",
      });
      assertEquals((await Deno.stat(outside)).mode! & 0o777, 0o600);
    } finally {
      await dropTempDir(tmp);
    }
  },
});

/** A staged desktop payload, as the Electron build leaves it. */
async function stagedMac(dir: string): Promise<string> {
  const staged = join(dir, "staged");
  const el = join(staged, "electron", "Electron.app", "Contents");
  await Deno.mkdir(join(el, "MacOS"), { recursive: true });
  await Deno.mkdir(join(el, "Resources"), { recursive: true });
  await Deno.mkdir(join(el, "Frameworks"), { recursive: true });
  await Deno.writeTextFile(join(staged, "electron", "LICENSE"), "MIT-ish");
  await Deno.writeTextFile(join(staged, "counter"), "binary", { mode: 0o755 });
  await Deno.writeTextFile(join(el, "Info.plist"), "<plist/>");
  await Deno.writeTextFile(join(el, "MacOS", "Electron"), "el-bin", {
    mode: 0o755,
  });
  return staged;
}

Deno.test({
  name:
    "artifact modes: a macOS bundle assembled under umask 077 can be opened by another account",
  ignore: !POSIX,
  async fn() {
    const dir = await tempDir("artifact-modes-mac-");
    try {
      const app = await ownerOnlyUmask(async () =>
        await assembleMacApp({
          stagedDir: await stagedMac(dir),
          outDir: join(dir, "out"),
          name: "Counter",
          binaryName: "counter",
          identifier: "app.aio.counter",
          version: "1.0.0",
          iconIcns: new Uint8Array([1, 2, 3]),
        })
      );
      const found = await modes(app);
      assertEquals(found["Contents/Info.plist"], "644");
      assertEquals(found["Contents/"], "755");
      assertStated(found, [
        "Contents/MacOS/counter",
        "Contents/MacOS/electron/Electron.app/Contents/MacOS/Electron",
      ]);
      // The window's link into the nested runtime: still a link, and a
      // relative one — the bundle is moved to /Applications.
      const window = (await links(app))[`Contents/MacOS/${MAC_WINDOW_LINK}`];
      assert(window && !window.startsWith("/"), `the link: ${window}`);
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "artifact modes: the disk-image scripts state their umask before they stage anything",
  ignore: !POSIX,
  async fn() {
    const of = { binaryName: "counter", volumeName: "Counter", sign: false };
    const local = localDmgScript({
      ...of,
      appPath: "/out/Counter.app",
      workDir: "/tmp/w",
      outPath: "/out/app.dmg",
    });
    const at = local.indexOf("umask 022");
    assert(at > 0 && at < local.indexOf("mkdir -p"), local);

    // The remote script, run for real with its Mac-only tool stood in for:
    // the payload is unpacked by an account whose umask is 077.
    // aio-ok(umask): the shell that runs the script is put at 077 below, the case a missing `umask 022` fails under; the tree it unpacks is normalized first.
    const dir = await tempDir("artifact-modes-dmg-");
    try {
      const app = join(dir, "src", "Counter.app");
      await Deno.mkdir(join(app, "Contents", "MacOS"), { recursive: true });
      await Deno.writeTextFile(join(app, "Contents", "Info.plist"), "<p/>");
      await Deno.writeTextFile(join(app, "Contents", "MacOS", "counter"), "", {
        mode: 0o755,
      });
      await Deno.symlink("counter", join(app, "Contents", "MacOS", "window"));
      await normalizeArtifactModes(app);
      const work = join(dir, "work");
      const bin = join(dir, "bin");
      await Deno.mkdir(work);
      await Deno.mkdir(bin);
      await Deno.writeTextFile(join(bin, "hdiutil"), "#!/bin/sh\nexit 0\n", {
        mode: 0o755,
      });
      const run = (cmd: string, args: string[], cwd?: string) =>
        new Deno.Command(cmd, {
          args,
          cwd,
          env: { PATH: `${bin}:${Deno.env.get("PATH")}` },
          stdout: "piped",
          stderr: "piped",
        }).output();
      const packed = await run("tar", [
        "-czf",
        join(work, "payload.tgz"),
        "-C",
        join(dir, "src"),
        "Counter.app",
      ]);
      assert(packed.success, new TextDecoder().decode(packed.stderr));
      const script = remoteDmgScript({
        ...of,
        workDir: work,
        appName: "Counter.app",
        outFile: "app.dmg",
      });
      const ran = await run("bash", ["-c", `umask 077\n${script}`]);
      assert(ran.success, new TextDecoder().decode(ran.stderr));
      assertEquals(await modes(join(work, "stage")), {
        "./": "755",
        "Counter.app/": "755",
        "Counter.app/Contents/": "755",
        "Counter.app/Contents/Info.plist": "644",
        "Counter.app/Contents/MacOS/": "755",
        "Counter.app/Contents/MacOS/counter": "755",
      });
      assertEquals(await links(join(work, "stage")), {
        "Applications": "/Applications",
        "Counter.app/Contents/MacOS/window": "counter",
      });
    } finally {
      await dropTempDir(dir);
    }
  },
});

/** A staged AppDir written by an owner-only builder: a launcher, a data file
 *  and a nested directory. */
async function stagedAppDir(dir: string): Promise<string> {
  const appDir = join(dir, "AppDir");
  await ownerOnlyUmask(async () => {
    await Deno.mkdir(join(appDir, "dist"), { recursive: true });
    await Deno.writeTextFile(join(appDir, "dist", "app.js"), "1;\n");
    await Deno.writeTextFile(join(appDir, "app.desktop"), "[Desktop Entry]\n");
    await Deno.writeTextFile(join(appDir, "AppRun"), "#!/bin/sh\n", {
      mode: 0o755,
    });
    await Deno.symlink("dist/app.js", join(appDir, "current"));
  });
  return appDir;
}

const APPDIR_MODES = {
  "./": "755",
  "AppRun": "755",
  "app.desktop": "644",
  "dist/": "755",
  "dist/app.js": "644",
};

Deno.test({
  name:
    "artifact modes: appimagetool is handed a tree with stated modes, whatever the builder's umask",
  ignore: !POSIX,
  async fn() {
    const dir = await tempDir("artifact-modes-appimage-");
    try {
      const appDir = await stagedAppDir(dir);
      assertEquals((await modes(appDir))["dist/"], "700", "umask did not take");
      // The stand-in tool keeps what it was given, modes included — as
      // squashfs does — and refuses to run the way a FUSE-less host cannot.
      const tool = join(dir, "tool");
      await Deno.writeTextFile(
        tool,
        `#!/bin/sh\n[ "$APPIMAGE_EXTRACT_AND_RUN" = 1 ] && [ "$ARCH" = x86_64 ] || exit 9\ncp -Rp "$1" "$2"\n`,
        { mode: 0o755 },
      );
      const image = join(dir, "image");
      assert(await runAppimagetool(tool, appDir, image, "x86_64"));
      assertEquals(await modes(image), APPDIR_MODES);
      assertEquals(await links(image), { current: "dist/app.js" });

      // A tool that fails is reported, not thrown past.
      await Deno.writeTextFile(tool, "#!/bin/sh\nexit 3\n");
      assertEquals(
        await runAppimagetool(tool, appDir, image, "x86_64"),
        false,
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "artifact modes: the Windows zip stores stated modes, and leaves the staging tree with them for the exe payload",
  ignore: !POSIX,
  async fn() {
    const dir = await tempDir("artifact-modes-zip-");
    try {
      const appDir = await stagedAppDir(dir);
      const out = join(dir, "app.zip");
      assert(await zipDir(appDir, out));
      const listed = await new Deno.Command("unzip", {
        args: ["-Z", out],
        stdout: "piped",
      }).output();
      const stored = Object.fromEntries(
        new TextDecoder().decode(listed.stdout).split("\n")
          .map((l) => l.match(/^([-dl][rwx-]{9}) .* (\S+)$/))
          .flatMap((m) => m ? [[m[2]!, m[1]!]] : []),
      );
      assertEquals(stored, {
        "AppRun": "-rwxr-xr-x",
        "app.desktop": "-rw-r--r--",
        // Stored as a link (`zip -y`), not as a copy of what it points at.
        // The link's OWN mode is the one thing not stated: on macOS a symlink
        // carries a mode from the umask it was made under (077 here; on Linux
        // it is always 777). Nothing reads it — unpacking makes the link anew.
        "current": Deno.build.os === "darwin" ? "lrwx------" : "lrwxrwxrwx",
        "dist/": "drwxr-xr-x",
        "dist/app.js": "-rw-r--r--",
      });
      assertEquals(await modes(appDir), APPDIR_MODES);
      assertEquals(await links(appDir), { current: "dist/app.js" });
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name:
    "artifact modes: the web folder and the iOS project are readable by the account that serves or opens them",
  ignore: !POSIX,
  async fn() {
    const root = await tempDir("artifact-modes-dirs-");
    const log = console.log;
    console.log = () => {};
    try {
      await Deno.writeTextFile(
        join(root, "deno.json"),
        JSON.stringify({ title: "Probe", version: "0.3" }),
      );
      await Deno.mkdir(join(root, "dist"));
      await Deno.writeTextFile(
        join(root, "dist", BUNDLE_JS),
        versionStamp("0.3.0") + "x();\n",
      );
      const cfg = {
        root,
        dist: join(root, "dist"),
        version: resolveBuildVersion("0.3", {
          repo: true,
          count: 17,
          commit: "abcdef0",
          hash: null,
        }),
        binaryName: "probe",
        appTitle: "Probe",
        appDir: root,
        doRemote: true,
        bakedServer: null,
      } as unknown as Parameters<typeof buildIos>[0];
      await ownerOnlyUmask(async () => {
        await buildWeb(cfg);
        await buildIos(cfg);
      });
      const web = await modes(join(root, webArtifactName("probe")));
      assertStringIncludes(Object.keys(web).join(" "), "index.html");
      assertStated(web, []);
      const ios = await modes(iosProjectDir(cfg));
      assertEquals(ios["App.xcodeproj/"], "755");
      assertStated(ios, []);
    } finally {
      console.log = log;
      await dropTempDir(root);
    }
  },
});

Deno.test({
  name:
    "artifact modes: an artifact moved across filesystems is what a rename would have left — modes, exec bits, links",
  ignore: !POSIX,
  async fn() {
    const dir = await tempDir("artifact-modes-move-");
    try {
      // A directory artifact as a build leaves it, twice over.
      const artifact = async (name: string) => {
        const appDir = await stagedAppDir(join(dir, name));
        await normalizeArtifactModes(appDir);
        return appDir;
      };
      // `rename` refused the way the kernel refuses a cross-device one.
      const exdev = () =>
        Promise.reject(
          Object.assign(new Error("Invalid cross-device link (os error 18)"), {
            code: "EXDEV",
          }),
        );
      const [renamed, copied] = [join(dir, "renamed"), join(dir, "copied")];
      const [a, b] = [await artifact("a"), await artifact("b")];
      await ownerOnlyUmask(async () => {
        await moveArtifact(a, renamed);
        await moveArtifact(b, copied, exdev);
      });
      assertEquals(await modes(renamed), APPDIR_MODES);
      assertEquals(await modes(copied), APPDIR_MODES);
      assertEquals(await links(copied), await links(renamed));
      assertEquals(await links(copied), { current: "dist/app.js" });
      // Moved, not copied: nothing is left behind.
      for (const from of [a, b]) {
        assertEquals(
          await Deno.lstat(from).then(() => true, () => false),
          false,
        );
      }

      // A single file keeps its mode either way.
      for (const mode of [0o755, 0o644]) {
        const from = join(dir, `file-${mode}`);
        await Deno.writeTextFile(from, "x");
        await Deno.chmod(from, mode);
        await ownerOnlyUmask(() => moveArtifact(from, `${from}.moved`, exdev));
        assertEquals((await Deno.stat(`${from}.moved`)).mode! & 0o777, mode);
      }
      // A source that is not there is the caller's bug, said as such.
      await assertRejects(
        () => moveArtifact(join(dir, "absent"), join(dir, "x")),
        Deno.errors.NotFound,
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});

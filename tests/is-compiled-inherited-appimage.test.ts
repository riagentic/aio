// `$APPIMAGE` and `$APPDIR` are inherited by every child process: a
// `deno run` of a dev checkout started from a terminal that is itself an
// AppImage (an AppImage editor's terminal) saw its host's `$APPIMAGE`, and
// `isCompiled()` ran the checkout as a shipped binary — dev mode off. Only
// an AppImage whose mount holds the running executable counts; when that
// cannot be decided, the old reading stays (a real AppImage never boots dev).
import { assertEquals } from "@std/assert";
import { dirname } from "@std/path";
import { appImageOwner } from "../src/server/paths.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const paths = new URL("../src/server/paths.ts", import.meta.url).href;

/** `isCompiled()` in a fresh `deno run`, under exactly `env`. */
async function compiledUnder(env: Record<string, string>): Promise<boolean> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: [
      "eval",
      `import { isCompiled } from ${JSON.stringify(paths)};` +
      `console.log(isCompiled());`,
    ],
    env,
    stdout: "piped",
    stderr: "inherit",
  }).output();
  return new TextDecoder().decode(out.stdout).trim() === "true";
}

Deno.test("appImageOwner: own only when the executable is under $APPDIR", async () => {
  const dir = await tempDir("aio-appimage-owner-");
  try {
    const exe = Deno.execPath();
    const exeDir = dirname(Deno.realPathSync(exe));
    assertEquals(appImageOwner(exe, undefined, exeDir), "foreign");
    assertEquals(appImageOwner(exe, "/x.AppImage", exeDir), "own");
    assertEquals(appImageOwner(exe, "/x.AppImage", dir), "foreign");
    assertEquals(appImageOwner(exe, "/x.AppImage", undefined), "unknown");
    assertEquals(appImageOwner(undefined, "/x.AppImage", dir), "unknown");
    assertEquals(
      appImageOwner(exe, "/x.AppImage", `${dir}/missing`),
      "unknown",
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("isCompiled: an inherited $APPIMAGE does not make a dev checkout a binary", async () => {
  const dir = await tempDir("aio-appimage-inherited-");
  try {
    const base = { PATH: Deno.env.get("PATH") ?? "", HOME: dir };
    const exeDir = dirname(Deno.realPathSync(Deno.execPath()));
    assertEquals(await compiledUnder(base), false);
    // A host AppImage's variables, inherited: not ours.
    assertEquals(
      await compiledUnder({ ...base, APPIMAGE: "/h.AppImage", APPDIR: dir }),
      false,
    );
    // Our own mount holds the executable: compiled, as before.
    assertEquals(
      await compiledUnder({ ...base, APPIMAGE: "/a.AppImage", APPDIR: exeDir }),
      true,
    );
    // Undecidable ($APPDIR unset): the old reading.
    assertEquals(
      await compiledUnder({ ...base, APPIMAGE: "/a.AppImage" }),
      true,
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("checkUnpackLocation: a host AppImage's inherited unpack dir is not reported as ours", async () => {
  const dir = await tempDir("aio-appimage-unpack-");
  try {
    // The host's mount, under a world-writable parent — the `/tmp` shape.
    const shared = `${dir}/shared`;
    await Deno.mkdir(`${shared}/.mount_host`, { recursive: true });
    await Deno.chmod(shared, 0o777);
    const appDirs = new URL("../src/server/app-dirs.ts", import.meta.url).href;
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "eval",
        `import { checkUnpackLocation } from ${JSON.stringify(appDirs)};` +
        `console.log(JSON.stringify(checkUnpackLocation(` +
        `{ app: ${JSON.stringify(`${dir}/app`)} } as never)));`,
      ],
      env: {
        PATH: Deno.env.get("PATH") ?? "",
        HOME: dir,
        APPIMAGE: "/h.AppImage",
        APPDIR: `${shared}/.mount_host`,
      },
      stdout: "piped",
      stderr: "inherit",
    }).output();
    assertEquals(new TextDecoder().decode(out.stdout).trim(), "null");
  } finally {
    await dropTempDir(dir);
  }
});

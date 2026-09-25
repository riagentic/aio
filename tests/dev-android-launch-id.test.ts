// `dev:android` launches the package the dev APK was built as (R6 hunt).
//
// The fleet places the dev APK as `<bin>-<version>-dev.apk`, and dev:android
// derived the applicationId from that raw file name: `app.aio.hap013dev`, a
// package that is not installed. `am start` failed, its result was ignored,
// and the run still printed "✓ launched". An explicit deno.json
// `android.applicationId` was ignored the same way. The SDK (adb, emulator)
// and `deno` itself are faked on disk, so the real dev-android.ts runs its
// whole flow and what is asserted is the `am start` it issued.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { apkApplicationId } from "../src/build/build-android.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const DEV_ANDROID = join(import.meta.dirname!, "..", "src", "dev-android.ts");
const INSTALL = join(import.meta.dirname!, "..", "src", "android-install.ts");

// adb: one booted emulator (and, for `devices -l`, one phone); `am start`
// succeeds only for $EXPECT_ID.
const ADB = `#!/bin/sh
echo "$*" >> "$ADB_LOG"
[ "$1" = -s ] && shift 2
case "$1" in
  devices)
    if [ "$2" = -l ]; then
      printf 'List of devices attached\\nR5CT12ABCDE device usb:1-3 model:SM_A525F\\n'
    else
      printf 'List of devices attached\\nemulator-5554\\tdevice\\n'
    fi ;;
  install) echo Success ;;
  shell)
    if [ "$2" = getprop ]; then echo 1; exit 0; fi
    if [ "$3" = start ]; then
      if [ "$5" = "$EXPECT_ID/aio.app.MainActivity" ]; then
        echo "Starting: Intent { cmp=$5 }"
      else
        echo "Error type 3"
        echo "Error: Activity class {$5} does not exist."
      fi
    fi ;;
esac
exit 0
`;
const EMULATOR = `#!/bin/sh
[ "$1" = -list-avds ] && echo test_avd
exit 0
`;
// deno: the APK build places what the fleet places; the dev server exits.
const DENO = `#!/bin/sh
for a in "$@"; do
  if [ "$a" = --android ]; then
    mkdir -p dist
    : > dist/hap-0.1.3-dev.apk
    echo '{"version":"0.1.3","targets":[{"target":"android","ok":true,"artifacts":[{"file":"hap-0.1.3-dev.apk"}]}]}' > dist/manifest.json
    exit 0
  fi
done
exit 0
`;

async function devAndroid(
  android: Record<string, unknown> | undefined,
  expectId: string,
  argv: string[] = [DEV_ANDROID],
): Promise<{ code: number; out: string; starts: string[] }> {
  const dir = await tempDir("aio-dev-android-id-");
  try {
    const sdk = join(dir, "sdk");
    const bin = join(dir, "bin");
    const app = join(dir, "app");
    for (const d of [join(sdk, "platform-tools"), join(sdk, "emulator"), bin]) {
      await Deno.mkdir(d, { recursive: true });
    }
    await Deno.mkdir(join(app, "src"), { recursive: true });
    const exe = async (p: string, body: string) => {
      await Deno.writeTextFile(p, body);
      await Deno.chmod(p, 0o755);
    };
    await exe(join(sdk, "platform-tools", "adb"), ADB);
    await exe(join(sdk, "emulator", "emulator"), EMULATOR);
    await exe(join(bin, "deno"), DENO);
    await Deno.writeTextFile(
      join(app, "deno.json"),
      JSON.stringify({ title: "hap", ...(android ? { android } : {}) }),
    );
    await Deno.writeTextFile(join(app, "src", "app.ts"), "export {};\n");
    const log = join(dir, "adb.log");
    const p = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", ...argv],
      cwd: app,
      env: {
        ANDROID_HOME: sdk,
        PATH: `${bin}:${Deno.env.get("PATH") ?? ""}`,
        ADB_LOG: log,
        EXPECT_ID: expectId,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const dec = new TextDecoder();
    const starts = (await Deno.readTextFile(log)).split("\n")
      .filter((l) => l.includes("shell am start"))
      .map((l) => l.replace(/^-s \S+ /, ""));
    return {
      code: p.code,
      out: dec.decode(p.stdout) + dec.decode(p.stderr),
      starts,
    };
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test({
  name:
    "dev:android: launches the dev APK's package, not its versioned file name",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const r = await devAndroid(undefined, "app.aio.hapdev");
    assertEquals(
      r.starts,
      ["shell am start -n app.aio.hapdev/aio.app.MainActivity"],
      r.out,
    );
    assertStringIncludes(r.out, "✓ hap-0.1.3-dev.apk launched");
    assertEquals(r.code, 0, r.out);
  },
});

Deno.test({
  name:
    "dev:android: an explicit android.applicationId is the package launched",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const r = await devAndroid(
      { applicationId: "com.example.hap" },
      "com.example.hap",
    );
    assertEquals(
      r.starts,
      ["shell am start -n com.example.hap/aio.app.MainActivity"],
      r.out,
    );
    assertStringIncludes(r.out, "launched");
  },
});

Deno.test({
  name: "dev:android: a launch that failed is reported, never '✓ launched'",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const r = await devAndroid(undefined, "com.example.other");
    assert(!r.out.includes("✓"), r.out);
    assertStringIncludes(r.out, "could not start");
  },
});

Deno.test({
  name:
    "install:android: launches the project's explicit android.applicationId",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    // It said "⚠ installed, but could not start it" for every app that set
    // one: the launch used the id derived from the file name.
    const r = await devAndroid(
      { applicationId: "com.example.hap" },
      "com.example.hap",
      [INSTALL, "--build"],
    );
    assertEquals(
      r.starts,
      ["shell am start -n com.example.hap/aio.app.MainActivity"],
      r.out,
    );
    assert(!r.out.includes("could not start"), r.out);
  },
});

Deno.test("apkApplicationId: the placed APK's name maps back to its build label", () => {
  assertEquals(apkApplicationId("dist/hap-0.1.3-dev.apk"), "app.aio.hapdev");
  assertEquals(
    apkApplicationId("hap-1.2.345-beta.dirty.0123abcd-client.apk"),
    "app.aio.hapclient",
  );
  assertEquals(apkApplicationId("hap.apk"), "app.aio.hap");
  assertEquals(apkApplicationId("x/hap-0.1.3.apk", "com.ex.hap"), "com.ex.hap");
  assertEquals(apkApplicationId("hap.apk", "nodots"), null);
});

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
import { DELIMITER, join } from "@std/path";
import { apkApplicationId } from "../src/build/build-android.ts";
import { devTarget } from "../src/build/android-devices.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { EXE, writeProgram } from "./fake-program-helper.ts";

const DEV_ANDROID = join(import.meta.dirname!, "..", "src", "dev-android.ts");
const INSTALL = join(import.meta.dirname!, "..", "src", "android-install.ts");

// adb: a phone AND a booted emulator, as real adb lists them; like real adb,
// a device command that names no `-s` fails "more than one device/emulator".
// `am start` succeeds only for $EXPECT_ID.
const ADB = String.raw`
let a = [...Deno.args];
Deno.writeTextFileSync(Deno.env.get("ADB_LOG"), a.join(" ") + "\n", {
  append: true,
});
const named = a[0] === "-s";
if (named) a = a.slice(2);
if (!named && ["shell", "install", "reverse"].includes(a[0])) {
  console.error("adb: error: more than one device/emulator");
  Deno.exit(1);
}
if (a[0] === "devices") {
  console.log(
    "List of devices attached\n" +
      "R5CT12ABCDE device usb:1-3 model:SM_A525F\n" +
      "emulator-5554\tdevice product:sdk model:sdk_gphone64",
  );
} else if (a[0] === "install") console.log("Success");
else if (a[0] === "shell") {
  if (a[1] === "getprop") console.log("1");
  else if (a[2] === "start") {
    if (a[4] === Deno.env.get("EXPECT_ID") + "/aio.app.MainActivity") {
      console.log("Starting: Intent { cmp=" + a[4] + " }");
    } else {
      console.log("Error type 3");
      console.log("Error: Activity class {" + a[4] + "} does not exist.");
    }
  }
}
`;
const EMULATOR = String.raw`
if (Deno.args[0] === "-list-avds") console.log("test_avd");
`;
// deno: the APK build places what the fleet places; the dev server exits.
const DENO = String.raw`
if (Deno.args.includes("--android")) {
  Deno.mkdirSync("dist", { recursive: true });
  Deno.writeTextFileSync("dist/hap-0.1.3-dev.apk", "");
  Deno.writeTextFileSync(
    "dist/manifest.json",
    '{"version":"0.1.3","targets":[{"target":"android","ok":true,"artifacts":[{"file":"hap-0.1.3-dev.apk"}]}]}\n',
  );
}
`;

async function devAndroid(
  android: Record<string, unknown> | undefined,
  expectId: string,
  argv: string[] = [DEV_ANDROID],
): Promise<{ code: number; out: string; starts: string[]; log: string }> {
  const dir = await tempDir("aio-dev-android-id-");
  try {
    const sdk = join(dir, "sdk");
    const bin = join(dir, "bin");
    const app = join(dir, "app");
    for (const d of [join(sdk, "platform-tools"), join(sdk, "emulator"), bin]) {
      await Deno.mkdir(d, { recursive: true });
    }
    await Deno.mkdir(join(app, "src"), { recursive: true });
    // Each stand-in is a program by that name that hands its arguments to
    // the script beside it, run by the real deno. (They were shell scripts,
    // which Windows cannot run.)
    const exe = async (p: string, body: string) => {
      await Deno.writeTextFile(`${p}.ts`, body);
      await writeProgram(
        p + EXE,
        `#!/bin/sh\nexec "${Deno.execPath()}" run -A --no-config "${p}.ts" "$@"\n`,
      );
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
        PATH: `${bin}${DELIMITER}${Deno.env.get("PATH") ?? ""}`,
        ADB_LOG: log,
        EXPECT_ID: expectId,
        ANDROID_SERIAL: "",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const dec = new TextDecoder();
    const out = dec.decode(p.stdout) + dec.decode(p.stderr);
    // No log: the fake adb never ran — said with what the run printed.
    const adbLog = await Deno.readTextFile(log).catch((e) => {
      throw new Error(`no adb.log (${e}) — the run said:\n${out}`);
    });
    const starts = adbLog.split("\n")
      .filter((l) => l.includes("shell am start"))
      .map((l) => l.replace(/^-s \S+ /, ""));
    return { code: p.code, out, starts, log: adbLog };
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test({
  name:
    "dev:android: launches the dev APK's package, not its versioned file name",
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
  name:
    "dev:android: a phone plus an emulator — every device command names the emulator",
  fn: async () => {
    // Unnamed, each `adb shell` failed "more than one device/emulator": the
    // booted emulator never read as booted, a second one was started and the
    // run timed out after 180 s.
    const r = await devAndroid(undefined, "app.aio.hapdev");
    const device = r.log.split("\n").filter((l) =>
      /\b(shell|install|reverse)\b/.test(l)
    );
    assert(device.length >= 4, r.log);
    for (const l of device) assert(l.startsWith("-s emulator-5554 "), l);
    assertStringIncludes(r.out, "emulator-5554");
    assertEquals(r.code, 0, r.out);
  },
});

Deno.test("devTarget: ANDROID_SERIAL, then an emulator, then a lone phone", () => {
  const phone = { serial: "P1", state: "device", emulator: false, model: "" };
  const emu = {
    serial: "emulator-5554",
    state: "device",
    emulator: true,
    model: "",
  };
  assertEquals(devTarget([phone, emu]), { device: emu });
  assertEquals(devTarget([phone, emu], "P1"), { device: phone });
  assertEquals(devTarget([phone]), { device: phone });
  assertEquals(devTarget([{ ...phone, state: "unauthorized" }]), null);
  assertEquals(devTarget([phone], "nope"), null);
  const two = devTarget([emu, { ...emu, serial: "emulator-5556" }]);
  assert(two && "error" in two, JSON.stringify(two));
  assertStringIncludes(two.hint, "ANDROID_SERIAL=emulator-5556");
});

Deno.test({
  name: "dev:android: a launch that failed is reported, never '✓ launched'",
  fn: async () => {
    const r = await devAndroid(undefined, "com.example.other");
    assert(!r.out.includes("✓"), r.out);
    assertStringIncludes(r.out, "could not start");
  },
});

Deno.test({
  name:
    "install:android: launches the project's explicit android.applicationId",
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

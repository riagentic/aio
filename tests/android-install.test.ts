// `install:android` — the half of the Android flow that was missing.
//
// `deno task dev` (in an android app) boots an emulator, builds a DEV apk
// holds that server open. None of that is "my phone is plugged in, put the
// build on it". This pins the decisions, because every one of them is a message
// someone reads while confused: a phone showing the USB-debugging dialog, two
// devices attached, an unsigned artifact that adb would reject with
// INSTALL_PARSE_FAILED_NO_CERTIFICATES.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { pickApk, pickDevice } from "../src/android-install.ts";
import { parseDevices } from "../src/testing/internal.ts";

const LIST = `List of devices attached
R5CT12ABCDE            device usb:1-3 product:a52qxx model:SM_A525F device:a52q
emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64
`;

Deno.test("install:android: parses adb devices, telling hardware from an AVD", () => {
  const d = parseDevices(LIST);
  assertEquals(d.length, 2);
  assertEquals(d[0]!.serial, "R5CT12ABCDE");
  assertEquals(d[0]!.emulator, false);
  assertEquals(d[0]!.model, "SM A525F");
  assertEquals(d[1]!.emulator, true);
});

Deno.test("install:android: a phone wins over an attached emulator", () => {
  const r = pickDevice(parseDevices(LIST), {});
  assert("device" in r, "the physical device must be chosen");
  assertEquals(r.device.serial, "R5CT12ABCDE");
});

Deno.test("install:android: an emulator alone is REFUSED, and says why", () => {
  // Installing "to my phone" onto a virtual device is an hour of confusion.
  const only = parseDevices(
    `List of devices attached\nemulator-5554 device model:sdk_gphone64\n`,
  );
  const r = pickDevice(only, {});
  assert("error" in r);
  assertStringIncludes(r.error, "emulator");
  // The task the hint names must be one a scaffolded app HAS. This asserted
  // `dev:android`, a per-target name alpha52 retired — so the test was
  // notarizing a hint that fails with "Task not found" on every app it was
  // written for. `tests/named-tasks-exist.test.ts` now gates the whole class.
  assertStringIncludes(r.hint ?? "", "deno task dev");
  // …unless asked.
  assert("device" in pickDevice(only, { allowEmulator: true }));
});

Deno.test("install:android: an UNAUTHORIZED phone is the dialog, not a fault", () => {
  // The most common real state: plugged in, screen showing "Allow USB
  // debugging?". `adb devices` says `unauthorized`, and the useless version of
  // this tool says "no device found" while the device is right there.
  const r = pickDevice(
    parseDevices(
      `List of devices attached\nR5CT12ABCDE unauthorized usb:1-3\n`,
    ),
    {},
  );
  assert("error" in r);
  assertStringIncludes(r.error, "unauthorized");
  assertStringIncludes(r.hint ?? "", "Allow USB debugging");
});

Deno.test("install:android: two phones — it refuses and prints the exact flags", () => {
  const two = parseDevices(
    `List of devices attached
R5CT12ABCDE device model:SM_A525F
9A281FFAZ004TZ device model:Pixel_7
`,
  );
  const r = pickDevice(two, {});
  assert("error" in r);
  assertStringIncludes(r.hint ?? "", "--device=R5CT12ABCDE");
  assertStringIncludes(r.hint ?? "", "--device=9A281FFAZ004TZ");
  // And naming one resolves it.
  const one = pickDevice(two, { serial: "9A281FFAZ004TZ" });
  assert("device" in one);
  assertEquals(one.device.model, "Pixel 7");
});

Deno.test("install:android: nothing attached says what to do, not what failed", () => {
  const r = pickDevice([], {});
  assert("error" in r);
  assertStringIncludes(r.hint ?? "", "USB debugging");
});

Deno.test("install:android: the NEWEST apk is the one meant", () => {
  const r = pickApk([
    { name: "old.apk", mtime: 1000 },
    { name: "new.apk", mtime: 9000 },
    { name: "notes.txt", mtime: 9999 },
  ]);
  assert("apk" in r);
  assertEquals(r.apk, "new.apk");
});

Deno.test("install:android: an UNSIGNED apk is refused by name", () => {
  // adb answers this with INSTALL_PARSE_FAILED_NO_CERTIFICATES, which reads
  // like a broken build rather than a build that was never signed.
  const r = pickApk([{ name: "wallet-unsigned.apk", mtime: 5 }]);
  assert("error" in r);
  assertStringIncludes(r.error, "UNSIGNED");
  assertStringIncludes(r.hint ?? "", "build --targets=android");
});

Deno.test("install:android: no apk at all points at the build command", () => {
  const r = pickApk([{ name: "readme.md", mtime: 5 }]);
  assert("error" in r);
  assertStringIncludes(r.hint ?? "", "build --targets=android");
});

Deno.test("install:android: --emulator with nothing attached says how to START one", () => {
  // The generic hint ("plug the phone in") is the wrong answer to "install on
  // the emulator" — and a wrong-but-confident hint costs more than none.
  const r = pickDevice([], { allowEmulator: true });
  assert("error" in r);
  assertStringIncludes(r.hint ?? "", "emulator -avd");
});

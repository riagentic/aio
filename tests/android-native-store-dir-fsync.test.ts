// The APK's native store (`AioNativeStore.set`, MainActivity.kt) writes
// temp → fsync → rename. The fsync made the BYTES durable; the rename is a
// directory entry, and without an fsync on the directory a power cut right
// after it can bring back the previous name (todo.md "Android: no directory
// fsync after renameTo"). Source-level: the emulator lane
// (`deno task test:android`) is what proves an APK runs, and a real APK build
// (`src/build.ts --android`) is what proves this Kotlin compiles.
import { assert, assertStringIncludes } from "@std/assert";
import { ANDROID_TEMPLATE } from "../src/build/android-template.ts";

const KOTLIN = ANDROID_TEMPLATE["app/src/main/java/aio/app/MainActivity.kt"]!;

/** The body of `fun <name>(` up to the next line that closes it at 4 spaces. */
function body(name: string): string {
  const at = KOTLIN.indexOf(`fun ${name}(`);
  assert(at >= 0, `MainActivity.kt has no fun ${name}(`);
  const end = KOTLIN.indexOf("\n    }\n", at);
  assert(end > at, `fun ${name} does not close`);
  return KOTLIN.slice(at, end);
}

Deno.test("android dir fsync: set() fsyncs the directory AFTER the rename", () => {
  const set = body("set");
  const rename = set.indexOf("tmp.renameTo(target)");
  const sync = set.indexOf("syncDir()");
  assert(rename >= 0, "set() no longer renames");
  assert(
    sync > rename,
    "set() does not fsync the directory after renameTo — a power cut can " +
      "undo the rename of a change set() already reported as saved",
  );
  // …and before `true`: the page reads `true` as "on disk".
  assert(set.indexOf("true", sync) > sync, "syncDir() runs after set answers");
});

Deno.test("android dir fsync: a directory fd, fsync'd and closed, refusal said once", () => {
  const fn = body("syncDir");
  // API 21+ (minSdk 24): FileChannel.open on a directory needs API 26.
  assertStringIncludes(fn, "android.system.Os.open(dir.absolutePath");
  assertStringIncludes(fn, "android.system.OsConstants.O_RDONLY");
  assertStringIncludes(fn, "android.system.Os.fsync(fd)");
  assertStringIncludes(fn, "android.system.Os.close(fd)");
  // A filesystem that refuses a directory fsync is not a failed save (the
  // rename happened, the bytes are durable) — but it is never silent.
  assertStringIncludes(fn, "android.util.Log.w(");
  assertStringIncludes(fn, "dirSyncRefusedSaid = true");
  // Balanced braces: the generated source is the one gradle compiles.
  const open = (KOTLIN.match(/{/g) ?? []).length;
  const close = (KOTLIN.match(/}/g) ?? []).length;
  assert(open === close, `MainActivity.kt braces unbalanced: ${open}/${close}`);
});

// "May something private live in this directory?" — and what a Windows mode
// actually is.
//
// The gate in dir-permissions.ts was written against an assumption nobody had
// measured: that `Deno.stat().mode` is `null` on Windows. It is not. Windows
// reports 0o40666 for EVERY directory, so `mode & 0o077` was non-zero
// everywhere, `privateDirRefusal` refused everything, `mintControlKey` minted
// nothing and `readControlKey` read nothing — the control plane and the trojan
// gate were unusable on Windows, and 8 `local-control` cases failed there for
// that single reason. It was found by RUNNING the suite on a real Windows 11
// VM, which is the only place the predicate was ever false.
//
// Two halves, deliberately:
//   • the DECISION is pure and runs on every OS — the platform decides, never
//     a null mode, and each branch is pinned by its own case;
//   • the FACT is the measurement, and can only be taken on Windows. It is
//     gated like every other platform-only case here (`ignore:`), so it is
//     reported as ignored elsewhere and `test:core` is untouched.
//
// Both fail against the pre-fix code.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  modeBitsAreMeaningful,
  privateDirRefusal,
  sharedBits,
} from "../src/server/dir-permissions.ts";
import {
  controlKeyPath,
  mintControlKey,
  readControlKey,
  removeControlKey,
} from "../src/server/app-key.ts";
import { tempDirSync } from "../src/testing/temp-dir.ts";

const WINDOWS = Deno.build.os === "windows";
/** The exact number w11pro reports for a directory — the value that made the
 *  old predicate refuse the world. Written as a literal on purpose: this file
 *  is where that measurement lives. */
const WINDOWS_DIR_MODE = 0o40666;

// ── the decision (pure, every OS) ────────────────────────────────────────────

Deno.test("mode bits are consulted only where they are bits", () => {
  assertEquals(modeBitsAreMeaningful("linux"), true);
  assertEquals(modeBitsAreMeaningful("darwin"), true);
  assertEquals(
    modeBitsAreMeaningful("windows"),
    false,
    "Windows has no permission bits to read — abstaining is the answer, and " +
      "it is named here rather than spelled `null` at each call site",
  );
});

Deno.test("sharedBits abstains on Windows and answers on POSIX", () => {
  // The same number, read on two platforms, means two different things.
  assertEquals(sharedBits(WINDOWS_DIR_MODE, "windows"), null);
  assertEquals(sharedBits(WINDOWS_DIR_MODE, "linux"), 0o66);
  assertEquals(sharedBits(0o40700, "linux"), 0);
  assertEquals(sharedBits(null, "linux"), null);
});

Deno.test("the platform decides, never a null mode", () => {
  const D = "/d";
  // THE REGRESSION. This is the literal value Windows hands back for a
  // directory, and it must not be read as "other users can reach it".
  assertEquals(
    privateDirRefusal(D, WINDOWS_DIR_MODE, null, null, "windows"),
    null,
    "a Windows directory must be usable — this is the bug that made the " +
      "control plane unmintable there",
  );
  // The very same mode on a platform where modes are real IS a refusal.
  assertStringIncludes(
    privateDirRefusal(D, WINDOWS_DIR_MODE, 1000, 1000, "linux")!,
    "mode 666",
  );
  // And "cannot tell" is loud where it should never happen.
  assertStringIncludes(
    privateDirRefusal(D, null, null, null, "linux")!,
    "cannot tell",
  );
  assertEquals(
    privateDirRefusal(D, null, null, null, "windows"),
    null,
    "no mode on Windows is the normal case, not an alarm",
  );
});

// ── the measurement (Windows only) ───────────────────────────────────────────

Deno.test({
  name: "MEASURED on Windows: stat().mode is 0o40666, not null, for every dir",
  ignore: !WINDOWS,
  fn() {
    const tmp = tempDirSync("aio-dirperm-");
    try {
      const mode = Deno.statSync(tmp).mode;
      assert(
        typeof mode === "number",
        `Deno.stat().mode on Windows is ${mode} — this module was written ` +
          `believing it was null. If Deno has since changed it to null, the ` +
          `abstention is still correct but this comment is now the stale one.`,
      );
      assertEquals(
        mode,
        WINDOWS_DIR_MODE,
        "the measured constant this module documents",
      );
      assert(
        (mode & 0o077) !== 0,
        "…and its group/other bits are set, which is precisely why the naive " +
          "check refused every directory on Windows",
      );
      // The field carries no sharing information at all: the user's own
      // ACL-private profile directory reports the SAME number as a scratch
      // directory. That is the whole argument for abstaining.
      const home = Deno.env.get("USERPROFILE");
      assert(home, "USERPROFILE must be set on Windows");
      assertEquals(
        Deno.statSync(home).mode,
        mode,
        "an ACL-private profile dir and a temp dir are indistinguishable by " +
          "mode — so mode is not evidence of privacy on Windows",
      );
    } finally {
      Deno.removeSync(tmp, { recursive: true });
    }
  },
});

Deno.test({
  name: "MEASURED on Windows: the control credential mints and reads back",
  ignore: !WINDOWS,
  fn() {
    // The user-visible half: with the old predicate this returned
    // `{ error: "app data dir … is mode 666 (not owner-only) …" }` and `am`
    // could never reach a running app's control plane on Windows.
    const prev = Deno.env.get("AIO_APPS_DIR");
    const root = tempDirSync("aio-ctlkey-");
    Deno.env.set("AIO_APPS_DIR", root);
    try {
      const appId = "dirperm-win";
      const a = mintControlKey(appId);
      assertEquals(
        a.error,
        undefined,
        `mint must succeed on Windows (got: ${a.error})`,
      );
      assertEquals(a.key!.length, 64, "256 bits, hex");
      assertEquals(a.path, controlKeyPath(appId));
      const back = readControlKey(appId);
      assertEquals(
        back.error,
        undefined,
        `read must succeed on Windows (got: ${back.error})`,
      );
      assertEquals(back.key, a.key, "am reads back what the app minted");
      removeControlKey(appId);
    } finally {
      if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
      else Deno.env.set("AIO_APPS_DIR", prev);
      Deno.removeSync(root, { recursive: true });
    }
  },
});

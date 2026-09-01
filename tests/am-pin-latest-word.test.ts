// `am pin latest` — the newest release, as a WORD.
//
// Every other target of this command is one: `am pin main`, `am pin
// v1.0.0-alpha73`, `am pin /opt/aio-checkout`. "The newest release" was the
// only one that demanded a flag, so the spelling a user reaches for first
// failed with `aio version "latest" not found` — and then listed the very
// releases it was being asked for. Both spellings are one act; this pins them
// to it.

import { assertEquals } from "@std/assert";
import { pinTarget } from "../src/am/am-cmd-pin.ts";
import { LATEST, MAIN } from "../src/am/am-versions.ts";

Deno.test("am pin: `latest` and `--latest` are the same act", () => {
  const word = pinTarget([LATEST]);
  const flag = pinTarget(["--latest"]);
  assertEquals(word, flag);
  assertEquals(word, { wantLatest: true, explicit: undefined });

  // The word is consumed, never handed on as a ref to provision — that is the
  // whole bug: `ensureVersion(root, "latest")` cannot resolve it.
  assertEquals(pinTarget([LATEST]).explicit, undefined);
});

Deno.test("am pin: `latest` composes with the flags that qualify it", () => {
  // `--major` crosses to a newer major (a breaking upgrade, asked for out
  // loud). It qualifies the target; it is not one.
  assertEquals(pinTarget([LATEST, "--major"]), {
    wantLatest: true,
    explicit: undefined,
  });
  assertEquals(pinTarget(["--major", LATEST]), {
    wantLatest: true,
    explicit: undefined,
  });
  assertEquals(pinTarget(["--latest", "--force"]), {
    wantLatest: true,
    explicit: undefined,
  });
});

Deno.test("am pin: every other target is still itself", () => {
  assertEquals(pinTarget([MAIN]), { wantLatest: false, explicit: MAIN });
  assertEquals(pinTarget(["v1.0.0-alpha73"]), {
    wantLatest: false,
    explicit: "v1.0.0-alpha73",
  });
  assertEquals(pinTarget(["/opt/aio-checkout"]), {
    wantLatest: false,
    explicit: "/opt/aio-checkout",
  });
  // No target at all is the REPORT — it must stay side-effect free, so an
  // empty argv can never read as "move me to the newest release".
  assertEquals(pinTarget([]), { wantLatest: false, explicit: undefined });
  assertEquals(pinTarget(["--json"]), {
    wantLatest: false,
    explicit: undefined,
  });
});

Deno.test("am pin: `--aio <path>` is not mistaken for the target", () => {
  // `--aio` carries its value as a SEPARATE argument, and that value is a
  // path to the framework install — never the ref being pinned. A scan that
  // took the first non-flag word would pin the app to it.
  assertEquals(pinTarget(["--aio", "/opt/aio", LATEST]), {
    wantLatest: true,
    explicit: undefined,
  });
  assertEquals(pinTarget(["--aio", "/opt/aio"]), {
    wantLatest: false,
    explicit: undefined,
  });
  assertEquals(pinTarget(["--aio", "/opt/aio", "v1.2.3"]), {
    wantLatest: false,
    explicit: "v1.2.3",
  });
});

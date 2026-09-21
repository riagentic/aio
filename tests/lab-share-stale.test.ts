// `am lab` must not print a fetch command the guest will get a 404 for.
//
// The field report: the lab bind-mounts the app's `dist/` into the container
// and serves it to the guest. Rebuild — and the old build DELETED and
// recreated `dist/`, so the mount, which follows the inode, kept the orphaned
// directory. The guest's `/shared` was empty from then on, for the life of the
// lab, while every host-side reading stayed right: the hand-off named the
// correct file, `shareServing: true`, the share server genuinely running.
//
//     C:\> curl.exe -fLO http://host.lan:8007/wallet-0.1.390-win-x64.exe
//     curl: (22) The requested URL returned error: 404
//
// A 404 from a server you were just told is serving that exact file reads as
// "the lab is broken" or "the build is broken", and both are wrong.
//
// The cause is fixed at the root — aio's build empties `dist/` and never
// replaces it (tests/build-out-dir-inode.test.ts) — so what is left for this
// rule is the hand it cannot see: a `rm -rf dist`, a `git clean`, a build from
// an older aio. The answer there is to SAY it, not to print the command.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  guestShareArgv,
  parseGuestShare,
  staleShareReason,
} from "../src/am/am-cmd-lab.ts";

const FILE = "wallet-0.1.390-win-x64.exe";

Deno.test("lab share: the guest seeing the file is the whole question", () => {
  assertEquals(staleShareReason("windows", FILE, [FILE]), null);
  assertEquals(
    staleShareReason("windows", FILE, [FILE, "manifest.json"]),
    null,
  );
});

Deno.test("lab share: an EMPTY guest share is named, with the fix", () => {
  const why = staleShareReason("windows", FILE, [])!;
  assert(why !== null);
  assertStringIncludes(why, FILE);
  assertStringIncludes(why, "holds nothing");
  assertStringIncludes(why, "404");
  // The remedy has to be one the READER can perform, spelled for this lab.
  assertStringIncludes(why, "am lab windows --stop");
});

Deno.test("lab share: a guest holding the PREVIOUS build is stale too", () => {
  // The subtler half. The share is not empty — it holds yesterday's artifact —
  // so "is it serving?" answers yes and the operator installs old code under a
  // version number that says it is new.
  const why = staleShareReason("macos", FILE, ["wallet-0.1.377-mac-x64.dmg"])!;
  assert(why !== null, "a share without THIS file is stale for this hand-off");
  assertStringIncludes(why, "1 other entry");
  assertStringIncludes(why, "am lab macos --stop");
  assertStringIncludes(
    staleShareReason("linux", FILE, ["a", "b"])!,
    "2 other entries",
  );
});

Deno.test("lab share: a question that could not be ASKED accuses nobody", () => {
  // No docker, a container that is not up, an `ls` that failed. Unknown is
  // never an accusation — the hand-off still prints.
  assertEquals(staleShareReason("windows", FILE, null), null);
});

Deno.test("lab share: the guest is asked directly, in its own /shared", () => {
  // Pinned because the hand-off's correctness depends on asking the GUEST
  // rather than re-reading the host directory it already read.
  assertEquals(guestShareArgv("aio-lab-windows"), [
    "exec",
    "aio-lab-windows",
    "sh",
    "-c",
    "echo __aio_share__; ls -A /shared",
  ]);
});

Deno.test("lab share: the probe has to prove IT ran", () => {
  // The instrument, verified before it is trusted — and the defect the full
  // suite found in the first version of this rule. `docker exec` exiting 0
  // with no output is indistinguishable from "the share is genuinely empty",
  // and one of those two is an accusation. So the probe prints a sentinel
  // first, and an answer that does not open with it answers nothing.
  assertEquals(parseGuestShare(0, `__aio_share__\n${FILE}\n`), [FILE]);
  assertEquals(parseGuestShare(0, "__aio_share__\n"), [], "truly empty");

  assertEquals(parseGuestShare(0, ""), null, "a silent success proves nothing");
  assertEquals(parseGuestShare(0, `${FILE}\n`), null, "no sentinel, no answer");
  assertEquals(parseGuestShare(1, `__aio_share__\n`), null, "a failed exec");
  assertEquals(parseGuestShare(127, ""), null, "no docker at all");

  // A name survives VERBATIM — `ls -A` prints one entry per line, and a
  // leading or trailing space is part of the name. Trimming it would compare
  // a mangled name against the real one and cry wolf about a good share.
  assertEquals(
    parseGuestShare(0, "__aio_share__\nmy app-1.2.3-x64.AppImage\n"),
    ["my app-1.2.3-x64.AppImage"],
  );
  assertEquals(parseGuestShare(0, "__aio_share__\n trailing \n"), [
    " trailing ",
  ]);
  // …and a CRLF answer is the same answer.
  assertEquals(parseGuestShare(0, "__aio_share__\r\nx.exe\r\n"), ["x.exe"]);
});

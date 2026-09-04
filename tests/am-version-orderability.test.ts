// `am` and the in-app updater must agree on WHICH TAGS EXIST.
//
// The ORDER was unified once (`am-versions.compareVersions` delegates to
// `updates-core`), with a note that the two had disagreed on 22 of 24 tried
// pairs. The FILTER in front of it was left behind: `parseVersion` had its own,
// stricter regex, so `am` silently dropped tags the updater orders happily.
//
// Measured before the fix, on tags a real publisher produces:
//
//   v1.2.3+build1      am DROPPED   updater ok   ← the commit-stamped release
//   v1.2.3-rc.1+abc    am DROPPED   updater ok
//   v2.0.0-RC1         am DROPPED   updater ok   ← uppercase prerelease
//   v1.0.0-alpha77.1   am DROPPED   updater ok
//
// A dropped tag is not an error anywhere: `am pin latest` just answers with an
// older release, and `am upgrade` says the app is current while the app's own
// updater offers the newer one. Two deciders for one question, and the one that
// said less said nothing about it.
import { assert, assertEquals } from "@std/assert";
import { newestVersion, parseVersion } from "../src/am/am-versions.ts";
import { isComparableVersion } from "../src/server/updates-core.ts";

const TAGS = [
  "v1.0.0",
  "v1.0.0-alpha77",
  "v1.0.0-beta1",
  "v1.0.0-rc.1",
  "v1.0.0-rc1",
  "v1.2.3+build1",
  "v1.2.3-rc.1+abc",
  "v2.0.0-RC1",
  "v1.0.0-alpha.77",
  "v10.20.30",
  "v1.0.0-next",
  "v1.0.0-alpha77.1",
  "v1",
  "v1.2",
  // …and things neither may order.
  "main-abc1234",
  "latest",
  "",
  "v.1.2",
];

Deno.test("am orders exactly the tags the updater can order", () => {
  const disagree = TAGS.filter((t) =>
    (parseVersion(t) !== null) !== isComparableVersion(t.trim())
  );
  assertEquals(
    disagree,
    [],
    "am and the in-app updater must not disagree about which tags exist",
  );
});

Deno.test("am pin latest sees a commit-stamped release", () => {
  const tags = ["v1.2.2", "v1.2.3+build1"];
  assertEquals(
    newestVersion(tags)?.raw,
    "v1.2.3+build1",
    "the newest release must not be invisible because it names its build",
  );
});

Deno.test("parsed fields survive the wider grammar", () => {
  const v = parseVersion("v2.0.0-RC1")!;
  assert(v !== null);
  assertEquals([v.major, v.minor, v.patch], [2, 0, 0]);
  assertEquals(v.pre, "rc", "case-folded for display");
  assertEquals(v.preNum, 1);
  assertEquals(v.raw, "v2.0.0-RC1", "raw is the tag as given — it maps back");
  // One and two-component tags are orderable; the missing parts are zero.
  assertEquals(parseVersion("v1")!.minor, 0);
  assertEquals(parseVersion("v1.2")!.patch, 0);
});

// A release STAGE in the derived version: `1.2.345-beta`.
//
// The field report (field report §17): an app wanted its version to say how finished
// it was. aio refused every prerelease in deno.json's `version`, so the app
// appended the stage on DISPLAY only — and then `appVersion()`, the artifact
// names and the update check all said `0.1.377` while the status bar said
// `0.1.377-alpha`. Two strings for one build is not a cosmetic split: the
// update check orders by version, so it would have offered an ALPHA over the
// beta that replaced it, and a user comparing the status bar with the download
// page sees a mismatch nobody can explain.
//
// The whole fix is that the stage rides the SAME string, as a SemVer
// prerelease, so the comparator that already ranks `alpha < beta < rc <
// release` (src/server/updates-core.ts) does the ordering with no second rule.
// These tests pin the three surfaces that had to learn the shape together —
// the resolver, the publish gate, and the artifact-name splitter — because a
// version the resolver can emit and a name parser cannot read is the bug this
// feature would otherwise have introduced.

import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  artifactVersion,
  buildVersionNotes,
  parseDeclaredVersion,
  resolveBuildVersion,
  stripVersionToken,
  type TreeFacts,
  unpublishableReason,
  versionedArtifactName,
} from "../src/server/app-version.ts";
import {
  compareVersions,
  decide,
  followsPrereleases,
  isPrerelease,
} from "../src/server/updates-core.ts";
import { versionStage } from "../src/server/app-version.ts";

const clean: TreeFacts = {
  repo: true,
  count: 345,
  commit: "9f3ac2b1",
  hash: null,
};
const dirty: TreeFacts = { ...clean, hash: "4e1d0c77" };
const nogit: TreeFacts = {
  repo: false,
  count: 0,
  commit: null,
  hash: "aabbccdd",
};

Deno.test("stage: a declared stage rides the derived version", () => {
  for (const stage of ["alpha", "beta", "rc"] as const) {
    const v = resolveBuildVersion(`1.2-${stage}`, clean);
    assertEquals(v.version, `1.2.345-${stage}`);
    assertEquals(v.base, "1.2");
    assertEquals(
      v.build,
      345,
      "the build number is still derived from commits",
    );
    assertEquals(v.stage, stage);
    assertEquals(v.source, "derived");
  }
});

Deno.test("stage: absent is ABSENT, not undefined", () => {
  // `{stage: undefined}` and `{}` are the same fact spelled two ways, and the
  // stamp is JSON — one round-trips to `{}`, the other does not exist. Asserted
  // on the key itself because `assertEquals` treats them as equal.
  const v = resolveBuildVersion("1.2", clean);
  assertEquals(v.version, "1.2.345");
  assert(!("stage" in v), "a version with no stage carries no `stage` key");
  assert(!("stage" in parseDeclaredVersion("1.2")));
});

Deno.test("stage: a dirty staged build is ONE prerelease tail", () => {
  const v = resolveBuildVersion("1.2-beta", dirty);
  assertEquals(v.version, "1.2.345-beta.dirty.4e1d0c77");
  assertEquals(v.dirty, true);
  // Two `-` groups would not be SemVer at all, so the comparator below would
  // refuse the string rather than order it.
  assertEquals(
    resolveBuildVersion("1.2-rc", nogit).version,
    "1.2.0-rc.nogit.aabbccdd",
  );
});

Deno.test("stage: a PINNED version may carry one, and is normalised", () => {
  const v = resolveBuildVersion("1.0.0-rc", dirty);
  assertEquals(v.version, "1.0.0-rc");
  assertEquals(v.source, "pinned");
  assertEquals(v.stage, "rc");
  // The note tells you the spelling that keeps the stage AND derives builds.
  assertEquals(buildVersionNotes(v).length, 1);
  assert(buildVersionNotes(v)[0]!.includes('write "1.0-rc"'));
  // Leading zeros and padding normalise; one version has one spelling.
  assertEquals(parseDeclaredVersion(" 01.0.0-rc ").kind, "pinned");
  assertEquals(
    resolveBuildVersion(" 01.0.0-rc ", clean).version,
    "1.0.0-rc",
  );
});

Deno.test("stage: only the three words, only lower-case", () => {
  for (
    const bad of [
      "1.2-alpha1", // the build count already numbers the build
      "1.2-BETA",
      "1.2-dev",
      "1.2-rc.1",
      "1.2-",
      "1.2.3-alpha.1",
      "1.2-alpha-beta",
    ]
  ) {
    assertThrows(
      () => parseDeclaredVersion(bad),
      Error,
      JSON.stringify(bad),
      `${bad} must still be refused, naming itself`,
    );
  }
  // …and the refusal TEACHES the new form rather than only rejecting.
  const why = assertThrows(() => parseDeclaredVersion("1.2-dev")) as Error;
  assert(why.message.includes('"-beta"'), why.message);
});

Deno.test("stage: the update check orders alpha < beta < rc < release", () => {
  // The report's actual complaint. No new comparator: these are the strings
  // the resolver now emits, handed to the one that already existed.
  const order = [
    resolveBuildVersion("1.2-alpha", clean).version,
    resolveBuildVersion("1.2-beta", clean).version,
    resolveBuildVersion("1.2-rc", clean).version,
    resolveBuildVersion("1.2", clean).version,
    resolveBuildVersion("1.2", { ...clean, count: 346 }).version,
  ];
  for (let i = 1; i < order.length; i++) {
    assertEquals(
      compareVersions(order[i - 1]!, order[i]!),
      -1,
      `${order[i - 1]} must rank below ${order[i]}`,
    );
  }
  assert(isPrerelease("1.2.345-beta"));
  assert(!isPrerelease("1.2.345"));
});

Deno.test("stage: a dirty staged build ranks below every OTHER clean build", () => {
  // The one ordering consequence worth pinning, because it is the opposite of
  // what the format suggests and it was found by this test rather than by
  // reasoning: SemVer ranks a longer prerelease HIGHER when the leading
  // identifiers match, so `1.2.345-beta.dirty.x` sits ABOVE `1.2.345-beta` —
  // the single build it literally is, plus uncommitted edits. No spelling
  // avoids it: any tail added to `-beta` outranks `-beta`.
  const d = resolveBuildVersion("1.2-beta", dirty).version;
  assertEquals(compareVersions(d, "1.2.345-beta"), 1, "the exception");
  for (
    const clean_ of [
      "1.2.345-rc",
      "1.2.345",
      "1.2.346-alpha",
      "1.3.0",
    ]
  ) {
    assertEquals(
      compareVersions(d, clean_),
      -1,
      `${d} must rank below ${clean_}`,
    );
  }
  // And what actually keeps it out of a channel is the publish refusal below,
  // not its position in a sort.
  assert(unpublishableReason(d) !== null);
});

Deno.test("stage: the dirty-build publish refusal still fires", () => {
  // The gate that would have silently stopped firing: with a stage the mark
  // is `.dirty.`, not `-dirty.`, so a `-`-anchored pattern would have let
  // every staged app publish an unreproducible build.
  const v = resolveBuildVersion("1.2-beta", dirty).version;
  const why = unpublishableReason(v, "--allow-dirty");
  assert(why !== null, `a dirty staged build (${v}) must still be refused`);
  assert(why!.includes("dirty-tree"));
  assert(
    unpublishableReason(resolveBuildVersion("1.2-rc", nogit).version) !== null,
  );
  // A clean staged build is perfectly publishable — a beta IS a release.
  assertEquals(unpublishableReason("1.2.345-beta"), null);
  assertEquals(unpublishableReason("1.2.345-rc"), null);
});

Deno.test("stage: artifact names split back into name + version", () => {
  // Where a half-taught regex does its damage: the token must consume the
  // stage, or the installer reads the app's name as `notes-beta`.
  for (
    const version of [
      "1.2.345",
      "1.2.345-beta",
      "1.2.345-alpha.dirty.4e1d0c77",
      "1.2.345-dirty.4e1d0c77",
      "1.2.0-rc.nogit.aabbccdd",
    ]
  ) {
    for (const rest of [".exe", ".AppImage", "-client.apk", ""]) {
      const named = versionedArtifactName(`notes${rest}`, "notes", version);
      assertEquals(named, `notes-${version}${rest}`);
      assertEquals(artifactVersion(named, "notes"), {
        unversioned: `notes${rest}`,
        version,
      }, `${named} must split back into the name the builder wrote`);
      assertEquals(stripVersionToken(named), `notes${rest}`);
      // Idempotent: a name that already carries a version keeps exactly it.
      assertEquals(versionedArtifactName(named, "notes", "9.9.9"), named);
    }
  }
});

// ── and the half the feature would have broken ──────────────────────────────
//
// Found by a verifier attacking this very change, RUN rather than read: a
// release channel does not offer prereleases (`updates: { prerelease: true }`
// is the opt-in), and every build of a `"1.2-beta"` app is a prerelease. So
// declaring a stage — which the upgrade guide tells apps to do — switched the
// app's own updates off and reported it as `kind: "current"`. The quiet arm,
// on the default channel, for exactly the apps that asked for the feature.

Deno.test("stage: a version string says its stage back", () => {
  assertEquals(versionStage("1.2.345-beta"), "beta");
  assertEquals(versionStage("1.2.345-alpha.dirty.4e1d0c77"), "alpha");
  assertEquals(versionStage("1.2.345-rc"), "rc");
  assertEquals(versionStage("1.2.345"), null);
  // A dirty mark is about whether a build is REPRODUCIBLE, never about how
  // finished it is — so it does not put an install on a prerelease line.
  assertEquals(versionStage("1.2.345-dirty.4e1d0c77"), null);
  assertEquals(versionStage("1.2.0-nogit.aabbccdd"), null);
  assertEquals(versionStage("1.2.345-betamax"), null);
});

Deno.test("stage: an install on a staged line follows its own line", () => {
  const stable = { prerelease: false, declared: {} };
  assert(
    followsPrereleases(stable, "1.2.345-beta"),
    "a beta build must keep seeing the next beta",
  );
  assert(!followsPrereleases(stable, "1.2.345"), "a release does not");
  assert(
    !followsPrereleases(stable, "1.2.345-dirty.4e1d0c77"),
    "an unreproducible build is not a release LINE — and nobody published it",
  );
  // The app's own word always wins, both ways.
  assert(
    !followsPrereleases(
      { prerelease: false, declared: { prerelease: false } },
      "1.2.345-beta",
    ),
  );
  assert(followsPrereleases(
    { prerelease: true, declared: { prerelease: true } },
    "1.2.345",
  ));
  // A dev channel already followed them; a staged build does not un-follow.
  assert(followsPrereleases({ prerelease: true, declared: {} }, "1.2.345"));
});

Deno.test("stage: the next beta really is OFFERED to a beta", () => {
  // The end-to-end shape, through `decide` itself rather than through the
  // predicate — the bug lived in the gap between the two.
  const manifest = {
    app: "notes",
    version: "1.2.346-beta",
    target: "binary",
    artifact: "notes-1.2.346-beta",
    size: 10,
    sha256: "a".repeat(64),
  } as unknown as Parameters<typeof decide>[0]["manifest"];
  const base = {
    current: "1.2.345-beta",
    manifest,
    local: { schema: 1, cells: {} },
    canInstall: ["binary" as const],
  };
  assertEquals(
    decide({ ...base, prerelease: false }).kind,
    "current",
    "the old behaviour, kept: prerelease: false is an answer",
  );
  assertEquals(
    decide({
      ...base,
      prerelease: followsPrereleases(
        { prerelease: false, declared: {} },
        base.current,
      ),
    }).kind,
    "offer",
    "a beta must be offered the next beta on the default channel",
  );
});

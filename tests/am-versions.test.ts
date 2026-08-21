// Release ordering — which tag is newer, and who gets to decide.
import { assert, assertEquals } from "@std/assert";
import { compareVersions, parseVersion } from "../src/am/am-versions.ts";
import { compareVersions as compareRaw } from "../src/server/updates-core.ts";

// ── ONE ordering for "which release is newer" ────────────────────────────
//
// There were two comparators — this file's and `updates-core`'s — and they
// disagreed on 22 of 24 tried pairs, all of them the shape this project ships.
// SemVer compares `alpha9` and `alpha62` as ASCII strings, so the in-app
// updater read `1.0.0-alpha9` as NEWER than the published `1.0.0-alpha62` and
// answered "you are up to date" forever, while `am pin --latest` ordered the
// same tags the other way. The parsing still lives here (it decides which tags
// are orderable at all); the ORDER now comes from one function.
Deno.test("versions: am and the updater order every pair the same way", () => {
  const tags = [
    "1.0.0",
    "1.0.1",
    "1.1.0",
    "2.0.0",
    "0.9.9",
    "1.0.0-alpha9",
    "1.0.0-alpha10",
    "1.0.0-alpha62",
    "1.0.0-alpha63",
    "1.0.0-alpha.9",
    "1.0.0-alpha.62",
    "1.0.0-beta1",
    "1.0.0-rc1",
    "1.0.0-rc2",
    "v1.0.0-alpha62",
  ];
  const sign = (n: number) => n < 0 ? -1 : n > 0 ? 1 : 0;
  for (const a of tags) {
    for (const b of tags) {
      const pa = parseVersion(a), pb = parseVersion(b);
      if (!pa || !pb) continue;
      assertEquals(
        sign(compareVersions(pa, pb)),
        sign(compareRaw(a, b)),
        `${a} vs ${b}: am and updates-core must agree`,
      );
    }
  }
});

Deno.test("versions: the project's own tag style orders by NUMBER", () => {
  const older = (a: string, b: string) => {
    const pa = parseVersion(a)!, pb = parseVersion(b)!;
    assert(compareVersions(pa, pb) < 0, `${a} must be older than ${b}`);
    assert(compareRaw(a, b) < 0, `${a} must be older than ${b} (updates)`);
  };
  older("1.0.0-alpha9", "1.0.0-alpha10");
  older("1.0.0-alpha9", "1.0.0-alpha62");
  older("1.0.0-alpha62", "1.0.0-alpha63");
  older("1.0.0-alpha63", "1.0.0-beta1");
  older("1.0.0-beta1", "1.0.0-rc1");
  older("1.0.0-rc1", "1.0.0");
  older("1.0.0", "1.0.1");
});

Deno.test("versions: ordering is a total order (antisymmetric, transitive)", () => {
  const tags = [
    "1.0.0",
    "1.0.0-alpha9",
    "1.0.0-alpha62",
    "1.0.0-beta1",
    "1.0.0-rc1",
    "1.0.1",
    "2.0.0",
  ];
  const sign = (n: number) => n < 0 ? -1 : n > 0 ? 1 : 0;
  for (const a of tags) {
    for (const b of tags) {
      assertEquals(
        sign(compareRaw(a, b)),
        -sign(compareRaw(b, a)),
        `${a}/${b}`,
      );
      for (const c of tags) {
        if (compareRaw(a, b) < 0 && compareRaw(b, c) < 0) {
          assert(compareRaw(a, c) < 0, `${a} < ${b} < ${c}`);
        }
      }
    }
  }
});

Deno.test("versions: a dot is only a boundary — rc1 and rc.1 are the same release", () => {
  for (
    const [a, b] of [
      ["1.0.0-rc1", "1.0.0-rc.1"],
      ["1.0.0-alpha62", "1.0.0-alpha.62"],
      ["1.0.0-beta10", "1.0.0-beta.10"],
    ]
  ) {
    assertEquals(compareRaw(a!, b!), 0, `${a} ≡ ${b}`);
    assertEquals(
      compareVersions(parseVersion(a!)!, parseVersion(b!)!),
      0,
      `am: ${a} ≡ ${b}`,
    );
  }
  // SemVer's own worked example still holds, in order.
  const spec = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
  ];
  for (let i = 1; i < spec.length; i++) {
    assert(
      compareRaw(spec[i - 1]!, spec[i]!) < 0,
      `${spec[i - 1]} < ${spec[i]} (SemVer §11.4)`,
    );
  }
});

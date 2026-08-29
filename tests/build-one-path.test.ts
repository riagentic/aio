// ONE BUILD PATH — the unit half.
//
// `src/build.ts` used to be a second entry point. `deno task build` ran the
// fleet, which places `dist/<name>-<version>-<arch>`; a direct
// `build.ts --compile --electron` (what the pre-alpha52 `compile:*` matrix
// ran) wrote `<name>-<arch>` into the project ROOT, unversioned and absent
// from `dist/manifest.json` — so `am build` and `deno task compile:electron`
// produced differently-named artifacts from one source tree, and only one of
// the two was covered by the artifact E2E.
//
// The mapping that closes it is derived from the fleet's own TARGETS table, so
// there is no second list to drift. These pin the derivation; the artifact E2E
// (`deno task test:build`) pins the result on real binaries.
import { assert, assertEquals } from "@std/assert";
import { targetForFlags, TARGETS } from "../src/build-all.ts";

Deno.test("one path: every fleet target is reachable from its own flags", () => {
  // The property that matters: whatever flags the fleet passes a child, that
  // same set names the target again. A target this cannot round-trip is one a
  // direct invocation would refuse to build.
  for (const [name, spec] of Object.entries(TARGETS)) {
    assertEquals(
      targetForFlags(spec.flags),
      name,
      `${name}'s own flags (${spec.flags.join(" ")}) do not name it back`,
    );
  }
  assert(Object.keys(TARGETS).length >= 8, "the target table shrank");
});

Deno.test("one path: matching is exact, never a subset", () => {
  // `--compile --cli` is `cli`; `--compile --cli --remote` is `cli-client`.
  // A subset match would call the second one the first and ship a client
  // binary under the app's own name.
  assertEquals(targetForFlags(["--compile", "--cli"]), "cli");
  assertEquals(
    targetForFlags(["--compile", "--cli", "--remote"]),
    "cli-client",
  );
  assertEquals(targetForFlags(["--android"]), "android");
  assertEquals(targetForFlags(["--android", "--remote"]), "android-client");
  assertEquals(targetForFlags(["--compile"]), "browser");
  assertEquals(targetForFlags(["--compile", "--electron"]), "electron");
});

Deno.test("one path: a flag set that names no target is not a build", () => {
  // Refused by the caller, loudly — never quietly built down the old path.
  // `--compile --service --headless` (no --remote) was exactly that gap: a
  // combination the fleet cannot name, which used to produce an unversioned
  // artifact in the project root that no manifest, no `am publish` and no
  // updater could see.
  assertEquals(targetForFlags(["--compile", "--service", "--headless"]), null);
  assertEquals(targetForFlags(["--electron"]), null); // needs --compile
  assertEquals(targetForFlags([]), null);
  // Non-build flags never participate in the match.
  assertEquals(
    targetForFlags(["--compile", "--name=x", "--platform=linux"]),
    "browser",
  );
});

// Every build now goes through the fleet (alpha73's "one path, one name, one
// dist/"). That made `src/build.ts` a ROUTER: it parses argv, refuses what is
// wrong with it, resolves the target — and then forwards a HAND-WRITTEN subset
// of the flags to the fleet. Two deciders for one vocabulary, with nothing
// checking they agree.
//
// They did not agree. Three flags were accepted, validated and dropped:
//   --platform=windows  → a host ELF binary under the host's name, silently.
//                         `build-cli.ts` documents that exact failure as FIXED.
//   --out=release/one   → artifacts in dist/ instead, taking the R-4 remedy
//                         (“I orchestrate my own builds”) with them.
//   --android-dev-url=  → `dev:android` built a production APK.
//
// A silently ignored flag is the worst kind of wrong: the build succeeds, the
// summary is green, and the artifact is not the one that was asked for. So the
// vocabulary is read from the BUILDER'S OWN SOURCE and every flag must be
// accounted for — forwarded, or exempt with a reason written here.
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  FLEET_BOOLEANS,
  FLEET_FLAG_FOR,
  forwardedToFleet,
} from "../src/build-all.ts";
import { FLEET_VALUE_FLAGS } from "../src/build/build-flags.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

/** Value flags the single-target builder parses out of `Deno.args`, read from
 *  source with comments stripped — a flag named only in prose is documentation,
 *  not behaviour. */
function flagsParsedBy(files: string[]): Set<string> {
  const found = new Set<string>();
  for (const f of files) {
    const src = Deno.readTextFileSync(ROOT + f)
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .map((l) => l.replace(/\/\/.*$/, ""))
      .join("\n");
    for (const m of src.matchAll(/["'`](--[a-z][a-z-]*)=["'`]/g)) {
      found.add(m[1]!);
    }
  }
  return found;
}

/** Flags the builder parses that the fleet must NOT be given, each with the
 *  reason it is not a build input. Anything else has to be forwarded. */
const NOT_A_BUILD_INPUT: Record<string, string> = {
  // `flagHint()` exists precisely to say so when someone passes it to a build.
  "--client":
    "a RUNTIME flag of the compiled app (aio.run reads it), not a build input",
};

Deno.test("build flags: every flag the builder parses is forwarded or exempt", () => {
  const parsed = flagsParsedBy([
    "src/build/build-config.ts",
    "src/build/build-flags.ts",
    "src/build/build-compile.ts",
    "src/build/build-cli.ts",
  ]);
  const unaccounted = [...parsed].filter((f) =>
    !(f in FLEET_FLAG_FOR) && !(f in NOT_A_BUILD_INPUT)
  ).sort();
  assertEquals(
    unaccounted,
    [],
    `these flags are parsed by the single-target builder but neither forwarded ` +
      `to the fleet nor listed as fleet-owned, so they are accepted and then ` +
      `silently ignored:\n  ${unaccounted.join("\n  ")}\n` +
      `Add each to FLEET_FLAG_FOR in src/build-all.ts, or to NOT_A_BUILD_INPUT ` +
      `here with the reason it is not a build input.`,
  );
});

Deno.test("build flags: every forwarded flag is one the fleet actually reads", () => {
  // Forwarding a flag the fleet ignores is the same silence with an extra step.
  const fleetSrc = Deno.readTextFileSync(ROOT + "src/build-all.ts");
  const read = new Set(
    [...fleetSrc.matchAll(/\bflag\("([a-z][a-z-]*)"\)/g)].map((m) => m[1]!),
  );
  const deaf = Object.entries(FLEET_FLAG_FOR)
    .filter(([, fleet]) => !read.has(fleet.slice(2)))
    .map(([mine, fleet]) =>
      `${mine}= → ${fleet}= (build-all.ts never reads it)`
    );
  assertEquals(deaf, [], deaf.join("\n"));
});

Deno.test("build flags: --platform becomes the fleet's --platforms", () => {
  // The one rename in the map, and the one that silently cross-built wrong.
  assertEquals(
    forwardedToFleet(["--compile", "--cli", "--platform=windows"]),
    ["--platforms=windows"],
  );
});

Deno.test("build flags: --out and --android-dev-url survive the hop", () => {
  assertEquals(
    forwardedToFleet(["--compile", "--cli", "--out=release/one"]),
    ["--out=release/one"],
  );
  assertEquals(
    forwardedToFleet(["--android", "--android-dev-url=http://10.0.2.2:8000"]),
    ["--android-dev-url=http://10.0.2.2:8000"],
  );
});

Deno.test("build flags: booleans pass, target flags and unknowns do not", () => {
  assertEquals(
    forwardedToFleet(["--compile", "--electron", "--release", "--force"]),
    ["--release", "--force"],
  );
  // Target flags name the target; the fleet is told that as --targets=<name>.
  assertEquals(forwardedToFleet(["--compile", "--cli"]), []);
  // A runtime flag of the compiled app must not become a build input.
  assertEquals(forwardedToFleet(["--compile", "--client=browser"]), []);
  // A bare `--out` with no value is not a value flag.
  assertEquals(forwardedToFleet(["--out"]), []);
});

Deno.test("build flags: a value containing '=' is kept whole", () => {
  assertEquals(
    forwardedToFleet(["--android-dev-url=http://h/?a=b"]),
    ["--android-dev-url=http://h/?a=b"],
  );
});

Deno.test("build flags: the fleet's booleans are the builder's booleans", () => {
  const src = Deno.readTextFileSync(ROOT + "src/build-all.ts");
  assert(FLEET_BOOLEANS.length > 0, "no booleans are forwarded at all");
  for (const b of FLEET_BOOLEANS) {
    assert(
      src.includes(`"${b}"`),
      `${b} is forwarded to the fleet, which never mentions it`,
    );
  }
});

Deno.test("build flags: the fleet hands its children the flags it was given", () => {
  // Forwarding to the fleet is only half the hop. `--android-dev-url` reaches
  // the fleet and is READ by it, but the builder that acts on it is the child
  // the fleet spawns — so it has to appear in the child's argv too, or
  // `dev:android` still gets a production APK with nothing said.
  const src = Deno.readTextFileSync(ROOT + "src/build-all.ts");
  const spawn = src.slice(
    src.indexOf("const args = ["),
    src.indexOf("if (release) args.push"),
  );
  assert(spawn.length > 0, "the fleet's per-target argv moved — update this");
  for (
    const flag of [
      "--platform",
      "--name",
      "--entry",
      "--ui",
      "--android-dev-url",
    ]
  ) {
    assert(
      spawn.includes(`${flag}=`),
      `the fleet never hands its children ${flag}=`,
    );
  }
});

Deno.test("build flags: a flag the fleet reads is a flag the fleet ACCEPTS", () => {
  // The refusal gate answers from FLEET_VALUE_FLAGS. A flag build-all reads
  // but the table omits is refused before it can be read — which is how
  // `--android-dev-url` could be forwarded, read, and still never arrive.
  const src = Deno.readTextFileSync(ROOT + "src/build-all.ts");
  const read = new Set(
    [...src.matchAll(/\bflag\("([a-z][a-z-]*)"\)/g)].map((m) => `--${m[1]!}`),
  );
  const missing = [...read].filter((f) =>
    !(FLEET_VALUE_FLAGS as readonly string[]).includes(f)
  );
  assertEquals(
    missing,
    [],
    `build-all reads, but its vocabulary refuses: ${missing}`,
  );
});

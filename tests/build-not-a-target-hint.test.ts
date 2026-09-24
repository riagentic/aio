// A direct `build.ts` flag set that names no target is refused WITH the
// nearest target it meant (remote-desktop field report §6).
//
// Since alpha73 a direct build resolves its target by exact flag-set equality
// against the fleet's TARGETS, so the old spelling `--compile --android`
// (android is `["--android"]`) matched nothing and the refusal listed target
// NAMES only. It now says `Did you mean --android (target "android")?`.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { TARGETS } from "../src/build-all.ts";
import {
  nearestTargets,
  notATargetMessage,
} from "../src/build/build-target-hint.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("build hint: --compile --android is nearest android, not browser", () => {
  assertEquals(nearestTargets(["--compile", "--android"], TARGETS), [
    "android",
  ]);
  assertStringIncludes(
    notATargetMessage(["--compile", "--android"], TARGETS),
    `Did you mean --android (target "android")?`,
  );
});

Deno.test("build hint: every target's own flags plus a stray --compile lead back to it", () => {
  assert(Object.keys(TARGETS).length > 3, "the fleet declares its targets");
  for (const [name, t] of Object.entries(TARGETS)) {
    const given = t.flags.includes("--compile")
      ? t.flags.filter((f) => f !== "--compile")
      : ["--compile", ...t.flags];
    if (given.length === 0) continue; // `browser` is `--compile` alone
    const near = nearestTargets(given, TARGETS);
    assert(near.includes(name), `${given.join(" ")} → ${near} (want ${name})`);
  }
});

Deno.test("build hint: no build flags, no hint", () => {
  assertEquals(nearestTargets(["--release"], TARGETS), []);
  assert(!notATargetMessage([], TARGETS).includes("Did you mean"));
});

Deno.test("build hint: a direct build.ts --compile --android is refused naming --android", async () => {
  const dir = await tempDir("aio-build-hint-");
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ name: "hint-app" }),
    );
    const o = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        new URL("../deno.json", import.meta.url).pathname,
        new URL("../src/build.ts", import.meta.url).pathname,
        "--compile",
        "--android",
      ],
      cwd: dir,
      env: {
        GIT_CEILING_DIRECTORIES: dir,
        NO_COLOR: "1",
        AIO_APPS_DIR: join(dir, "apps"),
      },
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    const err = new TextDecoder().decode(o.stderr);
    assertEquals(o.code, 1, err);
    assertStringIncludes(err, "--compile --android is not a build target.");
    assertStringIncludes(err, `Did you mean --android (target "android")?`);
  } finally {
    await dropTempDir(dir);
  }
});

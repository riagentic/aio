// Cross-platform build targets: one machine, one command, every OS.
//
// The risky part of a cross build is that it SUCCEEDS while producing the
// wrong thing — a host binary wearing a foreign platform's name is only
// discovered by the user who downloads it. So the platform table, the naming
// rule, the refusals, and the `deno compile` argv are all pure and asserted
// here; `tests/build-e2e.test.ts` then proves a real cross-compiled artifact
// is genuinely the other platform's format.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  artifactName,
  CROSS_COMPILABLE,
  crossCompileBlocker,
  hostPlatform,
  isHostPlatform,
  PLATFORMS,
  resolvePlatforms,
} from "../src/build/platforms.ts";
import { compileArgs, v8FlagsArg } from "../src/build/build-compile.ts";
import {
  HEAP_FLOOR_MB,
  physicalMemoryBytes,
} from "../src/server/heap-policy.ts";
import {
  androidApplicationId,
  isValidApplicationId,
} from "../src/build/build-android.ts";

Deno.test("platforms: every entry is a real deno compile triple shape", () => {
  for (const [name, spec] of Object.entries(PLATFORMS)) {
    assert(
      /^(x86_64|aarch64)-(unknown-linux-gnu|pc-windows-msvc|apple-darwin)$/
        .test(spec.triple),
      `${name}: ${spec.triple} is not a target triple deno accepts`,
    );
    assertEquals(
      spec.exeExt,
      spec.os === "windows" ? ".exe" : "",
      `${name}: only Windows artifacts carry an extension`,
    );
    assert(spec.triple.startsWith(spec.arch), `${name}: arch/triple disagree`);
  }
});

Deno.test("platforms: host detection covers each OS/arch aio ships to", () => {
  assertEquals(hostPlatform({ os: "linux", arch: "x86_64" }), "linux");
  assertEquals(hostPlatform({ os: "linux", arch: "aarch64" }), "linux-arm64");
  assertEquals(hostPlatform({ os: "windows", arch: "x86_64" }), "windows");
  assertEquals(hostPlatform({ os: "darwin", arch: "x86_64" }), "macos");
  assertEquals(hostPlatform({ os: "darwin", arch: "aarch64" }), "macos-arm64");
  // …and the real host is always one of the table's keys.
  assert(hostPlatform() in PLATFORMS);
  assert(isHostPlatform(hostPlatform()));
});

Deno.test("platforms: resolve accepts host, dedupes, and NAMES the unknown", () => {
  const ok = resolvePlatforms(["host", "windows", "windows", " macos "]);
  assert(ok.ok);
  assertEquals(
    ok.platforms[0],
    hostPlatform(),
    "host resolves to this machine",
  );
  assertEquals(
    ok.platforms.filter((p) => p === "windows").length,
    1,
    "duplicates collapse",
  );
  assert(ok.platforms.includes("macos"), "surrounding space is tolerated");

  const bad = resolvePlatforms(["linux", "win32", "osx"]);
  assert(!bad.ok);
  assert(
    bad.error.includes("win32") && bad.error.includes("osx"),
    `every unknown name must be listed, not silently dropped: ${bad.error}`,
  );
  assert(bad.error.includes("macos-arm64"), "and the valid ones shown");
});

Deno.test("platforms: the host keeps the bare name, cross builds are labelled", () => {
  const host = hostPlatform();
  assertEquals(
    artifactName("myapp", host),
    `myapp${PLATFORMS[host]!.exeExt}`,
    "an existing host-only build must not suddenly rename its output",
  );
  // A foreign platform is always distinguishable, and Windows gets .exe.
  const foreign = host === "windows" ? "linux" : "windows";
  const name = artifactName("myapp", foreign);
  assert(name.includes(foreign), `${name} must carry its platform`);
  assertEquals(name.endsWith(".exe"), foreign === "windows");

  // No two platforms can ever produce the same file name.
  const names = Object.keys(PLATFORMS).map((p) => artifactName("myapp", p));
  assertEquals(new Set(names).size, names.length, "artifact names are unique");
});

Deno.test("platforms: only deno-compile targets may cross-compile", () => {
  for (const t of CROSS_COMPILABLE) {
    assertEquals(crossCompileBlocker(t), null, `${t} compiles with deno`);
  }
  // Electron cross-builds to Windows and macOS from any host: its runtime is a
  // published zip fetched for the TARGET, and the package there is a directory
  // + launcher + zip. No OS-specific tooling is involved, so refusing it was a
  // rule that cost users a CI matrix for nothing.
  for (const p of ["windows", "macos", "macos-arm64"]) {
    assertEquals(
      crossCompileBlocker("electron", p, "linux"),
      null,
      `electron → ${p} cross-builds from a Linux host`,
    );
  }
  // …and `electron-client` does NOT, however much it looks like its sibling.
  //
  // This assertion used to loop both targets together and expect null for
  // both, which made the drift a CHECKED claim: `buildClient` has only an
  // AppImage packager (no zip path at all) and refuses anything but Linux, so
  // the fleet dispatched `electron-client [windows]`, the single-target build
  // died, and the whole run went red. `--all-platforms` on any repo declaring
  // this target could not succeed. A test asserting a capability the packager
  // never had is worse than no test: it is the drift, notarized.
  for (const p of ["windows", "macos", "macos-arm64"]) {
    const why = crossCompileBlocker("electron-client", p, "linux");
    assert(why, `electron-client → ${p} must be REFUSED, not attempted`);
    assert(
      why!.includes("AppImage"),
      `electron-client → ${p}: the refusal must name the reason: ${why}`,
    );
  }
  // The ONE real constraint on the Linux package, and it is a TOOL constraint:
  // an AppImage is assembled by `appimagetool`, a native binary for the arch it
  // assembles. Refused WITH the reason, never quietly emitted as a host
  // artifact under a foreign name. True of both Electron targets.
  for (const t of ["electron", "electron-client"]) {
    for (
      const [platform, host] of [
        ["linux", "macos"],
        ["linux", "windows"],
        ["linux-arm64", "linux"],
      ]
    ) {
      const why = crossCompileBlocker(t, platform, host);
      assert(why, `${t} → ${platform} from ${host} must be refused`);
      assert(
        why!.length > 30,
        `${t} → ${platform}: the refusal must explain itself: ${why}`,
      );
    }
  }
  // Android drives Gradle and emits ONE platform-independent APK — asking for
  // a per-platform Android build is a category error, answered as one.
  for (const t of ["android", "android-client"]) {
    const why = crossCompileBlocker(t);
    assert(why, `${t} must be refused for a foreign platform`);
    assert(why!.length > 30, `${t}: the refusal must explain itself: ${why}`);
  }
  assert(crossCompileBlocker("nonsense"), "an unknown target is refused too");
});

Deno.test("compileArgs: --target is passed only for a cross build", () => {
  const base = {
    hasDist: false,
    workerInclude: [],
    assets: [],
    excludes: [],
    out: "app",
    entry: "src/app.ts",
  };
  // Host build: no --target at all, so deno needs no extra runtime download
  // and behaves exactly as it did before this feature existed.
  assertEquals(compileArgs(base).includes("--target"), false);

  const cross = compileArgs({ ...base, target: "x86_64-pc-windows-msvc" });
  const i = cross.indexOf("--target");
  assert(i > 0, "cross build passes --target");
  assertEquals(cross[i + 1], "x86_64-pc-windows-msvc");
  // It must precede the entry, and not disturb the rest of the argv.
  assert(i < cross.indexOf("src/app.ts"));
  assertEquals(cross[cross.length - 1], "src/app.ts");
  assertEquals(cross[0], "compile");
});

Deno.test("compileArgs: every platform's triple survives into the argv", () => {
  for (const [name, spec] of Object.entries(PLATFORMS)) {
    const args = compileArgs({
      hasDist: true,
      workerInclude: ["--include", "w.js"],
      assets: ["--include", "m.wasm"],
      excludes: ["node_modules/x"],
      out: artifactName("app", name),
      entry: "src/app.ts",
      target: spec.triple,
    });
    assertEquals(args[args.indexOf("--target") + 1], spec.triple);
    // The embedded runtime dependencies are not lost by the new flag.
    assert(args.includes("dist/"), `${name}: dist/ still embedded`);
    assert(args.includes("w.js"), `${name}: sqlite worker still embedded`);
    assert(args.includes("m.wasm"), `${name}: data assets still embedded`);
    assertEquals(args[args.indexOf("-o") + 1], artifactName("app", name));
  }
});

// A cross artifact that the collector does not RECOGNISE is worse than a build
// failure: `deno compile` succeeds, the binary is real, and it is left behind
// in the project root while the build reports ✓. That is exactly what happened
// to `myapp-macos-arm64` — extension-less names only matched the bare binary.
Deno.test("build-all: cross-compiled artifact names are recognised", async () => {
  const { isArtifactName } = await import("../src/build-all.ts");

  for (const platform of Object.keys(PLATFORMS)) {
    for (const base of ["myapp", "myapp-client"]) {
      const name = artifactName(base, platform);
      assert(
        isArtifactName(name, "myapp"),
        `${name} must be collected into dist/, not stranded in the project root`,
      );
    }
  }

  // Still true for everything that was already recognised…
  assert(isArtifactName("myapp", "myapp"));
  assert(isArtifactName("myapp-client", "myapp"));
  assert(isArtifactName("myapp.service", "myapp"));
  assert(isArtifactName("myapp-client.apk", "myapp"));
  assert(isArtifactName("aio-client-x86_64.AppImage", "myapp"));
  // …and nothing unrelated is swept up.
  assertEquals(isArtifactName("deno.json", "myapp"), false);
  assertEquals(isArtifactName("src", "myapp"), false);
  assertEquals(isArtifactName("README.md", "myapp"), false);
  assertEquals(isArtifactName("otherapp", "myapp"), false);
});

// ── applicationId: an app's PERMANENT public identity ────────────────────────
// `app.aio.<name>` is aio's namespace, not the author's, and an applicationId
// can never change once an app is published — so a derived-only id meant no aio
// app could ship to Play under its own name.

Deno.test("androidApplicationId: derived by default, explicit when given", () => {
  assertEquals(androidApplicationId("wallet"), "app.aio.wallet");
  assertEquals(androidApplicationId("my-wallet"), "app.aio.mywallet");
  assertEquals(
    androidApplicationId("wallet", "com.example.wallet"),
    "com.example.wallet",
    "an explicit id is used verbatim — it is the Play listing's primary key",
  );
});

Deno.test("androidApplicationId: an invalid explicit id is refused, not sanitized", () => {
  // Silently "fixing" a package name would change the app's identity behind the
  // author's back — the one thing that can never be undone after publishing.
  for (const bad of ["wallet", "1com.example", "com.example.", "com..x", ""]) {
    assertEquals(
      androidApplicationId("wallet", bad),
      null,
      `${JSON.stringify(bad)} is not a valid Android package name`,
    );
  }
});

Deno.test("isValidApplicationId: Android's own shape rule", () => {
  assert(isValidApplicationId("com.example.wallet"));
  assert(isValidApplicationId("io.a.b_c1"));
  assert(!isValidApplicationId("single"), "needs ≥2 segments");
  assert(
    !isValidApplicationId("com.9lives"),
    "each segment starts with a letter",
  );
  assert(!isValidApplicationId("com.example."), "no trailing dot");
});

// ── compile.v8Flags ──────────────────────────────────────────────────────────
// V8 options are fixed at isolate creation, so a compiled binary cannot pick
// them up from the environment the way `deno run` does — it ignores
// DENO_V8_FLAGS outright. Baking them at compile time is the ONLY way, which
// makes this wiring the difference between an app's dev and prod memory
// ceilings matching or silently diverging.

async function withDenoJson<T>(
  cfg: unknown,
  fn: (root: string) => Promise<T>,
): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "aio-v8flags-" });
  try {
    if (cfg !== undefined) {
      await Deno.writeTextFile(
        join(root, "deno.json"),
        JSON.stringify(cfg, null, 2),
      );
    }
    return await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("v8FlagsArg: an undeclared app never inherits the BUILD machine's RAM", async () => {
  // This has been both ways, and the second one shipped a defect.
  //
  // It started as "no flag at all", which is V8's ~4 GB default whatever the
  // box — the default that killed an app on a 32 GB machine with 28 GB free.
  // The fix baked 25% of the BUILD machine, and that number then travelled: a
  // binary cross-compiled on a 187 GB host booted in an 8 GB Windows VM and
  // reported `heap 46.7 GB max of 8.0 GB RAM`. Six times the RAM the machine
  // has, so V8 never collects before the OS kills the process, and nothing in
  // the app can lower it — a compiled binary ignores DENO_V8_FLAGS (measured)
  // and V8 fixes the ceiling at isolate creation.
  //
  // The build machine's size is not evidence about the user's machine. An app
  // that declares nothing therefore ships with V8's own default (the policy
  // FLOOR, identical everywhere); more than that is one `memory.maxHeap` line,
  // and `reportHeapCeiling` names that line at boot on a machine with room.
  for (const cfg of [{ name: "x" }, { build: {} }, undefined]) {
    assertEquals(await withDenoJson(cfg, v8FlagsArg), []);
  }
});

Deno.test("v8FlagsArg: a declared ABSOLUTE ceiling travels with the binary", async () => {
  // A size means the same thing on every machine, so it is the one form that
  // can honestly be baked. The floor still applies.
  assertEquals(
    await withDenoJson({ memory: { maxHeap: "12GB" } }, v8FlagsArg),
    ["--v8-flags=--max-old-space-size=12288"],
  );
  assertEquals(
    await withDenoJson({ memory: { maxHeap: 512 } }, v8FlagsArg),
    [`--v8-flags=--max-old-space-size=${HEAP_FLOOR_MB}`],
    "below the floor is raised to it, never lowered",
  );
  assertEquals(
    await withDenoJson({ memory: { maxHeap: "default" } }, v8FlagsArg),
    [],
    "an explicit opt-out bakes nothing",
  );
});

Deno.test("v8FlagsArg: a PERCENT ceiling is the build host's, and says so out loud", async () => {
  // "25%" cannot be re-resolved in a compiled binary, so it silently becomes
  // "25% of whoever built it". It is still honoured — the author asked — but
  // the build log states whose percentage it is, because that is the only
  // moment anyone can act on it.
  const said: string[] = [];
  const warn = console.warn;
  console.warn = (m: unknown) => said.push(String(m));
  let got: string[];
  try {
    got = await withDenoJson({ memory: { maxHeap: "50%" } }, v8FlagsArg);
  } finally {
    console.warn = warn;
  }
  const total = physicalMemoryBytes();
  if (total === null) {
    assertEquals(got, [], "an unmeasurable build host bakes nothing");
  } else {
    const want = Math.max(
      HEAP_FLOOR_MB,
      Math.floor((total * 0.5) / (1024 * 1024)),
    );
    assertEquals(got, [`--v8-flags=--max-old-space-size=${want}`]);
  }
  assertEquals(said.length, 1, `the build must say it: ${said.join(" | ")}`);
  assertEquals(said[0]!.includes("BUILD MACHINE"), true, said[0]);
});

Deno.test("v8FlagsArg: an explicit max-old-space-size is never second-guessed", async () => {
  // An author who states the number owns it — adding ours too would produce two
  // values for one flag, and V8 takes the last silently.
  assertEquals(
    await withDenoJson(
      { build: { v8Flags: ["--max-old-space-size=2048"] } },
      v8FlagsArg,
    ),
    ["--v8-flags=--max-old-space-size=2048"],
  );
});

Deno.test("v8FlagsArg: other declared flags keep the ceiling alongside them", async () => {
  const got = await withDenoJson(
    { build: { v8Flags: ["--expose-gc"] }, memory: { maxHeap: "12GB" } },
    v8FlagsArg,
  );
  assertEquals(got.length, 1);
  assertEquals(got[0]!.includes("--expose-gc"), true);
  assertEquals(
    got[0]!.includes("--max-old-space-size=12288"),
    true,
    "a declared flag must not cost the app its heap ceiling",
  );
});

Deno.test("v8FlagsArg: declared flags are comma-joined into one --v8-flags", async () => {
  assertEquals(
    await withDenoJson(
      { build: { v8Flags: ["--max-old-space-size=16384"] } },
      v8FlagsArg,
    ),
    ["--v8-flags=--max-old-space-size=16384"],
  );
  assertEquals(
    await withDenoJson(
      { build: { v8Flags: ["--max-old-space-size=16384", "--expose-gc"] } },
      v8FlagsArg,
    ),
    ["--v8-flags=--max-old-space-size=16384,--expose-gc"],
  );
});

Deno.test("v8FlagsArg: a malformed entry is refused, never silently dropped", async () => {
  // Each of these would otherwise produce a binary that keeps the default the
  // app was trying to change — the failure only shows up under load.
  const bad: [unknown, RegExp][] = [
    [{ build: { v8Flags: "--max-old-space-size=16384" } }, /must be an ARRAY/],
    [{ build: { v8Flags: [""] } }, /non-empty V8 flag/],
    [{ build: { v8Flags: [42] } }, /non-empty V8 flag/],
    [{ build: { v8Flags: ["max-old-space-size=16384"] } }, /must start/],
    [{ build: { v8Flags: ["--a,--b"] } }, /comma/],
  ];
  for (const [cfg, re] of bad) {
    await assertRejects(
      () => withDenoJson(cfg, v8FlagsArg),
      Error,
      undefined,
      `expected ${JSON.stringify(cfg)} to be refused`,
    );
    const err = await withDenoJson(cfg, async (r) => {
      try {
        await v8FlagsArg(r);
        return null;
      } catch (e) {
        return e as Error;
      }
    });
    assert(err && re.test(err.message), `wrong message: ${err?.message}`);
  }
});

Deno.test("v8FlagsArg: the `compile` spelling is redirected, not left to deno", async () => {
  // Under Deno's own `compile` block an unknown key aborts the build with
  // "Failed to parse compile configuration", which names neither the offending
  // key nor the fix. Catch it first and say both.
  const err = await withDenoJson(
    { compile: { v8Flags: ["--max-old-space-size=16384"] } },
    async (r) => {
      try {
        await v8FlagsArg(r);
        return null;
      } catch (e) {
        return e as Error;
      }
    },
  );
  assert(err, "compile.v8Flags must be refused");
  assert(/belongs under/.test(err.message), `unhelpful: ${err.message}`);
  assert(/"build"/.test(err.message), "must name the correct block");
});

Deno.test("compileArgs: --v8-flags precedes the entry and leaves the argv otherwise intact", () => {
  const base = {
    hasDist: false,
    workerInclude: [],
    assets: [],
    excludes: [],
    out: "app",
    entry: "src/app.ts",
  };
  assertEquals(
    compileArgs(base).some((a) => a.startsWith("--v8-flags")),
    false,
  );

  const withFlags = compileArgs({
    ...base,
    v8Flags: ["--v8-flags=--max-old-space-size=16384"],
  });
  const i = withFlags.indexOf("--v8-flags=--max-old-space-size=16384");
  assert(i > 0, "flag is present");
  assert(i < withFlags.indexOf("src/app.ts"), "must precede the entry");
  assertEquals(withFlags[0], "compile");
  assertEquals(withFlags[withFlags.length - 1], "src/app.ts");
});

// `am doctor` — "the running aio differs from dep/aio on disk".
//
// The process loaded the framework at boot; the disk can move on without it.
// The decider is two timestamps, and the finding must name the fix.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  checkRunningAio,
  doctorLabel,
  driftVerdict,
  newestMtimeUnder,
} from "../src/am/am-cmd-doctor.ts";
import { profileHome } from "../src/server/app-dirs.ts";
import {
  electronBehindHint,
  electronBehindHintFor,
} from "../src/am/am-electron.ts";
import { DEFAULT_ELECTRON_VERSION } from "../src/build/electron-runtime.ts";

Deno.test("doctor: driftVerdict — newer on disk than the process is stale, else not", () => {
  const f = { path: "x/src/a.ts", mtime: 2000 };
  assertEquals(driftVerdict(f, 1000).stale, true, "written after boot");
  assertEquals(driftVerdict(f, 2000).stale, false, "written at boot — same");
  assertEquals(driftVerdict(f, 3000).stale, false, "written before boot");
  assertEquals(driftVerdict(null, 1000).stale, false, "no tree, no claim");
});

Deno.test("doctor: newestMtimeUnder walks .ts/.tsx, skips node_modules and .git", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-doctor-" });
  try {
    await Deno.mkdir(join(dir, "deep", "node_modules"), { recursive: true });
    await Deno.mkdir(join(dir, ".git"), { recursive: true });
    await Deno.writeTextFile(join(dir, "a.ts"), "");
    await Deno.writeTextFile(join(dir, "deep", "b.tsx"), "");
    await Deno.writeTextFile(join(dir, "deep", "node_modules", "v.ts"), "");
    await Deno.writeTextFile(join(dir, ".git", "g.ts"), "");
    await Deno.writeTextFile(join(dir, "readme.md"), "");
    const t = new Date(Date.now() + 60_000);
    await Deno.utime(join(dir, "deep", "b.tsx"), t, t);
    // The vendored/history files are the NEWEST — and must not win.
    const later = new Date(Date.now() + 120_000);
    await Deno.utime(join(dir, "deep", "node_modules", "v.ts"), later, later);
    await Deno.utime(join(dir, ".git", "g.ts"), later, later);
    const best = await newestMtimeUnder(dir);
    assert(best);
    assertEquals(best.path, join(dir, "deep", "b.tsx"));
    assertEquals(await newestMtimeUnder(join(dir, "missing")), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("doctor: a process older than dep/aio/src is a finding that names `am restart`", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-doctor-" });
  try {
    const fw = join(dir, "checkout");
    await Deno.mkdir(join(fw, "src"), { recursive: true });
    await Deno.writeTextFile(join(fw, "mod.ts"), "");
    await Deno.writeTextFile(join(fw, "src", "x.ts"), "");
    await Deno.mkdir(join(dir, "app", "dep"), { recursive: true });
    await Deno.symlink(fw, join(dir, "app", "dep", "aio"));
    const now = Date.now();
    const inst = { appId: "demo", pid: 4242, startedAt: now };
    // Framework written BEFORE the process started: fine.
    const old = new Date(now - 60_000);
    for (const f of [join(fw, "mod.ts"), join(fw, "src", "x.ts")]) {
      await Deno.utime(f, old, old);
    }
    const fine = await checkRunningAio(join(dir, "app"), inst);
    assertEquals(fine.ok, true, fine.detail);
    // Then a file lands after boot.
    const fresh = new Date(now + 60_000);
    await Deno.utime(join(fw, "src", "x.ts"), fresh, fresh);
    const stale = await checkRunningAio(join(dir, "app"), inst);
    assertEquals(stale.ok, false);
    assertStringIncludes(stale.detail, "differs from dep/aio on disk");
    // A path the user reads: in the host's own separators.
    assertStringIncludes(stale.detail, join("src", "x.ts"));
    assertEquals(stale.fix, "am restart --app=demo");
    // No dep/aio at all: not a finding, and says why.
    const none = await checkRunningAio(join(dir, "nowhere"), inst);
    assertEquals(none.ok, true);
    assertStringIncludes(none.detail, "no dep/aio");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// A stale PROFILE instance was told to `am restart --app=demo` — which
// restarts the DEFAULT instance and leaves the stale one serving. The fix
// names the instance the finding is about (the same address `am instances`
// prints in `stopWith`), and the pretty list labels it apart from its sibling.
Deno.test("doctor: a stale profile instance's fix restarts THAT instance", async () => {
  const dir = await tempDir("aio-doctor-");
  try {
    const fw = join(dir, "checkout");
    await Deno.mkdir(join(fw, "src"), { recursive: true });
    await Deno.writeTextFile(join(fw, "mod.ts"), "");
    await Deno.writeTextFile(join(fw, "src", "x.ts"), "");
    await Deno.mkdir(join(dir, "app", "dep"), { recursive: true });
    await Deno.symlink(fw, join(dir, "app", "dep", "aio"));
    const now = Date.now();
    const fresh = new Date(now + 60_000);
    await Deno.utime(join(fw, "src", "x.ts"), fresh, fresh);
    const inst = {
      appId: "demo",
      pid: 4242,
      startedAt: now,
      home: profileHome("demo", "dev"),
      profile: "dev",
    };
    const stale = await checkRunningAio(join(dir, "app"), inst);
    assertEquals(stale.ok, false);
    assert(
      stale.fix?.endsWith("am restart --app=demo --profile=dev"),
      stale.fix,
    );
    assertEquals(doctorLabel(stale), "demo@dev");
    assertEquals(doctorLabel({ appId: "demo" }), "demo");
  } finally {
    await dropTempDir(dir);
  }
});

// A field report: after an aio upgrade the app's Electron copies stayed on the
// previous patch, the build said so and `am doctor` did not.
Deno.test("doctor: an Electron OLDER than the tested one is a hint that names `am fix`", () => {
  const tested = "44.5.1";
  const both = electronBehindHint({
    tested,
    declared: "npm:electron@44.4.1",
    installed: "44.4.1",
  });
  assertEquals(
    both,
    'Electron: deno.json says "npm:electron@44.4.1" and node_modules has ' +
      "44.4.1 — older than 44.5.1, the version this aio is tested with and a " +
      "build ships. `am fix` aligns them",
  );
  // Each copy on its own; a numeric compare, not a string one (44.10 > 44.5).
  assertStringIncludes(
    electronBehindHint({ tested, declared: null, installed: "43.9.9" })!,
    "Electron: node_modules has 43.9.9 — older than",
  );
  assertStringIncludes(
    electronBehindHint({
      tested,
      declared: "npm:electron@44.5.0",
      installed: "44.5.1",
    })!,
    'Electron: deno.json says "npm:electron@44.5.0" — older than',
  );
  // Nothing to say: aligned, no Electron at all, NEWER, or a spec that names
  // no single version (the build's drift note covers "different").
  for (
    const d of [
      { declared: `npm:electron@${tested}`, installed: tested },
      { declared: null, installed: null },
      { declared: "npm:electron@44.10.0", installed: "45.0.0" },
      { declared: "npm:electron@^43.4.1", installed: null },
      { declared: "npm:electron", installed: "not-a-version" },
    ]
  ) assertEquals(electronBehindHint({ tested, ...d }), null, d.declared ?? "");
});

Deno.test("doctor: the Electron hint reads the app's deno.json against ITS pinned aio — and `am doctor` prints it, exit 0", async () => {
  const dir = await tempDir("aio-doctor-electron-");
  try {
    const cfg = (v: string) =>
      Deno.writeTextFile(
        join(dir, "deno.json"),
        JSON.stringify({ imports: { electron: `npm:electron@${v}` } }),
      );
    await cfg(DEFAULT_ELECTRON_VERSION);
    assertEquals(await electronBehindHintFor(dir), null, "aligned");
    await cfg("1.0.0");
    assertStringIncludes(
      (await electronBehindHintFor(dir))!,
      `older than ${DEFAULT_ELECTRON_VERSION}, the version`,
    );
    // The command itself, with nothing running: said, and not a failure.
    const am = new URL("../src/am.ts", import.meta.url).href;
    const run = async (...flags: string[]) => {
      const o = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", am, "doctor", ...flags],
        cwd: dir,
        env: { AIO_APPS_DIR: join(dir, "home"), NO_COLOR: "1" },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      return { code: o.code, out: new TextDecoder().decode(o.stdout) };
    };
    const json = await run("--json");
    assertEquals(json.code, 0, json.out);
    const hints = JSON.parse(json.out).hints as string[];
    assertEquals(hints.length, 1, json.out);
    assertStringIncludes(hints[0]!, '"npm:electron@1.0.0"');
    assertStringIncludes(hints[0]!, "`am fix` aligns them");
    const text = await run();
    assertEquals(text.code, 0, text.out);
    assertStringIncludes(text.out.replace(/\s+/g, " "), "`am fix` aligns them");
    // The app's PINNED aio decides what "tested" is, not this am's.
    const fw = join(dir, "dep", "aio", "src", "electron");
    await Deno.mkdir(fw, { recursive: true });
    await Deno.writeTextFile(
      join(fw, "electron-runtime-fetch.ts"),
      'export const DEFAULT_ELECTRON_VERSION = "0.9.0";\n',
    );
    assertEquals(await electronBehindHintFor(dir), null, "1.0.0 ≥ its 0.9.0");
  } finally {
    await dropTempDir(dir);
  }
});

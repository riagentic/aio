// `am doctor` — "the running aio differs from dep/aio on disk".
//
// The process loaded the framework at boot; the disk can move on without it.
// The decider is two timestamps, and the finding must name the fix.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  checkRunningAio,
  driftVerdict,
  newestMtimeUnder,
} from "../src/am/am-cmd-doctor.ts";

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
    assertStringIncludes(stale.detail, "src/x.ts");
    assertEquals(stale.fix, "am restart --app=demo");
    // No dep/aio at all: not a finding, and says why.
    const none = await checkRunningAio(join(dir, "nowhere"), inst);
    assertEquals(none.ok, true);
    assertStringIncludes(none.detail, "no dep/aio");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

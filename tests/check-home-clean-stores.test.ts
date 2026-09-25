// check:home-clean guards the REAL framework version store, not just `~/.<appId>`.
//
// MEASURED 2026-09-24: a test wrote `~/.local/lib/aio-versions/v1.0.11-beta`
// (its `.git` pointing into tests/am-version-pin.test.ts's sandbox) and no gate
// noticed — `check:home-clean` only looked for `~/.<appId>` shapes. Two real
// apps ran that fake release for hours.
//
// Every control here runs the gate with HOME pointed at a TEMP home. Never the
// real one: a positive control that plants an entry in the developer's store
// is the incident itself.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import {
  isTestGitdir,
  realStoreDirs,
  storeChanges,
} from "../scripts/check-home-clean.ts";

const GATE = new URL("../scripts/check-home-clean.ts", import.meta.url)
  .pathname;

/** Run the gate as `deno task check:home-clean` does, in a CLEARED env whose
 *  only home is `home` — so neither the real HOME nor this process's sandboxed
 *  store variables can leak in. */
async function gate(
  home: string,
  args: string[] = [],
): Promise<{ code: number; out: string }> {
  const env: Record<string, string> = { HOME: home };
  for (const k of ["PATH", "DENO_DIR", "XDG_CACHE_HOME"]) {
    const v = Deno.env.get(k);
    if (v) env[k] = v;
  }
  // The deno cache lives under the REAL home unless DENO_DIR says otherwise;
  // a temp HOME would otherwise mean a cold cache (and a network fetch).
  if (!env.DENO_DIR && !env.XDG_CACHE_HOME) {
    const real = Deno.env.get("HOME");
    if (real) env.DENO_DIR = join(real, ".cache", "deno");
  }
  const r = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      "--allow-env",
      "--allow-write",
      GATE,
      ...args,
    ],
    env,
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  return { code: r.code, out: dec.decode(r.stdout) + dec.decode(r.stderr) };
}

/** A provisioned-version entry exactly as `ensureVersion` leaves one: a
 *  worktree whose `.git` FILE names its gitdir, plus the `.provisioned` marker. */
async function plant(store: string, ref: string, gitdir: string) {
  await Deno.mkdir(join(store, ref), { recursive: true });
  await Deno.writeTextFile(join(store, ref, ".git"), `gitdir: ${gitdir}\n`);
  await Deno.writeTextFile(join(store, `${ref}.provisioned`), `${ref}\n`);
}

Deno.test("check:home-clean: a version-store entry whose worktree points into a test sandbox is RED, named", async () => {
  const home = await tempDir("aio-fakehome-");
  try {
    const store = join(home, ".local", "lib", "aio-versions");
    // The legitimate shape: a worktree of the canonical install. Green.
    await plant(
      store,
      "v1.0.10-beta",
      join(home, ".local/lib/aio/.git/worktrees/v1.0.10-beta"),
    );
    const clean = await gate(home);
    assertEquals(clean.code, 0, clean.out);

    // The 10:39 fingerprint: tempDir("aio-pin-") + "install". Red.
    await plant(
      store,
      "v1.0.11-beta",
      join(
        home,
        "tmp/aio/aio-pin-e67fe664519b8608/install/.git/worktrees/v1.0.11-beta",
      ),
    );
    const red = await gate(home);
    assertEquals(red.code, 1, red.out);
    assertStringIncludes(red.out, join(store, "v1.0.11-beta"));
    assert(!red.out.includes(join(store, "v1.0.10-beta") + " →"), red.out);
  } finally {
    await dropTempDir(home);
  }
});

Deno.test("check:home-clean: --against fails when a run ADDS, changes or removes a real store entry", async () => {
  const home = await tempDir("aio-fakehome-");
  try {
    const store = join(home, ".local", "lib", "aio-versions");
    await plant(store, "v1.0.9-beta", "/elsewhere/.git/worktrees/v1.0.9-beta");
    const snap = join(home, "before.json");
    assertEquals((await gate(home, [`--save=${snap}`])).code, 0);
    // A real app running from its pin rewrites the worktree's deno.lock (and
    // with it the directory's mtime) — that is the user's app working, not a
    // test writing the store. Measured mid-run; it must stay green.
    await new Promise((r) => setTimeout(r, 20));
    const lock = join(store, "v1.0.9-beta", "deno.lock");
    await Deno.writeTextFile(lock + ".tmp", "{}");
    await Deno.rename(lock + ".tmp", lock);
    const same = await gate(home, [`--against=${snap}`]);
    assertEquals(same.code, 0, same.out);

    // Re-provisioning an EXISTING name rewrites its worktree link: red.
    await Deno.writeTextFile(
      join(store, "v1.0.9-beta", ".git"),
      "gitdir: /h/tmp/aio/aio-pin-x/install/.git/worktrees/v1.0.9-beta\n",
    );
    const reprov = await gate(home, [`--against=${snap}`]);
    assertEquals(reprov.code, 1, reprov.out);
    assertStringIncludes(reprov.out, `changed  ${join(store, "v1.0.9-beta")}`);
    await gate(home, [`--save=${snap}`]);

    // Any new entry — even one with no test fingerprint at all.
    await plant(store, "v9.9.9-fake", "/elsewhere/.git/worktrees/v9.9.9-fake");
    const red = await gate(home, [`--against=${snap}`]);
    assertEquals(red.code, 1, red.out);
    assertStringIncludes(red.out, `added    ${join(store, "v9.9.9-fake")}`);
    assertStringIncludes(
      red.out,
      `added    ${join(store, "v9.9.9-fake.provisioned")}`,
    );
  } finally {
    await dropTempDir(home);
  }
});

Deno.test("check:home-clean: storeChanges names every added, changed and removed entry", () => {
  assertEquals(
    storeChanges({ "/s/a": 1, "/s/b": 2 }, { "/s/a": 1, "/s/b": 2 }),
    [],
  );
  assertEquals(
    storeChanges({ "/s/a": 1, "/s/b": 2 }, { "/s/a": 5, "/s/c": 3 }),
    ["added    /s/c", "changed  /s/a", "removed  /s/b"],
  );
});

Deno.test("check:home-clean: the real stores watched are the version store and the install's worktree registry", () => {
  assertEquals(realStoreDirs({ HOME: "/h" }), [
    "/h/.local/lib/aio-versions",
    "/h/.local/lib/aio/.git/worktrees",
  ]);
  // A user's own relocation is watched too, beside the default.
  assertEquals(
    realStoreDirs({ HOME: "/h", AIO_VERSIONS_DIR: "/v", AIO_HOME: "/i" }),
    [
      "/v",
      "/h/.local/lib/aio-versions",
      "/i/.git/worktrees",
      "/h/.local/lib/aio/.git/worktrees",
    ],
  );
  assert(
    isTestGitdir("/h/tmp/aio/aio-pin-1/install/.git/worktrees/v", {
      HOME: "/h",
    }),
  );
  assert(isTestGitdir("/r/.aio-test-shards/2/x/.git", { HOME: "/h" }));
  assert(
    isTestGitdir("/t/root/x/.git", { HOME: "/h", AIO_TEST_ROOT: "/t/root" }),
  );
  assert(!isTestGitdir("/h/.local/lib/aio/.git/worktrees/v", { HOME: "/h" }));
  assert(!isTestGitdir("/h/tmp/aiox/.git", { HOME: "/h" }));
});

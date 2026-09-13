// An app whose NAME picks another program's directory is refused at boot.
//
// The home is `~/.<appId>`. An app with appId "ssh" booted into `~/.ssh` and
// wrote `data/state.db`, the control key and `logs/` beside `authorized_keys`,
// silently. `am create ssh` refuses the name, but `aio.run({ appId: "ssh" })`
// — or an app inferring its id from deno.json — never passes through
// `am create`. The boot check is structural: an existing, non-empty home with
// none of aio's own entries is not this app's, whatever it is called.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  _resetAppDirs,
  foreignAppHomeError,
  resolveAppDirs,
} from "../src/server/app-dirs.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ROOT = new URL("..", import.meta.url).pathname;

Deno.test("foreignAppHomeError: absent, empty and aio-owned homes pass; another program's directory does not", async () => {
  const dir = await tempDir("aio-foreign-home-");
  try {
    assertEquals(foreignAppHomeError("a", join(dir, "absent")), null);
    await Deno.mkdir(join(dir, "empty"));
    assertEquals(foreignAppHomeError("a", join(dir, "empty")), null);
    // An existing app: every boot creates data/ and logs/ first. Extra files
    // the app itself put in its home do not make it foreign.
    for (const marker of ["data", "logs", "launch.json"]) {
      const home = join(dir, `app-${marker}`);
      await Deno.mkdir(home);
      if (marker.endsWith(".json")) {
        await Deno.writeTextFile(join(home, marker), "{}");
      } else await Deno.mkdir(join(home, marker));
      await Deno.writeTextFile(join(home, "notes.txt"), "mine");
      assertEquals(foreignAppHomeError("a", home), null, marker);
    }
    const ssh = join(dir, ".ssh");
    await Deno.mkdir(ssh);
    await Deno.writeTextFile(join(ssh, "authorized_keys"), "ssh-ed25519 AAAA");
    const refusal = foreignAppHomeError("ssh", ssh);
    assert(refusal?.includes(`would keep its data in ${ssh}`), refusal!);
    assert(refusal!.includes("authorized_keys"), refusal!);
    assert(refusal!.includes("fix: give the app its own id"), refusal!);
    await Deno.writeTextFile(join(dir, "a-file"), "x");
    assert(
      foreignAppHomeError("x", join(dir, "a-file"))?.includes("is a FILE"),
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("resolveAppDirs: a DERIVED home that is another program's is refused; a chosen appDir or libraryMode is not", async () => {
  const dir = await tempDir("aio-foreign-resolve-");
  const prev = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", dir);
  try {
    await Deno.mkdir(join(dir, "dpkg"));
    await Deno.writeTextFile(join(dir, "dpkg", "status"), "Package: x");
    assertThrows(
      () => resolveAppDirs({ appId: "dpkg" }),
      Error,
      "is not an aio app's",
    );
    // Somebody wrote the path down on purpose — not the name's choice.
    assertEquals(
      resolveAppDirs({ appId: "dpkg", appDir: join(dir, "dpkg") }).home,
      join(dir, "dpkg"),
    );
    assertEquals(
      resolveAppDirs({ appId: "dpkg", libraryMode: true, baseDir: dir }).home,
      join(dir, ".aio"),
    );
    // Nothing was created by the refusal.
    assertEquals(
      [...Deno.readDirSync(join(dir, "dpkg"))].map((e) => e.name),
      ["status"],
    );
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    _resetAppDirs();
    await dropTempDir(dir);
  }
});

Deno.test({
  name:
    'boot: aio.run({ appId: "ssh" }) under a HOME with ~/.ssh refuses and writes nothing there',
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("aio-foreign-boot-");
    try {
      const home = join(dir, "home");
      const ssh = join(home, ".ssh");
      await Deno.mkdir(ssh, { recursive: true });
      await Deno.writeTextFile(join(ssh, "authorized_keys"), "ssh-ed25519 A");
      const proj = join(dir, "proj");
      await Deno.mkdir(proj);
      await Deno.writeTextFile(
        join(proj, "deno.json"),
        JSON.stringify({
          imports: {
            "aio": `${ROOT}mod.ts`,
            "immer": "npm:immer@10.2.0",
            "@std/path": "jsr:@std/path@^1",
          },
        }),
      );
      await Deno.writeTextFile(
        join(proj, "app.ts"),
        `import { aio, cell } from "aio";
const c = cell("resv", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });
await aio.run({ appId: "ssh", cells: [c] });
`,
      );
      // clearEnv: the runner's AIO_APPS_DIR pin must NOT reach the child — the
      // bug is the `~/.<appId>` rule itself. The module cache stays the real one.
      const realHome = Deno.env.get("HOME") ?? "";
      const out = await new Deno.Command(Deno.execPath(), {
        args: ["run", "-A", "--no-lock", "app.ts", "--client=server-only"],
        cwd: proj,
        clearEnv: true,
        env: {
          PATH: Deno.env.get("PATH") ?? "",
          HOME: home,
          XDG_RUNTIME_DIR: dir,
          DENO_DIR: Deno.env.get("DENO_DIR") ??
            join(
              Deno.env.get("XDG_CACHE_HOME") ?? join(realHome, ".cache"),
              "deno",
            ),
        },
        stdout: "piped",
        stderr: "piped",
        signal: AbortSignal.timeout(60_000),
      }).output();
      const text = new TextDecoder().decode(out.stdout) +
        new TextDecoder().decode(out.stderr);
      assert(!out.success, `booted into ~/.ssh:\n${text}`);
      assert(text.includes("is not an aio app's"), text);
      assertEquals(
        [...Deno.readDirSync(ssh)].map((e) => e.name),
        ["authorized_keys"],
        `the refused boot still wrote into ~/.ssh:\n${text}`,
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});

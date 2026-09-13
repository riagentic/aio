// A reserved name is refused at boot even when its directory does not exist yet.
//
// `foreignAppHomeError` refuses `~/.ssh` because it already holds another
// program's files. `aio.run({ appId: "kube" })` on a machine without kubectl
// had nothing to recognise: the boot created `~/.kube`, wrote `data/state.db`
// and the control key into it, and the first `kubectl config` later put the
// cluster credentials beside an app's DELETABLE data (`am remove kube --data`).
// `am create kube` refused that name all along — the list now lives where the
// home rule does (app-dirs.ts), and the boot reads it too.
//
// Every case runs under a temp HOME with AIO_APPS_DIR unset — never the real
// home — because `~/.<appId>` is the only shape the reservation is about.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  _resetAppDirs,
  RESERVED_APP_NAMES as BOOT_RESERVED,
  reservedAppHomeError,
  resolveAppDirs,
} from "../src/server/app-dirs.ts";
import { RESERVED_APP_NAMES as AM_RESERVED } from "../src/am/am-utils.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const ROOT = new URL("..", import.meta.url).pathname;

async function withTempHome(fn: (home: string) => void | Promise<void>) {
  const dir = await tempDir("aio-reserved-home-");
  const prev = {
    HOME: Deno.env.get("HOME"),
    AIO_APPS_DIR: Deno.env.get("AIO_APPS_DIR"),
  };
  const home = join(dir, "home");
  await Deno.mkdir(home);
  Deno.env.set("HOME", home);
  Deno.env.delete("AIO_APPS_DIR");
  _resetAppDirs();
  try {
    await fn(home);
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) Deno.env.delete(k);
      else Deno.env.set(k, v);
    }
    _resetAppDirs();
    await dropTempDir(dir);
  }
}

Deno.test("reserved names: am and the boot read ONE list", () => {
  assert(AM_RESERVED === BOOT_RESERVED, "am re-exports the boot's set");
  assert(AM_RESERVED.has("kube") && AM_RESERVED.has("aio"));
});

Deno.test("resolveAppDirs: a reserved ~/.<name> that does not exist yet is refused, and not created", () =>
  withTempHome((home) => {
    for (const id of ["kube", "KUBE", "aio"]) {
      assertThrows(
        () => resolveAppDirs({ appId: id }),
        Error,
        "that name is reserved",
      );
    }
    assertEquals(
      [...Deno.readDirSync(home)],
      [],
      "the refusal created nothing",
    );
    // An ordinary name with no home yet is the normal first boot.
    assertEquals(
      resolveAppDirs({ appId: "my-app" }).home,
      join(home, ".my-app"),
    );
  }));

Deno.test("resolveAppDirs: a reserved dir holding a lone aio-looking entry is still refused", () =>
  withTempHome(async (home) => {
    // `~/.config/app/` is some tool's folder, not evidence of an aio app —
    // and `foreignAppHomeError` accepts any one aio entry name as a marker.
    await Deno.mkdir(join(home, ".config", "app"), { recursive: true });
    assertThrows(
      () => resolveAppDirs({ appId: "config" }),
      Error,
      "reserved",
    );
  }));

Deno.test("resolveAppDirs: an EXISTING app under a reserved name, a chosen appDir, and AIO_APPS_DIR all boot", () =>
  withTempHome(async (home) => {
    // data/ + logs/ — the pair every boot creates first.
    await Deno.mkdir(join(home, ".kube", "data"), { recursive: true });
    await Deno.mkdir(join(home, ".kube", "logs"));
    assertEquals(resolveAppDirs({ appId: "kube" }).home, join(home, ".kube"));
    assertEquals(reservedAppHomeError("kube", join(home, ".kube")), null);

    const chosen = join(home, "wherever");
    assertEquals(resolveAppDirs({ appId: "ssh", appDir: chosen }).home, chosen);

    Deno.env.set("AIO_APPS_DIR", join(home, "apps"));
    try {
      assertEquals(
        resolveAppDirs({ appId: "ssh" }).home,
        join(home, "apps", "ssh"),
        "<root>/ssh is nobody else's directory",
      );
    } finally {
      Deno.env.delete("AIO_APPS_DIR");
    }
  }));

Deno.test({
  name:
    'boot: aio.run({ appId: "kube" }) under a HOME with no ~/.kube refuses and creates nothing',
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("aio-reserved-boot-");
    try {
      const home = join(dir, "home");
      await Deno.mkdir(home);
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
await aio.run({ appId: "kube", cells: [c] });
`,
      );
      // clearEnv: the runner's AIO_APPS_DIR pin must NOT reach the child.
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
      assert(!out.success, `booted into ~/.kube:\n${text}`);
      assert(text.includes("that name is reserved"), text);
      assertEquals(
        [...Deno.readDirSync(home)].map((e) => e.name),
        [],
        `the refused boot still created ~/.kube:\n${text}`,
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});

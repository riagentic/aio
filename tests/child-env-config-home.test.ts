// A spawned test app must not write into the developer's `~/.config`.
//
// An app started with `--client=electron` writes its window's main script into
// the window's PROFILE directory — `$XDG_CONFIG_HOME/<name>`, else
// `~/.config/<name>` — and a real Electron then keeps a whole Chromium profile
// there. `AIO_APPS_DIR` moves the app's data and nothing of this. MEASURED
// 2026-10-08: 73 `~/.config/app-<id>@<hash>` on one workstation, one per run
// of a test that launched a uniquely named app, and no gate looked there.
//
// `childEnv()` is where every spawned test app gets its floor, so that is
// where the config home is pinned. Instrument: `$ELECTRON_PATH` pointed at a
// shell stub that records its arguments — it never opens a window. The app
// runs with a THROWAWAY HOME, so an unpinned launch shows up in that home's
// `.config` and never in the real one.
import { assert, assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { electronProfileDir } from "../src/electron/electron-spawn.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { aioTestRoot } from "../src/testing/test-strict.ts";
import { DENO_DIR } from "./deno-dir-helper.ts";
import { accountEnv, childEnv, ownAccount } from "./e2e-app-harness.ts";
import { spec } from "./module-spec-helper.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url)).replace(/[\\/]$/, "");

Deno.test("childEnv: the child's config home is a sandbox of this run — never the parent's own, and a test's choice wins", () => {
  const prev = Deno.env.get("XDG_CONFIG_HOME");
  Deno.env.set("XDG_CONFIG_HOME", "/the/developers/own");
  try {
    const cfg = childEnv().XDG_CONFIG_HOME!;
    assert(cfg.startsWith(aioTestRoot()), cfg);
    assertEquals(childEnv().XDG_CONFIG_HOME, cfg, "one per test file");
    assertEquals(
      electronProfileDir(
        "app-1a2b3c4d@0f9e8d7c",
        "linux",
        (k) => childEnv()[k],
      ),
      join(cfg, "app-1a2b3c4d@0f9e8d7c"),
    );
    assertEquals(
      childEnv({ XDG_CONFIG_HOME: "/mine" }).XDG_CONFIG_HOME,
      "/mine",
    );
  } finally {
    if (prev === undefined) Deno.env.delete("XDG_CONFIG_HOME");
    else Deno.env.set("XDG_CONFIG_HOME", prev);
  }
});

// The same sandbox where the OS has no variable for the profile's parent
// alone. MEASURED on Windows 11 with Electron 44.4.1: `%APPDATA%` by itself
// does NOT move a real window's `userData` — the shell expands the known
// folder from `%USERPROFILE%` — so both are set, and they agree.
Deno.test("accountEnv: per OS, the variables that move a window's profile — and the caches that must not move with it", () => {
  const from = (o: Record<string, string>) => (k: string) => o[k];
  const at = (os: string, e: Record<string, string>) =>
    electronProfileDir("p@1a2b3c4d", os, (k) => e[k]);

  const linux = accountEnv("/t/acct", "linux", from({ HOME: "/home/d" }));
  assertEquals(linux, { XDG_CONFIG_HOME: "/t/acct" });
  assertEquals(at("linux", linux), join("/t/acct", "p@1a2b3c4d"));

  const mac = accountEnv("/t/acct", "darwin", from({ HOME: "/Users/d" }));
  assertEquals(mac, {
    XDG_CONFIG_HOME: "/t/acct",
    HOME: "/t/acct",
    CFFIXED_USER_HOME: "/t/acct",
    DENO_DIR: join("/Users/d", "Library", "Caches", "deno"),
    XDG_CACHE_HOME: join("/Users/d", ".cache"),
  });
  assertEquals(
    at("darwin", mac),
    join("/t/acct", "Library", "Application Support", "p@1a2b3c4d"),
  );

  const win = accountEnv(
    "C:\\t\\acct",
    "windows",
    from({ USERPROFILE: "C:\\Users\\d", LOCALAPPDATA: "C:\\Users\\d\\L" }),
  );
  assertEquals(win, {
    XDG_CONFIG_HOME: "C:\\t\\acct",
    USERPROFILE: "C:\\t\\acct",
    APPDATA: join("C:\\t\\acct", "AppData", "Roaming"),
    LOCALAPPDATA: join("C:\\t\\acct", "AppData", "Local"),
    DENO_DIR: join("C:\\Users\\d\\L", "deno"),
    XDG_CACHE_HOME: join("C:\\Users\\d", ".cache"),
  });
  assertEquals(
    at("windows", win),
    join("C:\\t\\acct", "AppData", "Roaming", "p@1a2b3c4d"),
  );

  // Caches someone already placed stay where they are.
  const pinned = accountEnv(
    "/t/acct",
    "darwin",
    from({ HOME: "/Users/d", DENO_DIR: "/d", XDG_CACHE_HOME: "/c" }),
  );
  assertEquals([pinned.DENO_DIR, pinned.XDG_CACHE_HOME], ["/d", "/c"]);
});

// `...Deno.env.toObject()` is how most tests build a child's env. It carries
// the developer's own HOME / XDG_CONFIG_HOME into `own` — where it read as
// "the test chose this", and the sandbox stepped aside for it.
Deno.test("childEnv: an account value that only repeats this process's is not a choice — the sandbox stands; ownAccount() gives this process the same one and hands it back", () => {
  const key = Deno.build.os === "windows"
    ? "USERPROFILE"
    : Deno.build.os === "darwin"
    ? "HOME"
    : "XDG_CONFIG_HOME";
  const prev = Deno.env.get(key);
  Deno.env.set(key, "/the/developers/own");
  try {
    const sandbox = childEnv()[key]!;
    assert(sandbox.startsWith(aioTestRoot()), sandbox);
    assertEquals(childEnv({ ...Deno.env.toObject() })[key], sandbox);
    assertEquals(childEnv({ [key]: "/mine" })[key], "/mine");
    {
      using _home = ownAccount();
      assertEquals(Deno.env.get(key), sandbox);
    }
    assertEquals(Deno.env.get(key), "/the/developers/own");
  } finally {
    if (prev === undefined) Deno.env.delete(key);
    else Deno.env.set(key, prev);
  }
});

Deno.test({
  name:
    "childEnv: an electron-client app writes its window's files into the sandboxed config home, not $HOME/.config",
  ignore: Deno.build.os !== "linux", // XDG_CONFIG_HOME is Linux's rule; macOS and Windows derive the profile directory from the account
  async fn() {
    const dir = await tempDir("child-cfg-");
    try {
      const ready = join(dir, "ready");
      const argv = join(dir, "argv");
      const stub = join(dir, "electron");
      await Deno.writeTextFile(
        stub,
        `#!/bin/sh
echo "$@" > '${argv}'
i=0
while [ ! -f '${ready}' ] && [ $i -lt 300 ]; do sleep 0.1; i=$((i+1)); done
exit 0
`,
      );
      await Deno.chmod(stub, 0o755);
      const app = join(dir, "app");
      await Deno.mkdir(join(app, "src"), { recursive: true });
      const head = JSON.parse(await Deno.readTextFile(join(ROOT, "deno.json")));
      const imports: Record<string, string> = {};
      for (
        const [k, v] of Object.entries(head.imports as Record<string, string>)
      ) imports[k] = v.startsWith("./") ? `${spec(ROOT)}/${v.slice(2)}` : v;
      await Deno.writeTextFile(
        join(app, "deno.json"),
        JSON.stringify({ compilerOptions: head.compilerOptions, imports }),
      );
      await Deno.writeTextFile(
        join(app, "src", "cell.ts"),
        `import { cell } from "aio";\nexport const c = cell("c", { state: { v: "" }, methods: {} });\n`,
      );
      await Deno.writeTextFile(
        join(app, "src", "App.tsx"),
        `import { c } from "./cell.ts";\nexport default function App() { return <p>{c.v}</p>; }\n`,
      );
      await Deno.writeTextFile(
        join(app, "src", "app.ts"),
        `import { c } from "./cell.ts";
import { aio } from "aio";
await aio.run({ appId: "cfghome", cells: [c] });
Deno.writeTextFileSync(Deno.env.get("READY")!, "1");
`,
      );
      const home = join(dir, "home");
      await Deno.mkdir(home);
      const env = childEnv({
        ...testDisplayEnv(), // the test's own display; the stub opens nothing
        ELECTRON_PATH: stub,
        AIO_APPS_DIR: join(dir, "apps"),
        HOME: home,
        DENO_DIR,
        READY: ready,
      });
      const child = new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          "src/app.ts",
          "--client=electron",
          `--port=${freePort()}`,
        ],
        cwd: app,
        env,
        stdout: "piped",
        stderr: "piped",
      }).spawn();
      const dec = new TextDecoder();
      let log = "";
      const pump = async (s: ReadableStream<Uint8Array>) => {
        for await (const x of s) log += dec.decode(x);
      };
      const pumps = Promise.all([pump(child.stdout), pump(child.stderr)]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const st = await Promise.race([
        child.status,
        new Promise<null>((r) => timer = setTimeout(() => r(null), 90_000)),
      ]).finally(() => clearTimeout(timer));
      if (!st) {
        child.kill("SIGKILL");
        await child.status;
      }
      await pumps;
      assert(st, `the app never exited after its window ended:\n${log}`);
      const args = await Deno.readTextFile(argv).catch(() => "");
      assert(args, `the stub was never launched — nothing was tested:\n${log}`);
      const cfg = env.XDG_CONFIG_HOME!;
      assert(
        args.includes(join(cfg, "aio-app@")),
        `the window's main script is not under ${cfg}:\n${args}`,
      );
      assert(!args.includes(join(home, ".config")), args);
      assertEquals(
        await Deno.stat(join(home, ".config")).then(() => 1, () => 0),
        0,
        "the launch made a .config in the child's HOME",
      );
    } finally {
      await dropTempDir(dir);
    }
  },
});

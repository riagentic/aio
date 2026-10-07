// A `<webview>` guest preload in a PACKAGED app — the real artifact, a real
// window, a real guest.
//
// From a field report (a wallet app): the guest preload worked in
// `deno task dev` and was silently dropped in every packaged build, because
// the package's `dist/` is an allowlist the app could not add a file to and
// the refusal was one main-process line. `build.guestPreloads` stages the
// declared files into the package and `guestPreload()` names them the same
// way in dev and in the package; this runs BOTH and asserts the preload's
// marker inside the guest page.
//
// `__aioIPC.openWindow(url, { preload })` had the same gap (its preload had to
// sit in the app directory — `dist/` in a package) and takes the same name:
// the app opens one child window, whose page reports the marker too.
//
// Opt-in like every artifact test that needs the Electron runtime
// (AIO_BUILD_E2E=1 AIO_BUILD_ELECTRON=1), and only on the contained test
// display.
//
// macOS runs the PACKAGED half natively: the sealed `.app`, whose preloads
// sit in `Contents/Resources/guest-preloads/` — the one place this feature
// differs per OS. There is no contained display there: the window opens on
// the logged-in desktop, for the few seconds the run takes. On a Mac:
//   AIO_BUILD_E2E=1 AIO_BUILD_ELECTRON=1 deno test -A --no-check=remote \
//     tests/electron-guest-preload-artifact-e2e.test.ts
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  buildFlags,
  childEnv,
  freePort,
  kill,
  makeApp,
  REPO_ROOT,
} from "./e2e-app-harness.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { guestPreload } from "../src/protocol/guest-preload.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const GATE = Deno.env.get("AIO_BUILD_E2E") === "1" &&
  Deno.env.get("AIO_BUILD_ELECTRON") === "1";
const LINUX = Deno.build.os === "linux";
const MAC = Deno.build.os === "darwin";
const DECLARED = "src/guest/preload.cjs";
const UNDECLARED = "src/guest/other.cjs";

/** The guest's origin: one page whose OWN script reports the marker the
 *  preload left in its DOM — `none` when no preload ran. */
function guestServer(): {
  port: number;
  seen: string[];
  stop(): Promise<void>;
} {
  const port = freePort();
  const seen: string[] = [];
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen() {} },
    (req) => {
      const u = new URL(req.url);
      if (u.pathname === "/seen") {
        seen.push(`${u.searchParams.get("who")}=${u.searchParams.get("m")}`);
        return new Response("ok");
      }
      return new Response(
        `<!doctype html><title>guest</title><p>guest</p><script>
addEventListener("load", () => fetch("/seen?who=" + location.pathname.slice(1) +
  "&m=" + (document.documentElement.getAttribute("data-guest-preload") || "none")));
</script>`,
        { headers: { "content-type": "text/html" } },
      );
    },
  );
  return { port, seen, stop: () => server.shutdown() };
}

/** The counter scaffold with two guests: one whose preload is declared, one
 *  whose preload is not. */
async function makeGuestApp(port: number): Promise<string> {
  const dir = await makeApp("counter", "guest-preload-e2e-");
  await Deno.mkdir(join(dir, "src", "guest"), { recursive: true });
  const preload = (mark: string) =>
    `window.addEventListener("DOMContentLoaded", () => {\n` +
    `  document.documentElement.setAttribute("data-guest-preload", ${
      JSON.stringify(mark)
    });\n});\n`;
  await Deno.writeTextFile(join(dir, DECLARED), preload("declared"));
  await Deno.writeTextFile(join(dir, UNDECLARED), preload("undeclared"));
  await Deno.writeTextFile(
    join(dir, "src", "app.ts"),
    `import "./cell.ts";\nimport { aio } from "aio";\n` +
      `await aio.run({ ui: { theme: "auto" }, childWindows: true });\n`,
  );
  await Deno.writeTextFile(
    join(dir, "src", "App.tsx"),
    `import { guestPreload } from "aio/ui";
const box = { width: "300px", height: "200px", display: "inline-flex" };
// Built at run time on purpose: the build refuses a LITERAL undeclared name,
// and this test wants the run-time refusal.
const other = ["src", "guest", "other.cjs"].join("/");
addEventListener("aio:guest-preload-refused", (e) => {
  fetch("http://127.0.0.1:${port}/seen?who=event&m=" +
    encodeURIComponent((e as CustomEvent).detail.preload), { mode: "no-cors" });
});
// A child window with the SAME declared preload (the server render has no
// __aioIPC). A refusal is reported as the page's marker, so the run fails on
// its reason instead of waiting for a window that never opens.
// deno-lint-ignore no-explicit-any
const ipc = (globalThis as any).__aioIPC;
if (ipc?.openWindow) {
  ipc.openWindow("http://127.0.0.1:${port}/c", {
    preload: guestPreload(${JSON.stringify(DECLARED)}),
  }).catch((e: Error) =>
    fetch("http://127.0.0.1:${port}/seen?who=c&m=" +
      encodeURIComponent("refused: " + e.message), { mode: "no-cors" })
  );
}
export default function App() {
  return (
    <main>
      <h1>host</h1>
      <webview src="http://127.0.0.1:${port}/a" style={box}
        preload={guestPreload(${JSON.stringify(DECLARED)})} />
      <webview src="http://127.0.0.1:${port}/b" style={box}
        preload={guestPreload(other)} />
    </main>
  );
}
`,
  );
  const cfgPath = join(dir, "deno.json");
  const cfg = JSON.parse(await Deno.readTextFile(cfgPath));
  cfg.build.guestPreloads = [DECLARED];
  await Deno.writeTextFile(cfgPath, JSON.stringify(cfg, null, 2));
  return dir;
}

async function waitFor<T>(
  f: () => T | undefined,
  ms: number,
  what: () => string,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = f();
    if (v !== undefined) return v;
    if (Date.now() > end) throw new Error(what());
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Run `cmd` as the app, wait for both guests to report, and return the
 *  process's output plus its app.log. */
async function runAndCollect(
  cmd: string,
  args: string[],
  cwd: string,
  g: { seen: string[] },
  extraEnv: Record<string, string> = {},
): Promise<string> {
  const home = await tempDir("gp-home-");
  g.seen.length = 0;
  const proc = new Deno.Command(cmd, {
    args,
    cwd,
    env: childEnv({
      ...testDisplayEnv(),
      ...extraEnv,
      AIO_APPS_DIR: home,
      // Electron's profile (userData) — never the developer's ~/.config.
      XDG_CONFIG_HOME: join(home, "config"),
      // …nor, on macOS, their ~/Library: CoreFoundation takes the home from
      // the account, not from $HOME, unless this names one. And no "Move to
      // Applications?" dialog on the desktop of whoever runs this.
      ...(MAC
        ? {
          HOME: home,
          CFFIXED_USER_HOME: home,
          AIO_MOVE_TO_APPLICATIONS: "never",
        }
        : {}),
      APPIMAGE_EXTRACT_AND_RUN: "1",
      TMPDIR: home,
    }),
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let out = "";
  const drain = async (s: ReadableStream<Uint8Array>) => {
    for await (const c of s) out += new TextDecoder().decode(c);
  };
  drain(proc.stdout).catch(() => {});
  drain(proc.stderr).catch(() => {});
  try {
    const has = (who: string) => g.seen.some((s) => s.startsWith(who + "="));
    await waitFor(
      () => has("a") && has("b") && has("c") && has("event") ? true : undefined,
      120_000,
      () =>
        `the guests never reported (saw ${JSON.stringify(g.seen)}):\n` +
        out.slice(-6000),
    );
    // The refusal travels main process → stderr → the server's logger → the
    // file, so it lands a moment after the page's event: wait for it.
    const readLog = () => {
      let t = "";
      for (const e of Deno.readDirSync(home)) {
        try {
          t += Deno.readTextFileSync(join(home, e.name, "logs", "app.log"));
        } catch { /* not an app home */ }
      }
      return t;
    };
    const appLog = await waitFor(
      () => readLog().includes("preload REFUSED") ? readLog() : undefined,
      15_000,
      () => `no refusal in app.log:\n${readLog().slice(-4000)}`,
    );
    if (MAC) {
      // Chromium's own files, not only the ones aio writes there by $HOME:
      // the window's profile really is in this run's home.
      const profiles = join(home, "Library", "Application Support");
      const made = [...Deno.readDirSync(profiles)].flatMap((p) =>
        [...Deno.readDirSync(join(profiles, p.name))].map((e) => e.name)
      );
      assert(
        made.some((n) => !n.startsWith("aio-")),
        `Electron's profile is not under this run's home — it escaped to ` +
          `the real ~/Library. ${profiles} holds only ${JSON.stringify(made)}`,
      );
    }
    return out + "\n--- app.log ---\n" + appLog;
  } finally {
    await kill(proc);
    await dropTempDir(home);
  }
}

/** What both runs must show: the declared preload ran in its guest, the
 *  undeclared one was refused — in the log FILE, naming the file and the fix
 *  — and the page was told. */
function assertGuests(g: { seen: string[] }, log: string, where: string): void {
  assert(
    g.seen.includes("a=declared"),
    `${where}: the declared guest preload did not run — guests reported ${
      JSON.stringify(g.seen)
    }\n${log.slice(-6000)}`,
  );
  assertEquals(
    g.seen.filter((s) => s.startsWith("c=")),
    ["c=declared"],
    `${where}: the declared preload did not run in the openWindow child ` +
      `window\n${log.slice(-6000)}`,
  );
  assert(
    g.seen.includes("b=none"),
    `${where}: an UNDECLARED guest preload must not run — ${
      JSON.stringify(g.seen)
    }`,
  );
  assert(
    g.seen.includes(`event=${guestPreload(UNDECLARED)}`),
    `${where}: the page was not told of the refusal — ${
      JSON.stringify(g.seen)
    }`,
  );
  const fileLog = log.split("--- app.log ---")[1] ?? "";
  assertStringIncludes(fileLog, "preload REFUSED", `${where}: app.log`);
  assertStringIncludes(fileLog, UNDECLARED, `${where}: app.log names the file`);
  assertStringIncludes(fileLog, '"guestPreloads"', `${where}: and the fix`);
}

/** The signed bundle a macOS build ships as its update artifact, unpacked:
 *  its executable, after checking what only a Mac can — the preload is in
 *  `Contents/Resources/` and the seal covers it. */
async function unpackedMacApp(dist: string, into: string): Promise<string> {
  const tgz = [...Deno.readDirSync(dist)].map((e) => e.name)
    .find((n) => n.endsWith(".app.tar.gz"));
  assert(tgz, "no .app.tar.gz in dist/");
  const run = async (cmd: string, args: string[]) => {
    const o = await new Deno.Command(cmd, { args, stderr: "piped" }).output();
    return { ok: o.success, err: new TextDecoder().decode(o.stderr) };
  };
  const x = await run("tar", ["-xzf", join(dist, tgz), "-C", into]);
  assert(x.ok, `tar: ${x.err}`);
  const app = join(
    into,
    [...Deno.readDirSync(into)].find((e) => e.name.endsWith(".app"))!.name,
  );
  await Deno.stat(
    join(
      app,
      "Contents",
      "Resources",
      "guest-preloads",
      ...DECLARED.split("/"),
    ),
  );
  const seal = await run("codesign", ["--verify", "--deep", "--strict", app]);
  assert(seal.ok, `the seal does not hold with the preload in it: ${seal.err}`);
  // The bundle executable: the one real file beside the window link.
  const exe = [...Deno.readDirSync(join(app, "Contents", "MacOS"))]
    .find((e) => e.isFile && !e.isSymlink);
  assert(exe, "no executable in Contents/MacOS");
  return join(app, "Contents", "MacOS", exe.name);
}

/** What macOS itself keeps per bundle id, outside any home a run can name
 *  (measured: both appeared with HOME and CFFIXED_USER_HOME redirected) — the
 *  defaults domain `~/Library/Preferences/<id>.plist`, the app's (empty)
 *  recent-documents list, and the Metal shader cache in the per-user cache
 *  directory. One of each per scaffolded app id, so this run takes its own
 *  away. */
async function forgetMacBundle(exe: string): Promise<void> {
  const out = async (cmd: string, args: string[]) =>
    new TextDecoder().decode(
      (await new Deno.Command(cmd, { args, stderr: "null" }).output()).stdout,
    ).trim();
  const id = await out("/usr/libexec/PlistBuddy", [
    "-c",
    "Print CFBundleIdentifier",
    join(exe, "..", "..", "Info.plist"),
  ]);
  assert(id.startsWith("app.aio.app-"), `not this test's bundle id: ${id}`);
  // The domain, then its file: `defaults delete` leaves an empty plist
  // (measured). The file is in the ACCOUNT's home — the preferences daemon
  // never saw this process's $HOME — which `id -P` gives as its 9th field.
  await out("/usr/bin/defaults", ["delete", id]);
  const home = (await out("/usr/bin/id", ["-P"])).split(":")[8]!;
  const cache = await out("/usr/bin/getconf", ["DARWIN_USER_CACHE_DIR"]);
  const recents = join(
    home,
    "Library",
    "Application Support",
    "com.apple.sharedfilelist",
    "com.apple.LSSharedFileList.ApplicationRecentDocuments",
    `${id}.sfl4`,
  );
  // Its daemon writes the list some seconds AFTER the launch (measured: it
  // appeared once the app, and this cleanup, were long gone) — so wait for
  // the file rather than remove a name that is not there yet.
  await waitFor(
    () => {
      try {
        return Deno.statSync(recents);
      } catch (e) {
        if (!(e instanceof Deno.errors.NotFound)) throw e;
      }
    },
    60_000,
    () => `macOS never wrote ${recents} — is it still what a launch leaves?`,
  );
  for (
    const left of [
      join(home, "Library", "Preferences", `${id}.plist`),
      recents,
      join(cache, id),
    ]
  ) {
    await Deno.remove(left, { recursive: true }).catch((e) => {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    });
  }
}

Deno.test({
  name: "guest preload e2e: a declared preload runs in a <webview> and in " +
    "an openWindow child window, in dev AND in the packaged app; an " +
    "undeclared one is refused loudly in both",
  ignore: !GATE || !(MAC || (LINUX && !!testDisplayEnv().DISPLAY)),
  sanitizeResources: false, // aio-ok: real Electron children own sockets and timers; teardown kills them
  sanitizeOps: false, // aio-ok: real Electron children own sockets and timers; teardown kills them
  async fn() {
    const g = guestServer();
    const dir = await makeGuestApp(g.port);
    const foreign = await tempDir("foreign-cwd-");
    let macExe: string | undefined;
    try {
      // ── dev ── (Linux: dev resolves the declaration in the project
      // directory, the same code on every OS; what differs on macOS is the
      // bundle below)
      if (LINUX) {
        const devLog = await runAndCollect(
          "deno",
          ["run", "-A", "src/app.ts", "--client=electron"],
          dir,
          g,
          {
            ELECTRON_PATH: join(
              REPO_ROOT,
              "node_modules/electron/dist/electron",
            ),
          },
        );
        assertGuests(g, devLog, "dev");
      }

      // ── the package ──
      const r = await buildFlags(dir, "--compile", "--electron");
      assertEquals(r.code, 0, `electron build failed:\n${r.out}\n${r.err}`);
      let imagePath: string;
      if (MAC) {
        imagePath = macExe = await unpackedMacApp(join(dir, "dist"), foreign);
      } else {
        const image = [...Deno.readDirSync(join(dir, "dist"))]
          .map((e) => e.name).find((n) =>
            n.toLowerCase().endsWith(".appimage")
          );
        assert(image, "no AppImage in dist/");
        imagePath = join(dir, "dist", image);
        await Deno.chmod(imagePath, 0o755);
      }
      // From a FOREIGN cwd, with the source tree out of reach: only what the
      // package carries can satisfy the preload.
      await Deno.rename(join(dir, "src"), join(dir, "src.moved"));
      const pkgLog = await runAndCollect(
        imagePath,
        ["--client=electron"],
        foreign,
        g,
      );
      assertGuests(g, pkgLog, "packaged");
    } finally {
      if (macExe) await forgetMacBundle(macExe);
      await g.stop();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
      await dropTempDir(foreign);
    }
  },
});

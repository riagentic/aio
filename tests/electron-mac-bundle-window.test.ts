// macOS: the window must BE the app the user installed.
//
// Measured on macOS 14 (a packaged app in /Applications): the window was
// started as `…/Contents/MacOS/electron/Electron.app/Contents/MacOS/Electron`,
// so the system registered the NESTED bundle as the running app. Opening the
// app a second time (`open`, Finder, the Dock) found nothing running at the
// installed path and added a second record for the same bundle id, bound to
// the server process — which takes no Apple events. `tell application id … to
// quit` then failed 3/3 (`-600` / `-1712`) with every process still alive.
//
// macOS reads which bundle a process belongs to from the path it was STARTED
// by, links unresolved. So the bundle carries a link in its own
// `Contents/MacOS/` and the launcher starts the window through it: one record,
// at the installed path, which takes the quit (after 1, 2 and 3 re-opens).
// Being the main bundle has two consequences this file also pins, both
// measured: the app's language is chosen from the main bundle's `.lproj`
// directories (without them an `en-GB` preference became `en-US`), and its
// `Info.plist` is the one the window is read by.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  assembleMacApp,
  inheritWindowPlistKeys,
  MAC_MINIMUM_SYSTEM_FLOOR,
  macAppPlist,
  macMinimumSystemVersion,
  plistTopLevelRows,
} from "../src/build/macos-app.ts";
import {
  MAC_WINDOW_LINK,
  MAC_WINDOW_LINK_TARGET,
} from "../src/electron/electron-runtime-fetch.ts";
import {
  findElectronBin,
  macWindowLinkState,
  packagedElectronCandidates,
} from "../src/electron/electron-spawn.ts";
import {
  electronLaunchFailurePlan,
  electronMissingLines,
  windowlessStops,
} from "../src/server/aio-lifecycle.ts";
import { electronMainScript } from "../src/electron/electron-scripts.ts";
import { electronMainScriptUDS } from "../src/electron/electron-uds.ts";
import { tmplTray } from "../src/electron/electron-shared.ts";
import { slugify } from "../src/build/build-helpers.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("mac window: the launcher starts the window through the bundle's own link, before the nested path", () => {
  const exe = "/Applications/Counter.app/Contents/MacOS/counter";
  const dir = "/Applications/Counter.app/Contents/MacOS";
  assertEquals(packagedElectronCandidates(exe, "darwin"), [
    join(dir, MAC_WINDOW_LINK),
    // A bundle assembled before the link existed still finds its runtime.
    join(dir, "electron", "Electron.app", "Contents", "MacOS", "Electron"),
  ]);
  // Only macOS has bundles: the other platforms' candidates are unchanged.
  assertEquals(packagedElectronCandidates("/opt/a/a", "linux"), [
    join("/opt/a", "electron", "electron"),
  ]);
  assertEquals(packagedElectronCandidates("/opt/a/a.exe", "windows"), [
    join("/opt/a", "electron", "electron.exe"),
  ]);
});

Deno.test("mac window: the link's name can never be an app's binary or the runtime directory", () => {
  // Both sit in Contents/MacOS, on a disk that ignores case.
  assert(
    slugify(MAC_WINDOW_LINK) !== MAC_WINDOW_LINK,
    "a binary name is a slug — the link's name must not be one",
  );
  assert(MAC_WINDOW_LINK.toLowerCase() !== "electron");
  assert(!MAC_WINDOW_LINK.includes("/"));
});

const ELECTRON_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>Electron</string>
	<key>CFBundleIdentifier</key>
	<string>com.github.Electron</string>
	<key>ElectronAsarIntegrity</key>
	<dict>
		<key>Resources/default_app.asar</key>
		<dict>
			<key>NSInner</key>
			<string>not-top-level</string>
		</dict>
	</dict>
	<key>LSEnvironment</key>
	<dict>
		<key>MallocNanoZone</key>
		<string>0</string>
	</dict>
	<key>LSMinimumSystemVersion</key>
	<string>13.0</string>
	<key>NSAppTransportSecurity</key>
	<dict>
		<key>NSAllowsArbitraryLoads</key>
		<true/>
	</dict>
	<key>NSCameraUsageDescription</key>
	<string>This app needs access to the camera</string>
	<key>NSHighResolutionCapable</key>
	<false/>
	<key>NSPrincipalClass</key>
	<string>AtomApplication</string>
	<key>NSSupportsAutomaticGraphicsSwitching</key>
	<true/>
</dict>
</plist>
`;

Deno.test("mac window: plistTopLevelRows reads top-level keys only, nested values whole", () => {
  const rows = plistTopLevelRows(ELECTRON_PLIST);
  assertEquals(rows.map((r) => r.key), [
    "CFBundleExecutable",
    "CFBundleIdentifier",
    "ElectronAsarIntegrity",
    "LSEnvironment",
    "LSMinimumSystemVersion",
    "NSAppTransportSecurity",
    "NSCameraUsageDescription",
    "NSHighResolutionCapable",
    "NSPrincipalClass",
    "NSSupportsAutomaticGraphicsSwitching",
  ]);
  const ats = rows.find((r) => r.key === "NSAppTransportSecurity")!.value;
  assert(ats.startsWith("<dict>") && ats.endsWith("</dict>"), ats);
  assert(ats.includes("<key>NSAllowsArbitraryLoads</key>"));
  const asar = rows.find((r) => r.key === "ElectronAsarIntegrity")!.value;
  assert(asar.endsWith("</dict>") && asar.includes("not-top-level"), asar);
});

Deno.test("mac window: the bundle's plist takes the runtime's NS/Electron keys and keeps its own", () => {
  const own = macAppPlist({
    name: "Counter",
    executable: "counter",
    identifier: "app.aio.counter",
    iconFile: "AppIcon",
    version: "1.0.0",
  });
  const out = inheritWindowPlistKeys(own, ELECTRON_PLIST);
  const rows = new Map(plistTopLevelRows(out).map((r) => [r.key, r.value]));
  // The window's own declarations arrive…
  assertEquals(rows.get("NSSupportsAutomaticGraphicsSwitching"), "<true/>");
  assertEquals(
    rows.get("NSPrincipalClass"),
    "<string>AtomApplication</string>",
  );
  assertEquals(
    rows.get("NSCameraUsageDescription"),
    "<string>This app needs access to the camera</string>",
  );
  assert(
    rows.get("NSAppTransportSecurity")?.includes("NSAllowsArbitraryLoads"),
  );
  assert(rows.get("ElectronAsarIntegrity")?.includes("default_app.asar"));
  // …the bundle's identity and whatever it already states stay its own…
  assertEquals(rows.get("CFBundleExecutable"), "<string>counter</string>");
  assertEquals(
    rows.get("CFBundleIdentifier"),
    "<string>app.aio.counter</string>",
  );
  assertEquals(rows.get("NSHighResolutionCapable"), "<true/>");
  assertEquals(
    plistTopLevelRows(out).filter((r) => r.key === "NSHighResolutionCapable")
      .length,
    1,
    "a key the bundle states is not written twice",
  );
  // …and what governs how the SERVER is launched is not taken over.
  assertEquals(rows.has("LSEnvironment"), false);
  // Still one well-formed dict.
  assertEquals(out.match(/<\/plist>/g)?.length, 1);
  assert(out.trimEnd().endsWith("</dict>\n</plist>"), out.slice(-80));
  // Nothing to inherit → byte-identical.
  assertEquals(inheritWindowPlistKeys(own, "<plist/>"), own);
});

Deno.test({
  name:
    "mac window: the assembled bundle carries the link, the language stubs and the inherited plist",
  ignore: Deno.build.os === "windows", // a link needs a POSIX host
  fn: async () => {
    const dir = await tempDir("macapp-window-");
    try {
      const staged = join(dir, "staged");
      const el = join(staged, "electron", "Electron.app", "Contents");
      await Deno.mkdir(join(el, "MacOS"), { recursive: true });
      await Deno.mkdir(join(el, "Frameworks"), { recursive: true });
      // Kept by the default trim, with a file inside one; `xx` is trimmed.
      await Deno.mkdir(join(el, "Resources", "en.lproj"), { recursive: true });
      await Deno.mkdir(join(el, "Resources", "en_GB.lproj"));
      await Deno.mkdir(join(el, "Resources", "xx.lproj"));
      await Deno.writeTextFile(
        join(el, "Resources", "en.lproj", "InfoPlist.strings"),
        "s",
      );
      await Deno.writeTextFile(join(el, "Info.plist"), ELECTRON_PLIST);
      await Deno.writeTextFile(join(el, "MacOS", "Electron"), "el-bin");
      await Deno.writeTextFile(join(staged, "counter"), "server-bin");

      const app = await assembleMacApp({
        stagedDir: staged,
        outDir: join(dir, "out"),
        name: "Counter",
        binaryName: "counter",
        identifier: "app.aio.counter",
        version: "1.0.0",
        iconIcns: new Uint8Array([1, 2, 3]),
      });
      const macos = join(app, "Contents", "MacOS");

      // The link: a LINK (a copy would be a second, unsigned executable),
      // relative (the bundle is moved to /Applications), to the runtime.
      const link = join(macos, MAC_WINDOW_LINK);
      assertEquals((await Deno.lstat(link)).isSymlink, true);
      assertEquals(await Deno.readLink(link), MAC_WINDOW_LINK_TARGET);
      assertEquals(await Deno.readTextFile(link), "el-bin");
      // It is where the launcher looks first.
      assertEquals(
        packagedElectronCandidates(join(macos, "counter"), "darwin")[0],
        link,
      );

      // The language stubs the runtime kept are the bundle's too.
      const lproj = async (d: string) =>
        (await Array.fromAsync(Deno.readDir(d)))
          .filter((e) => e.name.endsWith(".lproj")).map((e) => e.name).sort();
      const nested = await lproj(
        join(macos, "electron", "Electron.app", "Contents", "Resources"),
      );
      assertEquals(nested, ["en.lproj", "en_GB.lproj"]);
      assertEquals(await lproj(join(app, "Contents", "Resources")), nested);
      assertEquals(
        await Deno.readTextFile(
          join(app, "Contents", "Resources", "en.lproj", "InfoPlist.strings"),
        ),
        "s",
      );

      // The plist the window is read by.
      const rows = new Map(
        plistTopLevelRows(
          await Deno.readTextFile(join(app, "Contents", "Info.plist")),
        ).map((r) => [r.key, r.value]),
      );
      assertEquals(rows.get("CFBundleExecutable"), "<string>counter</string>");
      // The runtime in this bundle needs macOS 13: the bundle says so too.
      assertEquals(rows.get("LSMinimumSystemVersion"), "<string>13.0</string>");
      assertEquals(rows.get("NSSupportsAutomaticGraphicsSwitching"), "<true/>");
      assert(rows.has("NSCameraUsageDescription"));
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test("mac bundle: its minimum macOS is the higher of aio's floor and the bundled runtime's", () => {
  // The bundle said a fixed 12.0 over a runtime whose own plist says 13.0: on
  // macOS 12 the system would start the server and the window could not open.
  const rt = (v: string) =>
    `<plist><dict>\n\t<key>LSMinimumSystemVersion</key>\n\t<string>${v}</string>\n</dict></plist>`;
  assertEquals(MAC_MINIMUM_SYSTEM_FLOOR, "12.0");
  assertEquals(macMinimumSystemVersion(ELECTRON_PLIST), "13.0");
  assertEquals(macMinimumSystemVersion(rt("13.0")), "13.0");
  assertEquals(macMinimumSystemVersion(rt("12.3.1")), "12.3.1");
  // Numeric, not text: 9 is below 12, 100 above; 12 equals 12.0.
  assertEquals(macMinimumSystemVersion(rt("9.0")), "12.0");
  assertEquals(macMinimumSystemVersion(rt("100.0")), "100.0");
  assertEquals(macMinimumSystemVersion(rt("12")), "12.0");
  assertEquals(macMinimumSystemVersion(rt("10.15")), "12.0");
  // A runtime that states none, or nothing readable, leaves the floor.
  assertEquals(macMinimumSystemVersion("<plist/>"), "12.0");
  assertEquals(macMinimumSystemVersion(rt("thirteen")), "12.0");
  // A raised floor wins over an older runtime.
  assertEquals(macMinimumSystemVersion(rt("13.0"), "14.2"), "14.2");
});

/** Run the template's generated text against stand-ins for Electron's
 *  objects — the emitted code, not a description of it. */
function runTray(win: Record<string, unknown>) {
  const handlers: Record<string, () => void> = {};
  const app = { on: (ev: string, fn: () => void) => handlers[ev] = fn };
  const ipcMain = { on: () => {} };
  const code = tmplTray(undefined, "null", "t");
  new Function("win", "app", "ipcMain", "require", "__aioQuitting", code)(
    win,
    app,
    ipcMain,
    () => {
      throw new Error("no module is needed without a tray or a show file");
    },
    false,
  );
  return handlers;
}

Deno.test("mac window: re-opening the running app ('activate') restores, shows and focuses its window", () => {
  const calls: string[] = [];
  const handlers = runTray({
    isDestroyed: () => false,
    isMinimized: () => true,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
  });
  assert(handlers.activate, "no 'activate' handler was registered");
  handlers.activate();
  assertEquals(calls, ["restore", "show", "focus"]);

  // A window that is already gone is left alone (no throw into Electron).
  const gone: string[] = [];
  runTray({
    isDestroyed: () => true,
    isMinimized: () => {
      gone.push("asked");
      return false;
    },
    show: () => gone.push("show"),
    focus: () => gone.push("focus"),
  }).activate!();
  assertEquals(gone, []);
});

Deno.test("mac window: both window shells carry the re-open handler, and still parse", () => {
  for (
    const script of [
      electronMainScript("http://127.0.0.1:1/", { title: "t" }),
      electronMainScriptUDS("http://127.0.0.1:1/", "/tmp/x.sock", {
        title: "t",
      }),
    ]
  ) {
    assert(script.includes("app.on('activate', __aioShowWin)"));
    new Function(script); // throws on a syntax error
  }
});

// ── A bundle unpacked WITHOUT its link, and a window that cannot start ───────
//
// Measured on macOS: a copy of the app whose `app_window` had been replaced by
// a 45-byte text file holding the target — what an archive tool that does not
// keep symbolic links writes. The resolver took it (it is a file), the spawn
// failed with PermissionDenied, and the app ran on with no window: a server
// nobody could see, holding the single-instance lock.

/** A bundle's Contents/MacOS in `dir`: the app binary's path and the nested
 *  runtime binary (a real, executable file). */
async function macosDir(dir: string) {
  const nested = join(dir, MAC_WINDOW_LINK_TARGET);
  await Deno.mkdir(join(nested, ".."), { recursive: true });
  await Deno.writeTextFile(nested, "#!/bin/sh\nexit 0\n");
  await Deno.chmod(nested, 0o755);
  return {
    exe: join(dir, "counter"),
    nested,
    link: join(dir, MAC_WINDOW_LINK),
  };
}

Deno.test({
  name:
    "mac window: the link is taken only when it can be started — flattened to a text file, the nested runtime is used and it is SAID once",
  ignore: Deno.build.os === "windows", // symlinks and execute bits
  fn: async () => {
    const dir = await tempDir("mac-link-state-");
    const had = Deno.env.get("ELECTRON_PATH");
    Deno.env.delete("ELECTRON_PATH");
    try {
      const { exe, nested, link } = await macosDir(dir);
      const find = async () => {
        const said: string[] = [];
        const bin = await findElectronBin(
          { info: (m) => said.push(m), error: (m) => said.push(m) },
          {
            compiled: true,
            execPath: exe,
            os: "darwin",
            fetchRuntime: () => {
              throw new Error("must not download — the bundle ships one");
            },
          },
        );
        return { bin, said };
      };
      // No link at all (a bundle from before it existed): nested, silently.
      assertEquals(await macWindowLinkState(link), "absent");
      assertEquals(await find(), { bin: nested, said: [] });
      // The link as built.
      await Deno.symlink(MAC_WINDOW_LINK_TARGET, link);
      assertEquals(await macWindowLinkState(link), "usable");
      assertEquals(await find(), { bin: link, said: [] });
      // Flattened: the target's path, as text, not executable.
      await Deno.remove(link);
      await Deno.writeTextFile(link, MAC_WINDOW_LINK_TARGET);
      await Deno.chmod(link, 0o644);
      assertEquals(await macWindowLinkState(link), "flattened");
      const flat = await find();
      assertEquals(flat.bin, nested, "the unusable link was still taken");
      assertEquals(flat.said.length, 1, flat.said.join(" | "));
      assert(flat.said[0]!.includes(link), flat.said[0]);
      assert(flat.said[0]!.includes("does not keep symbolic links"));
      assert(flat.said[0]!.includes("quitting it by its id"), flat.said[0]);
      // An executable file there (a copy that followed the link) starts.
      await Deno.chmod(link, 0o755);
      assertEquals(await macWindowLinkState(link), "usable");
      // A link whose target is gone: the runtime itself is missing.
      await Deno.remove(link);
      await Deno.symlink("electron/nowhere", link);
      assertEquals(await macWindowLinkState(link), "absent");
    } finally {
      if (had !== undefined) Deno.env.set("ELECTRON_PATH", had);
      await dropTempDir(dir);
    }
  },
});

Deno.test("no window: a PACKAGED desktop app stops, loudly; a source run keeps serving; --keep-server keeps the server", () => {
  assertEquals(windowlessStops(true, false), true);
  assertEquals(windowlessStops(true, true), false, "--keep-server asked");
  assertEquals(windowlessStops(false, false), false);
  const url = "http://127.0.0.1:1234";
  const e = new Error("PermissionDenied: os error 13");
  // Packaged: stop, with the reason, and no pointer to a URL nobody will see.
  const stop = electronLaunchFailurePlan(e, url, true);
  assertEquals(stop.stop, true);
  const text = stop.lines.join("\n");
  assert(text.includes("PermissionDenied"), text);
  assert(text.includes("stopping"), text);
  assert(!text.includes(url) && !text.includes("--client=browser"), text);
  // From source: unchanged.
  const keep = electronLaunchFailurePlan(e, url);
  assertEquals(keep.stop, false);
  assert(keep.lines.join("\n").includes(url));
  // The runtime could not be found at all: the same rule, the same last line.
  const missing = electronMissingLines(`${url}/?token=SECRET`, true);
  assertEquals(missing.at(-1), stop.lines.at(-1));
  assert(!missing.join("\n").includes("SECRET"));
  assert(!missing.join("\n").includes("server is up"), missing.join(" | "));
  assert(
    electronMissingLines(url).join("\n").includes("server is up meanwhile"),
  );
});

Deno.test("no window: the lifecycle asks the rule on BOTH paths a window can fail to start", async () => {
  // A decider nobody calls protects nothing.
  const src = await Deno.readTextFile(
    new URL("../src/server/aio-lifecycle.ts", import.meta.url),
  );
  assertEquals(
    src.split("windowlessStops(isCompiled(), !!keepServer)").length - 1,
    2,
  );
  const missing = src.indexOf("electronMissingLines(electronUrl, windowless)");
  assert(missing > 0, "the missing-runtime path no longer passes the rule");
  assert(
    src.slice(missing, missing + 200).includes(
      "if (windowless) stopProcess(1)",
    ),
    "…and must act on it",
  );
  assert(src.includes("electronLaunchFailurePlan(e, url, windowless)"));
});

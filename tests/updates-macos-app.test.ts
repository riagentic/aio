// A macOS `.app` can never install an update over itself — and until now it
// thought it could.
//
// Measured against this exact code before the fix, on Linux, by running the
// decision rather than reading it:
//
//   classifyTarget({ execPath: "/Applications/Counter.app/Contents/MacOS/
//                    Counter" })            → "binary"
//   installableTargets("binary")            → ["binary"]
//
// So a released plain binary was ACCEPTED by a macOS bundle, and the `binary`
// strategy renames the downloaded file over `Contents/MacOS/<exe>`. Every
// file inside a `.app` is covered by the bundle's code signature, so what that
// produces is an application macOS refuses to launch — created by the update
// mechanism, on the user's machine, with no way back but a fresh download.
//
// There is no in-place strategy for a signed bundle (the remaining work is in
// todo.md under "macOS .app self-update"). What there is instead is an honest
// refusal that names the remedy, which is the same answer Android already
// gets: a target of its own, installing nothing, and a blocker that carries
// the download link and the sentence about where the data lives.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  classifyTarget,
  installableTargets,
  isMacAppBundle,
} from "../src/server/updates-apply.ts";
import {
  decide,
  type LocalData,
  resolveUpdates,
} from "../src/server/updates-core.ts";
import { createUpdatesRuntime } from "../src/server/updates-runtime.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import type { ShipManifest } from "../src/build/ship.ts";

const MAC_EXEC = "/Applications/Counter.app/Contents/MacOS/Counter";

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
} as unknown as Parameters<typeof createUpdatesRuntime>[0]["log"];

/** A clean install: nothing persisted, so the data-compatibility check is
 *  never what decides any of these cases. */
const LOCAL: LocalData = { cells: {}, schema: 0 };

Deno.test("a macOS .app is its own target, never `binary`", () => {
  assertEquals(
    classifyTarget({
      execPath: MAC_EXEC,
      appImage: null,
      electronPath: null,
      installDir: null,
    }),
    "macos-app",
  );
  // The path shape IS the fact, so the rule holds on any host.
  assert(isMacAppBundle(MAC_EXEC));
  assert(isMacAppBundle("/Users/x/Desktop/My App.app/Contents/MacOS/My App"));
  // Neighbours that must NOT be mistaken for one.
  assert(!isMacAppBundle("/usr/local/bin/counter"));
  assert(!isMacAppBundle("/Applications/Counter.app/Contents/Resources/x"));
  assert(!isMacAppBundle("/home/u/Counter.appimage"));
});

Deno.test("a .app can install nothing — not even a macos-app release", () => {
  // The whole point: there is no strategy that replaces a signed bundle from
  // inside it, so the list is empty rather than "itself".
  assertEquals(installableTargets("macos-app"), []);
  // …and every other target keeps exactly what it had.
  assertEquals(installableTargets("binary"), ["binary"]);
  assertEquals(installableTargets("electron-zip"), ["electron-zip"]);
  assertEquals(installableTargets("appimage"), [
    "appimage",
    "electron-appimage",
  ]);
});

function manifest(over: Partial<ShipManifest> = {}): ShipManifest {
  return {
    name: "counter",
    version: "2.0.0",
    channel: "stable",
    target: "binary",
    file: "counter",
    ...over,
  } as ShipManifest;
}

Deno.test("the refusal a .app gets names the remedy, not just the refusal", () => {
  const d = decide({
    current: "1.0.0",
    manifest: manifest(),
    local: LOCAL,
    canInstall: installableTargets("macos-app"),
    installedTarget: "macos-app",
    artifactUrl: "https://example.com/rel/stable/Counter.dmg",
  });
  // `incompatible`, not `refused`: the user is TOLD a newer version exists.
  // "refused" reads to a user as "nothing here".
  assertEquals(d.kind, "incompatible");
  assert(d.kind === "incompatible");
  assertEquals(d.version, "2.0.0");
  const text = d.blockers.join(" ");
  assertStringIncludes(text, "code signature");
  assertStringIncludes(text, "https://example.com/rel/stable/Counter.dmg");
  assertStringIncludes(text, "/Applications");
  // The question every user asks next.
  assertStringIncludes(text, "data is kept");
});

Deno.test("without the fix a .app would have taken a binary release", () => {
  // The mutation this file exists to catch, stated as the property: whatever
  // a release declares, a bundle never ends up with something to apply.
  // (`"macos-app"` is not in the list because no manifest can carry it — see
  // UPDATE_TARGETS.)
  for (
    const target of [
      "binary",
      "appimage",
      "electron-appimage",
      "electron-zip",
    ] as const
  ) {
    const d = decide({
      current: "1.0.0",
      manifest: manifest({ target }),
      local: LOCAL,
      canInstall: installableTargets("macos-app"),
      installedTarget: "macos-app",
      source: "https://example.com/rel",
    });
    assert(
      d.kind !== "offer",
      `a macOS bundle was offered a "${target}" release to install`,
    );
  }
});

Deno.test("nothing else changed: a real binary install still offers", () => {
  const d = decide({
    current: "1.0.0",
    manifest: manifest(),
    local: LOCAL,
    canInstall: installableTargets("binary"),
    installedTarget: "binary",
  });
  assertEquals(d.kind, "offer");
});

Deno.test("the other door: `apply` on a bundle throws rather than swapping", async () => {
  // `decide` never offers, so the button is never there. This is the path
  // `updates.auto` and a direct `apply()` take — the last thing between an
  // unattended update and a bundle macOS will not open.
  const dataDir = await tempDir("aio-macos-apply-");
  try {
    const rt = createUpdatesRuntime({
      config: resolveUpdates({
        source: "https://example.invalid/rel",
        channel: "prod",
        allowUnsigned: true,
      }),
      dataDir,
      appVersion: "1.0.0",
      local: { schema: 1, cells: {} },
      exposed: false,
      log: silentLog,
      argv: [],
      // canInstall is deliberately NOT injected: injecting it is how a test
      // drives a real swap, and this guard must not stand in the way of that.
      installedTarget: "macos-app",
      exit: () => {},
      relaunch: () => {},
      shutdown: () => Promise.resolve(),
    });
    const e = await rt.apply().then(() => null, (err: unknown) => err);
    assert(e instanceof Error, "apply must refuse, not proceed");
    assertStringIncludes(e.message, "macOS .app");
    assertStringIncludes(e.message, "/Applications");
    assertStringIncludes(e.message, "signed bundle");
  } finally {
    await dropTempDir(dataDir);
  }
});

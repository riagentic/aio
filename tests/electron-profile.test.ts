// The window's Chromium profile lives in the app's own home
// (`~/.<appId>/electron/`), and one at Electron's old per-OS place moves
// there once, losing nothing (src/electron/electron-profile.ts).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  appProfileDir,
  moveOldProfile,
} from "../src/electron/electron-profile.ts";
import { electronMainScript } from "../src/electron/electron-scripts.ts";
import { electronMainScriptUDS } from "../src/electron/electron-uds.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("profile: in the app's home, beside data/ and logs/", () => {
  assertEquals(appProfileDir("/h/.notes"), join("/h/.notes", "electron"));
});

Deno.test("profile move: the old profile moves whole, once; nothing there is a no-op", async () => {
  const tmp = await tempDir("profile-move-");
  try {
    const old = join(tmp, "config", "notes");
    const dir = join(tmp, ".notes", "electron");
    await Deno.mkdir(join(old, "Local Storage"), { recursive: true });
    await Deno.writeTextFile(join(old, "Local Storage", "k"), "signed-in");
    await Deno.writeTextFile(join(old, "window-state.json"), '{"w":900}');
    assertEquals(await moveOldProfile(old, dir), { kind: "moved", from: old });
    assertEquals(
      await Deno.readTextFile(join(dir, "Local Storage", "k")),
      "signed-in",
    );
    assertEquals(
      await Deno.readTextFile(join(dir, "window-state.json")),
      '{"w":900}',
    );
    assert(!(await Deno.stat(old).then(() => true, () => false)));
    // The next start: nothing left to move.
    assertEquals(await moveOldProfile(old, dir), { kind: "none" });
    assertEquals(await moveOldProfile(null, dir), { kind: "none" });
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("profile move: in both places, the home's wins and the old one is left as it was", async () => {
  const tmp = await tempDir("profile-both-");
  try {
    const old = join(tmp, "config", "notes");
    const dir = join(tmp, ".notes", "electron");
    await Deno.mkdir(old, { recursive: true });
    await Deno.writeTextFile(join(old, "a"), "old");
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(join(dir, "a"), "new");
    assertEquals(await moveOldProfile(old, dir), {
      kind: "kept-both",
      from: old,
    });
    assertEquals(await Deno.readTextFile(join(old, "a")), "old");
    assertEquals(await Deno.readTextFile(join(dir, "a")), "new");
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("profile move: a move that fails (another volume) leaves the old profile where it was", async () => {
  const tmp = await tempDir("profile-fail-");
  try {
    const old = join(tmp, "config", "notes");
    const dir = join(tmp, ".notes", "electron");
    await Deno.mkdir(old, { recursive: true });
    await Deno.writeTextFile(join(old, "a"), "kept");
    const r = await moveOldProfile(old, dir, {
      rename: () => Promise.reject(new Error("EXDEV: cross-device link")),
    });
    assertEquals(r.kind, "failed");
    assertStringIncludes((r as { why: string }).why, "EXDEV");
    assertEquals(await Deno.readTextFile(join(old, "a")), "kept");
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("window scripts: the profile is pointed at the app's home right after app.name, before anything reads it", () => {
  const dir = "/h/.notes/electron";
  const meta = { title: "Notes", profileName: "notes", profileDir: dir };
  for (
    const script of [
      electronMainScript("http://127.0.0.1:1/", meta),
      electronMainScriptUDS("http://localhost/", "/tmp/s.sock", { meta }),
    ]
  ) {
    const set = script.indexOf(
      `app.setPath('userData', ${JSON.stringify(dir)})`,
    );
    const name = script.indexOf(`app.name = "notes"`);
    assert(set > name && name >= 0, "setPath follows app.name");
    const firstRead = script.indexOf("getPath('userData')");
    assert(firstRead === -1 || firstRead > set, "nothing reads it before");
    // Top-level and synchronous: it runs before Electron emits "ready",
    // whatever registered a ready handler above it.
  }
  // No home: Electron's own default, as before.
  assert(
    !electronMainScript("http://127.0.0.1:1/", { title: "Notes" }).includes(
      "setPath('userData'",
    ),
  );
});

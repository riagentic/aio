// The window's Chromium profile lives in the app's own home
// (`~/.<appId>/electron/`), and one at Electron's old per-OS place moves
// there once, losing nothing (src/electron/electron-profile.ts).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  appProfileDir,
  moveOldProfile,
  moveProfileBack,
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

/** A profile at `old` and one at `dir`, each's content written at `t` (s). */
async function bothProfiles(tmp: string, oldAt: number, homeAt: number) {
  const old = join(tmp, "config", "notes");
  const dir = join(tmp, ".notes", "electron");
  for (
    const [p, text, t] of [[old, "old", oldAt], [dir, "home", homeAt]] as const
  ) {
    await Deno.mkdir(join(p, "Local Storage"), { recursive: true });
    await Deno.writeTextFile(join(p, "Local Storage", "a"), text);
    for (
      const f of [join(p, "Local Storage", "a"), join(p, "Local Storage"), p]
    ) {
      await Deno.utime(f, t, t);
    }
  }
  return { old, dir };
}

const NOW = new Date("2026-10-19T12:00:00Z");

Deno.test("profile move: in both places, the one written last is kept and the other goes into the home as electron.previous-<date> — never deleted", async () => {
  const tmp = await tempDir("profile-both-");
  try {
    // The home's is newer: the old place's is set aside.
    let { old, dir } = await bothProfiles(join(tmp, "a"), 1_000, 2_000);
    let backup = join(tmp, "a", ".notes", "electron.previous-2026-10-19");
    assertEquals(await moveOldProfile(old, dir, { now: NOW }), {
      kind: "both",
      from: old,
      kept: "home",
      backup,
    });
    assertEquals(
      await Deno.readTextFile(join(dir, "Local Storage", "a")),
      "home",
    );
    assertEquals(
      await Deno.readTextFile(join(backup, "Local Storage", "a")),
      "old",
    );
    assert(!(await Deno.stat(old).then(() => true, () => false)));
    // The old place's is newer (a rolled-back build used it since): IT is
    // the profile now, and the home's is set aside.
    ({ old, dir } = await bothProfiles(join(tmp, "b"), 3_000, 2_000));
    backup = join(tmp, "b", ".notes", "electron.previous-2026-10-19");
    assertEquals(await moveOldProfile(old, dir, { now: NOW }), {
      kind: "both",
      from: old,
      kept: "old",
      backup,
    });
    assertEquals(
      await Deno.readTextFile(join(dir, "Local Storage", "a")),
      "old",
    );
    assertEquals(
      await Deno.readTextFile(join(backup, "Local Storage", "a")),
      "home",
    );
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("profile move: in both places, a set-aside that fails keeps both as they were and starts from the home's", async () => {
  const tmp = await tempDir("profile-both-fail-");
  try {
    const { old, dir } = await bothProfiles(tmp, 3_000, 2_000);
    let calls = 0;
    const r = await moveOldProfile(old, dir, {
      now: NOW,
      // The home's moves aside, the old one cannot move in: put back.
      rename: (a, b) =>
        ++calls === 2 ? Promise.reject(new Error("EBUSY")) : Deno.rename(a, b),
    });
    assertEquals(r.kind, "kept-both");
    assertEquals(
      await Deno.readTextFile(join(dir, "Local Storage", "a")),
      "home",
    );
    assertEquals(
      await Deno.readTextFile(join(old, "Local Storage", "a")),
      "old",
    );
  } finally {
    await dropTempDir(tmp);
  }
});

Deno.test("profile move back: a rollback puts the moved profile at its old place; never over one there", async () => {
  const tmp = await tempDir("profile-back-");
  try {
    const from = join(tmp, "config", "notes");
    const to = join(tmp, ".notes", "electron");
    await Deno.mkdir(to, { recursive: true });
    await Deno.writeTextFile(join(to, "a"), "signed-in");
    assertEquals(await moveProfileBack({ from, to }), "moved");
    assertEquals(await Deno.readTextFile(join(from, "a")), "signed-in");
    assertEquals(await moveProfileBack({ from, to }), "none");
    await Deno.mkdir(to);
    assertStringIncludes(await moveProfileBack({ from, to }), "in use");
    assertEquals(await Deno.readTextFile(join(from, "a")), "signed-in");
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

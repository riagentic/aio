// updates-old-layout.test.ts — where an update puts files: the new version
// under its own name, the replaced one in `old/<version>/<its name>`, keepOld.
//
// A file downloaded as `app-1.0.0-x86_64.AppImage` used to be written over in
// place, its predecessors kept beside it as `<install>.old-<version>` (three of
// them): a file NAMED 1.0.0 that was 2.0.0 (a field report). The end-to-end
// path is in tests/updates-e2e.test.ts; this pins the rules and each step a
// crash or a refusal can stop at.
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import {
  _lsDeps,
  installName,
  launchServices,
  MAX_BOOT_ATTEMPTS,
  migrateLegacyOld,
  oldCopyName,
  oldCopyPath,
  pruneOld,
  readPending,
  restoreArtifact,
  swapArtifact,
  writePending,
} from "../src/server/updates-apply.ts";
import {
  _confirm,
  confirmPendingUpdate,
  judgePendingUpdate,
} from "../src/server/updates-boot.ts";
import {
  DEFAULT_KEEP_OLD,
  resolveKeepOld,
  resolveUpdates,
} from "../src/server/updates-core.ts";
import { VALID_UPDATES_KEYS } from "../src/server/config.ts";
import { rewriteMenuEntry } from "../src/server/app-dirs.ts";
import {
  identity,
  isOwn,
  made,
  readOwned,
  record,
  sumOf,
} from "../src/server/updates-owned.ts";
import {
  moveSharedUses,
  readSharedUses,
} from "../src/electron/shared-runtime.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import type { Log } from "../src/diagnostics/logger-api.ts";

const quiet = (): Log & { lines: string[] } => {
  const lines: string[] = [];
  const push = (level: string) => (...a: unknown[]) =>
    void lines.push(`${level} ${a.map(String).join(" ")}`);
  return {
    lines,
    info: push("info"),
    warn: push("warn"),
    error: push("error"),
    debug: push("debug"),
  } as unknown as Log & { lines: string[] };
};
const names = (dir: string) =>
  [...Deno.readDirSync(dir)].map((e) => e.name).sort();

// ── the naming rule ───────────────────────────────────────────────────────

Deno.test("name: a file named with the running version is installed under the new release's own name", () => {
  assertEquals(
    installName("myapp-0.1.740-x86_64.AppImage", "0.1.740", "0.1.745"),
    "myapp-0.1.745-x86_64.AppImage",
  );
  assertEquals(installName("myapp-1.2.3", "1.2.3", "1.3.0"), "myapp-1.3.0");
  assertEquals(
    installName("notes-1.2.3-beta-windows-x64.exe", "1.2.3-beta", "1.2.4"),
    "notes-1.2.4-windows-x64.exe",
  );
});

Deno.test("name: a name the user gave it (no version in it) stays — and a version that is only a prefix of one in the name is not it", () => {
  assertEquals(
    installName("My App.AppImage", "1.0.0", "2.0.0"),
    "My App.AppImage",
  );
  assertEquals(installName("myapp", "1.0.0", "2.0.0"), "myapp");
  // 0.1.74 is not 0.1.740; 1.0.0 is not inside 11.0.0's name either.
  assertEquals(
    installName("myapp-0.1.740-x86_64.AppImage", "0.1.74", "0.1.75"),
    "myapp-0.1.740-x86_64.AppImage",
  );
  assertEquals(installName("myapp-11.0.0", "1.0.0", "2.0.0"), "myapp-11.0.0");
});

Deno.test("name: the old copy is old/<version>/<its name> beside the install — the same for a bundle and a folder, which carry no version", () => {
  assertEquals(
    oldCopyPath("/apps/myapp-1.0.0-x86_64.AppImage", "1.0.0"),
    join("/apps", "old", "1.0.0", "myapp-1.0.0-x86_64.AppImage"),
  );
  assertEquals(
    oldCopyPath("/apps/MyApp", "1.0.0", undefined, "windows"),
    join("/apps", "old", "1.0.0", "MyApp"),
  );
  // Never the copy a rollback is putting back (a rebuild of one version).
  const back = oldCopyPath("/apps/MyApp", "2.0.0");
  assertEquals(
    oldCopyPath("/apps/MyApp", "2.0.0", back),
    join("/apps", "old", "2.0.0-failed", "MyApp"),
  );
});

Deno.test("name: on macOS a bundle in old/ is `<X>.app.noindex` — no bundle name, skipped by Spotlight — and only there", () => {
  assertEquals(
    oldCopyName("/Applications/My App.app", "darwin"),
    "My App.app.noindex",
  );
  assertEquals(
    oldCopyPath("/Applications/My App.app", "1.0.0", undefined, "darwin"),
    join("/Applications", "old", "1.0.0", "My App.app.noindex"),
  );
  assertEquals(oldCopyName("/opt/My App.app", "linux"), "My App.app");
  assertEquals(oldCopyName("C:/Apps/MyApp", "windows"), "MyApp");
  assertEquals(oldCopyName("/Applications/notes", "darwin"), "notes");
  // The failed-build name of a rebuild keeps the rule.
  const back = oldCopyPath("/A/X.app", "2.0.0", undefined, "darwin");
  assertEquals(
    oldCopyPath("/A/X.app", "2.0.0", back, "darwin"),
    join("/A", "old", "2.0.0-failed", "X.app.noindex"),
  );
});

Deno.test({
  name:
    "rollback (macOS): the bundle kept as old/<v>/<X>.app.noindex goes back to <X>.app at the install path — and the build that failed goes in as <X>.app.noindex",
  ignore: Deno.build.os !== "darwin" && Deno.build.os !== "linux", // a folder rename; the name rule is pure and asserted above for every OS
  fn: async () => {
    const root = await tempDir("aio-oldlayout-mac-");
    try {
      const data = join(root, "data");
      await Deno.mkdir(data);
      const app = join(root, "Counter.app");
      const kept = oldCopyPath(app, "1.0.0", undefined, "darwin");
      await Deno.mkdir(join(app, "Contents"), { recursive: true });
      await Deno.writeTextFile(join(app, "Contents", "V"), "2.0.0");
      await Deno.mkdir(join(kept, "Contents"), { recursive: true });
      await Deno.writeTextFile(join(kept, "Contents", "V"), "1.0.0");
      const failedTo = oldCopyPath(app, "2.0.0", kept, "darwin");
      assertEquals(await restoreArtifact(app, kept, data, { failedTo }), {
        at: app,
      });
      assertEquals(
        await Deno.readTextFile(join(app, "Contents", "V")),
        "1.0.0",
      );
      assertEquals(
        await Deno.readTextFile(join(failedTo, "Contents", "V")),
        "2.0.0",
      );
      assertEquals(names(join(root, "old")), ["2.0.0"]);
      assertEquals(names(join(root, "old", "2.0.0")), ["Counter.app.noindex"]);
    } finally {
      await dropTempDir(root);
    }
  },
});

// ── LaunchServices ────────────────────────────────────────────────────────

/** Run `fn` as if on macOS, with every lsregister and mdimport call written
 *  down instead of made (through the seam: no test registers or indexes
 *  anything on the machine). */
async function onMac(
  fn: (calls: string[]) => Promise<void>,
  fail?: (args: string[]) => boolean,
  code = "",
): Promise<void> {
  const real = { ..._lsDeps };
  const calls: string[] = [];
  _lsDeps.os = () => "darwin";
  _lsDeps.run = (args) => {
    calls.push(args.join(" "));
    if (fail?.(args)) throw new Error(`failed to scan ${args[1]}: ${code}`);
  };
  _lsDeps.index = (path) => {
    calls.push(`mdimport ${path}`);
    if (fail?.(["mdimport", path])) throw new Error("mdimport: no");
  };
  try {
    await fn(calls);
  } finally {
    Object.assign(_lsDeps, real);
  }
}

Deno.test("launchServices: -u forgets a bundle set aside AND every bundle inside it; -f registers only the one put back; off macOS, or for no bundle, nothing; a failure is said, never thrown — and one with no record (-10814) is no failure of -u", async () => {
  const root = await tempDir("aio-oldlayout-ls-");
  try {
    const kept = join(root, "old", "1.0.0", "X.app.noindex");
    const inner = join(kept, "Contents", "Frameworks", "Electron.app");
    await Deno.mkdir(join(inner, "Contents"), { recursive: true });
    await onMac(async (calls) => {
      assertEquals(launchServices("-u", kept), []);
      // ...and Spotlight drops what it indexed inside the copy.
      assertEquals(calls, [`-u ${inner}`, `-u ${kept}`, `mdimport ${kept}`]);
      calls.length = 0;
      assertEquals(launchServices("-f", join(root, "X.app")), []);
      assertEquals(calls, [`-f ${join(root, "X.app")}`]);
      calls.length = 0;
      assertEquals(launchServices("-u", join(root, "app-1.0.0.AppImage")), []);
      assertEquals(calls, []);
    });
    await onMac(async (calls) => {
      const said = launchServices("-u", kept);
      assertEquals(calls.length, 3, "one failure does not stop the rest");
      assertEquals(said.length, 1);
      assertStringIncludes(said[0]!, `could not unregister ${inner}`);
      assertStringIncludes(said[0]!, "may still open this old copy");
    }, (args) => args[1] === inner);
    await onMac(async () => {
      const said = launchServices("-u", kept);
      assertEquals(said.length, 1);
      assertStringIncludes(said[0]!, `could not drop ${kept} from Spotlight`);
    }, (args) => args[0] === "mdimport");
    // -10814: LaunchServices has no record of it (a helper never launched,
    // a copy the swap helper forgot already) — for -u, nothing to say.
    await onMac(
      async (calls) => {
        assertEquals(launchServices("-u", kept), []);
        assertEquals(calls.length, 3);
        assertEquals(launchServices("-f", join(root, "X.app")).length, 1);
      },
      (args) => args[0] !== "mdimport",
      "-10814",
    );
    const calls: string[] = [];
    const real = _lsDeps.run;
    _lsDeps.run = (args) => void calls.push(args.join(" "));
    try {
      _lsDeps.os = () => "linux";
      assertEquals(launchServices("-u", kept), []);
      assertEquals(calls, []);
    } finally {
      _lsDeps.run = real;
      _lsDeps.os = () => Deno.build.os;
    }
  } finally {
    await dropTempDir(root);
  }
});

Deno.test({
  name:
    "rollback (macOS): the build that failed, set aside into old/, is forgotten by LaunchServices — with the Electron.app inside it — and the version put back is registered at the install's path",
  ignore: Deno.build.os === "windows", // a Windows folder rollback goes through the swap helper
  fn: async () => {
    const root = await tempDir("aio-oldlayout-lsjudge-");
    try {
      const data = join(root, "data");
      await Deno.mkdir(data);
      const app = join(root, "Counter.app");
      const previous = oldCopyPath(app, "1.0.0");
      const inner = join("Contents", "Frameworks", "Electron.app");
      await Deno.mkdir(join(app, inner), { recursive: true });
      await Deno.writeTextFile(join(app, "Contents", "V"), "2.0.0");
      await Deno.mkdir(join(previous, inner), { recursive: true });
      await Deno.writeTextFile(join(previous, "Contents", "V"), "1.0.0");
      writePending(data, {
        from: "1.0.0",
        to: "2.0.0",
        artifact: app,
        previous,
        attempts: MAX_BOOT_ATTEMPTS,
        startedAt: "2026-10-19T00:00:00.000Z",
      });
      await onMac(async (calls) => {
        assertEquals(await judgePendingUpdate(data, quiet(), "2.0.0"), true);
        const failedTo = oldCopyPath(app, "2.0.0", previous);
        assertEquals(
          await Deno.readTextFile(join(app, "Contents", "V")),
          "1.0.0",
        );
        assertEquals(calls, [
          `-u ${join(failedTo, inner)}`,
          `-u ${failedTo}`,
          `mdimport ${failedTo}`,
          `-f ${app}`,
        ]);
      });
    } finally {
      await dropTempDir(root);
    }
  },
});

// ── keepOld ───────────────────────────────────────────────────────────────

Deno.test("keepOld: one by default — the rollback — and an integer >= 1 when an app wants more; anything else refuses to boot", () => {
  assertEquals(DEFAULT_KEEP_OLD, 1);
  assertEquals(resolveKeepOld(undefined), 1);
  assertEquals(resolveKeepOld("https://example.invalid/r"), 1);
  assertEquals(resolveKeepOld({ source: "x" }), 1);
  assertEquals(resolveKeepOld({ source: "x", keepOld: 3 }), 3);
  for (const bad of [0, -1, 1.5, NaN, "2", null]) {
    assertThrows(
      () => resolveKeepOld({ source: "x", keepOld: bad as unknown as number }),
      Error,
      "[updates] keepOld:",
    );
  }
  assertEquals(
    resolveUpdates({ source: "https://example.invalid/r", keepOld: 2 }).keepOld,
    2,
  );
  assert(VALID_UPDATES_KEYS.has("keepOld"), "keepOld is a known updates key");
});

// ── the menu entry ────────────────────────────────────────────────────────

Deno.test("menu entry: Exec= and TryExec= that name the old path follow it — a longer path that starts with it does not, and nothing else changes", () => {
  const from = "/home/u/Apps/app-1.0.0-x86_64.AppImage";
  const to = "/home/u/Apps/app-2.0.0-x86_64.AppImage";
  const text = [
    "[Desktop Entry]",
    `Name=${from}`,
    `Exec=sh -c 'D="$HOME/.cache/app"; TMPDIR="$D" exec "${from}" "$@"' _ %U`,
    `TryExec=${from}`,
    `Icon=${from}.png`,
    "",
  ].join("\n");
  assertEquals(
    rewriteMenuEntry(text, from, to),
    [
      "[Desktop Entry]",
      `Name=${from}`,
      `Exec=sh -c 'D="$HOME/.cache/app"; TMPDIR="$D" exec "${to}" "$@"' _ %U`,
      `TryExec=${to}`,
      `Icon=${from}.png`,
      "",
    ].join("\n"),
  );
  assertEquals(rewriteMenuEntry(`Exec=${from}2 %U\n`, from, to), null);
  assertEquals(rewriteMenuEntry(`Exec=/other/app %U\n`, from, to), null);
});

// ── the swap, step by step ────────────────────────────────────────────────

async function installedV1(): Promise<
  { root: string; data: string; v1: string; v2: string; staged: string }
> {
  const root = await tempDir("aio-oldlayout-");
  const data = join(root, "data");
  await Deno.mkdir(data);
  const v1 = join(root, "app-1.0.0-x86_64.AppImage");
  const v2 = join(root, "app-2.0.0-x86_64.AppImage");
  const staged = `${v1}.new-2.0.0`;
  await Deno.writeTextFile(v1, "the 1.0.0 build");
  record(data, staged, "file");
  await Deno.writeTextFile(staged, "the 2.0.0 build");
  made(data, staged);
  return { root, data, v1, v2, staged };
}
const swapTo = (s: Awaited<ReturnType<typeof installedV1>>) =>
  swapArtifact({
    current: s.v1,
    staged: s.staged,
    next: s.v2,
    fromVersion: "1.0.0",
    toVersion: "2.0.0",
    smoke: false,
    pending: { dataDir: s.data, from: "1.0.0", to: "2.0.0" },
  });

Deno.test("swap: under its own name the old file is MOVED, not copied — the kept copy is that very file, and the new one is kept on the record as the install, never a leftover", async () => {
  const s = await installedV1();
  try {
    const was = identity(s.v1)!;
    const r = await swapTo(s);
    assertEquals(r.installed, s.v2);
    assertEquals(r.previous, oldCopyPath(s.v1, "1.0.0"));
    assertEquals(identity(r.previous), was);
    assertEquals(names(s.root), ["app-2.0.0-x86_64.AppImage", "data", "old"]);
    const roles = Object.fromEntries(
      readOwned(s.data).map((e) => [e.path, e.role]),
    );
    assertEquals(roles, { [r.previous]: "kept", [s.v2]: "kept" });
  } finally {
    await dropTempDir(s.root);
  }
});

Deno.test("swap: a step that fails puts back what moved — the old version at its name, the new one where it was downloaded (on the record, for the next try), no marker, no empty old/", async () => {
  const s = await installedV1();
  try {
    // `old` is a file of the user's: the version folder cannot be made.
    await Deno.writeTextFile(join(s.root, "old"), "mine");
    await assertRejects(() => swapTo(s));
    assertEquals(await Deno.readTextFile(s.v1), "the 1.0.0 build");
    assertEquals(await Deno.readTextFile(s.staged), "the 2.0.0 build");
    assert(isOwn(s.data, s.staged));
    assertEquals(readPending(s.data), null);
    assertEquals(await Deno.readTextFile(join(s.root, "old")), "mine");
    assertEquals(names(s.root), [
      "app-1.0.0-x86_64.AppImage",
      "app-1.0.0-x86_64.AppImage.new-2.0.0",
      "data",
      "old",
    ]);
  } finally {
    await dropTempDir(s.root);
  }
});

Deno.test("swap: a file of the user's under the new release's name refuses the update before anything moves", async () => {
  const s = await installedV1();
  try {
    await Deno.writeTextFile(s.v2, "downloaded by hand");
    await assertRejects(() => swapTo(s), Error, "is in the way of the update");
    assertEquals(await Deno.readTextFile(s.v1), "the 1.0.0 build");
    assertEquals(await Deno.readTextFile(s.v2), "downloaded by hand");
    assertEquals(readPending(s.data), null);
  } finally {
    await dropTempDir(s.root);
  }
});

Deno.test("swap: in place (a name with no version), the Windows order — the running file renamed into old/, the new one into its name", async () => {
  const root = await tempDir("aio-oldlayout-win-");
  try {
    const data = join(root, "data");
    await Deno.mkdir(data);
    const current = join(root, "My App.exe"), staged = `${current}.new-2.0.0`;
    await Deno.writeTextFile(current, "the 1.0.0 build");
    await Deno.writeTextFile(staged, "the 2.0.0 build");
    const was = identity(current)!;
    const r = await swapArtifact({
      current,
      staged,
      fromVersion: "1.0.0",
      toVersion: "2.0.0",
      smoke: false,
      strategy: "rename-self-aside",
      pending: { dataDir: data, from: "1.0.0", to: "2.0.0" },
    });
    assertEquals(r, {
      previous: join(root, "old", "1.0.0", "My App.exe"),
      installed: current,
      notes: [],
    });
    assertEquals(identity(r.previous), was);
    assertEquals(await Deno.readTextFile(current), "the 2.0.0 build");
    assertEquals(readPending(data)?.restoreTo, undefined);
  } finally {
    await dropTempDir(root);
  }
});

// ── what a crash or a reboot finds ────────────────────────────────────────

/** A marker as the swap writes it for `v1` → `v2`, with the files as a cut-off
 *  swap left them. */
function markRenamed(
  s: Awaited<ReturnType<typeof installedV1>>,
  o: { attempts?: number; fromExe?: string } = {},
): void {
  writePending(s.data, {
    from: "1.0.0",
    to: "2.0.0",
    artifact: s.v2,
    restoreTo: s.v1,
    previous: oldCopyPath(s.v1, "1.0.0"),
    attempts: o.attempts ?? 0,
    startedAt: "2026-10-19T00:00:00.000Z",
    ...(o.fromExe ? { fromExe: o.fromExe } : {}),
  });
}

Deno.test("crash: cut off after the new file went in, the OLD one starts (its name still holds it) — the update is recorded as failed and the new file it left goes", async () => {
  const s = await installedV1();
  try {
    // As the swap leaves it right after its first move.
    record(s.data, oldCopyPath(s.v1, "1.0.0"), "file", {
      role: "kept",
      is: identity(s.v1),
      sum: sumOf(s.v1),
    });
    record(s.data, s.v2, "file", { role: "kept" });
    await Deno.rename(s.staged, s.v2);
    made(s.data, s.v2);
    const exe = "1:1:1:1";
    markRenamed(s, { fromExe: exe });
    const log = quiet();
    assertEquals(
      await judgePendingUpdate(s.data, log, "1.0.0", { exe }),
      false,
    );
    assertEquals(names(s.root), ["app-1.0.0-x86_64.AppImage", "data"]);
    assertEquals(readPending(s.data), null);
    assertStringIncludes(log.lines.join("\n"), "did not take effect");
  } finally {
    await dropTempDir(s.root);
  }
});

Deno.test("crash: cut off before the old file moved, the NEW one starts and is confirmed — the confirm moves the old one into old/ and says ONE line about hand-made shortcuts", async () => {
  const s = await installedV1();
  try {
    record(s.data, oldCopyPath(s.v1, "1.0.0"), "file", {
      role: "kept",
      is: identity(s.v1),
      sum: sumOf(s.v1),
    });
    await Deno.rename(s.staged, s.v2);
    markRenamed(s);
    const log = quiet();
    confirmPendingUpdate(s.data, log);
    await _confirm.pruned;
    assertEquals(names(s.root), ["app-2.0.0-x86_64.AppImage", "data", "old"]);
    assertEquals(
      await Deno.readTextFile(oldCopyPath(s.v1, "1.0.0")),
      "the 1.0.0 build",
    );
    assertEquals(
      log.lines.filter((l) => l.includes("made by hand")).length,
      1,
    );
  } finally {
    await dropTempDir(s.root);
  }
});

Deno.test("rollback: cut off before the old file moved, the version that worked is still at its name — the rollback keeps it there and moves the build that failed into old/", async () => {
  const s = await installedV1();
  try {
    await Deno.rename(s.staged, s.v2);
    const r = await restoreArtifact(
      s.v2,
      oldCopyPath(s.v1, "1.0.0"),
      s.data,
      { restoreTo: s.v1, failedTo: oldCopyPath(s.v2, "2.0.0") },
    );
    assertEquals(r, { at: s.v1 });
    assertEquals(await Deno.readTextFile(s.v1), "the 1.0.0 build");
    assertEquals(
      await Deno.readTextFile(oldCopyPath(s.v2, "2.0.0")),
      "the 2.0.0 build",
    );
    assertEquals(names(s.root), ["app-1.0.0-x86_64.AppImage", "data", "old"]);
  } finally {
    await dropTempDir(s.root);
  }
});

Deno.test("rollback: something at the old name AND the copy to put there — refused, nothing changed, the paths named", async () => {
  const s = await installedV1();
  try {
    await Deno.rename(s.staged, s.v2);
    const previous = oldCopyPath(s.v1, "1.0.0");
    await Deno.mkdir(join(s.root, "old", "1.0.0"), { recursive: true });
    await Deno.writeTextFile(previous, "the 1.0.0 build");
    await assertRejects(
      () => restoreArtifact(s.v2, previous, s.data, { restoreTo: s.v1 }),
      Error,
      `${s.v1} is in the way of the rollback — nothing was changed`,
    );
    assertEquals(await Deno.readTextFile(s.v2), "the 2.0.0 build");
  } finally {
    await dropTempDir(s.root);
  }
});

// ── what an older aio left beside the install ──────────────────────────────

Deno.test("legacy: `<install>.old-<version>` copies on the record move into old/<version>/<install's name>; one not on the record is not touched", async () => {
  const root = await tempDir("aio-oldlayout-legacy-");
  try {
    const data = join(root, "data");
    await Deno.mkdir(data);
    const install = join(root, "app");
    await Deno.writeTextFile(install, "2.0.0");
    for (const v of ["1.0.0", "1.1.0"]) {
      const p = `${install}.old-${v}`;
      record(data, p, "file", { role: "kept" });
      await Deno.writeTextFile(p, v);
      made(data, p);
    }
    await Deno.writeTextFile(`${install}.old-0.9.0`, "a copy made by hand");
    // Names no version folder can take are not moved anywhere. (Windows
    // drops a name's trailing dots, so `..` exists only elsewhere.)
    const odd = Deno.build.os === "windows" ? [""] : ["", ".."];
    for (const v of odd) {
      record(data, `${install}.old-${v}`, "file", { role: "kept" });
      await Deno.writeTextFile(`${install}.old-${v}`, "odd");
      made(data, `${install}.old-${v}`);
    }
    const r = migrateLegacyOld(data, [install]);
    assertEquals(r.failed, []);
    assertEquals(r.moved.length, 2);
    assertEquals(names(root), [
      "app",
      ...odd.map((v) => `app.old-${v}`),
      "app.old-0.9.0",
      "data",
      "old",
    ]);
    assertEquals(names(join(root, "old")), ["1.0.0", "1.1.0"]);
    assertEquals(
      await Deno.readTextFile(oldCopyPath(install, "1.1.0")),
      "1.1.0",
    );
    assert(isOwn(data, oldCopyPath(install, "1.0.0")), "moved with its record");
    // …and then pruned like the rest: keepOld 1 keeps the newest. What is
    // still beside the install is not one of old/'s versions.
    await pruneOld(install, 1, data);
    assertEquals(names(join(root, "old")), ["1.1.0"]);
    assertEquals(names(root), [
      "app",
      ...odd.map((v) => `app.old-${v}`),
      "app.old-0.9.0",
      "data",
      "old",
    ]);
  } finally {
    await dropTempDir(root);
  }
});

// ── the shared Electron store's records follow the install ──────────────────

Deno.test("store: the records an installed app keeps in the shared Electron store follow it to its new name — another app's stay", async () => {
  const root = await tempDir("aio-oldlayout-store-");
  try {
    const store = join(root, "store");
    await Deno.mkdir(join(store, "apps"), { recursive: true });
    const from = "/apps/app-1.0.0-x86_64.AppImage";
    const to = "/apps/app-2.0.0-x86_64.AppImage";
    const { sharedUseKey } = await import("../src/electron/shared-runtime.ts");
    const write = async (exe: string, v: string) =>
      await Deno.writeTextFile(
        join(store, "apps", `${await sharedUseKey(exe)}-${v}.json`),
        JSON.stringify({ exe, version: v, slug: "s", at: "2026-10-19" }),
      );
    await write(from, "38.0.0");
    await write("/apps/other", "38.0.0");
    assertEquals(await moveSharedUses(from, to, store), 1);
    const exes = (await readSharedUses(store)).map((u) => u.use?.exe).sort();
    assertEquals(exes, ["/apps/app-2.0.0-x86_64.AppImage", "/apps/other"]);
  } finally {
    await dropTempDir(root);
  }
});

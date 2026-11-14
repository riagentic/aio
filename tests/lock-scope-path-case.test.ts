// Windows path rules, proven on any host through the injected `os`.
//
// Three places decided a Windows (or macOS) path with a rule that only holds
// on Linux:
//
// - `am remove notes.` — Win32 strips a trailing `.` from every path segment,
//   so `…\Programs\notes.` IS `…\Programs\notes`. The name passed the app-name
//   check, missed the "notes is running" guard (appId `notes` is not the
//   string `notes.`), and reached notes' live install through the folded path.
// - `startIn` naming a file: `C:\report.txt` opened in `C:` (the drive's
//   CURRENT directory, not its root), and `C:/Users/me/Docs/report.txt` went
//   out unchanged as the folder — `_asDirectory` cut only at `\` and dropped a
//   root's separator, where its save twin `_splitSavePath` did neither.
// - the lock scope (and on Windows the pipe NAME, which carries it) was the
//   CASE of `AIO_APPS_DIR` as typed: `C:\Users\me\Apps` and `c:\users\me\apps`
//   are one apps root and were two scopes, and `lockKey` filed the default
//   home spelled in another case as a non-default `notes@<hash>`, so `am stop`
//   under the other spelling read a lock file that did not exist.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { APP_NAME_RE, appNameError } from "../src/am/am-utils.ts";
import { instanceNameError } from "../src/server/app-dirs.ts";
import {
  _splitSavePath,
  dialogRequest,
  pickSpec,
} from "../src/server/pick-path.ts";
import {
  _lockDirInUse,
  _lockDirParts,
  lockKey,
} from "../src/server/lock-dir.ts";
import { _pipeName } from "../src/server/paths.ts";
import { tempDirSync } from "../src/testing/temp-dir.ts";

// ── 1. a name Windows folds onto another name ───────────────

Deno.test("app name: a trailing '.' is refused — Windows folds notes. onto notes", () => {
  for (const bad of ["notes.", "app.2.", "a.", "x-y..."]) {
    assert(!APP_NAME_RE.test(bad), bad);
    const err = appNameError(bad, "am remove");
    assert(err, `${bad} must be refused`);
    assertMatch(err, /does not end in '\.'/);
  }
  // Inner dots and the single-character names stay names.
  for (const good of ["notes", "app.2", "a", "A1", "x_y", "demo-electron"]) {
    assertEquals(appNameError(good, "am remove"), null, good);
  }
});

Deno.test("instance name: a trailing '.' or space is refused, naming the fix", () => {
  for (const bad of ["agent1.", "agent1 ", "a. "]) {
    const err = instanceNameError(bad);
    assert(err, JSON.stringify(bad));
    assertMatch(err, /fix: --instance=agent1|fix: --instance=a\b/);
  }
  assertEquals(instanceNameError("agent1"), null);
  assertEquals(instanceNameError("a.b"), null);
});

// ── 2. startIn naming a file, on Windows ────────────────────

Deno.test("startIn C:\\report.txt opens in C:\\ (the root, not drive-relative C:)", () => {
  const req = dialogRequest("file", { startIn: "C:\\report.txt" }, "windows");
  assertEquals(req.defaultPath, "C:\\");
});

Deno.test("startIn C:/Users/me/Docs/report.txt opens in its folder", () => {
  const spec = pickSpec("windows", "powershell", "file", {
    startIn: "C:/Users/me/Docs/report.txt",
  })!;
  const m = /\$d\.InitialDirectory = '([^']*)'/.exec(spec.args.at(-1)!);
  assertEquals(m?.[1], "C:/Users/me/Docs");
});

Deno.test("startIn: one decider with the save split — every shape agrees", () => {
  for (
    const p of [
      "C:\\Users\\me\\report.txt",
      "C:/Users/me/report.txt",
      "C:\\report.txt",
      "C:/report.txt",
      "\\\\server\\share\\x.txt",
    ]
  ) {
    const req = dialogRequest("file", { startIn: p }, "windows");
    assertEquals(req.defaultPath, _splitSavePath(p, "windows").dir, p);
  }
  // A folder that is not there (trailing separator): its parent, root kept.
  assertEquals(
    dialogRequest("file", { startIn: "C:\\gone\\" }, "windows").defaultPath,
    "C:\\",
  );
  // A bare drive or a bare name has no folder to cut to: as given.
  assertEquals(
    dialogRequest("file", { startIn: "C:\\" }, "windows").defaultPath,
    "C:\\",
  );
});

// ── 3. one apps root in two cases ───────────────────────────

Deno.test("lock scope: one apps root spelled in two cases is one scope / one pipe (windows, darwin)", () => {
  for (const os of ["windows", "darwin"] as const) {
    const a = _lockDirParts("C:\\Users\\me\\Apps", os);
    const b = _lockDirParts("c:\\users\\me\\apps", os);
    assertEquals(a.scope, b.scope, os);
    assertEquals(
      _pipeName("aio" + a.scope, "notes"),
      _pipeName("aio" + b.scope, "notes"),
      os,
    );
    // The as-given spelling is kept for an older build's lock dir.
    assertEquals(a.legacyScope, "-C-Users-me-Apps", os);
    assertEquals(b.legacyScope, undefined, os);
  }
  // Linux paths are case-sensitive: two spellings, two roots, as always.
  const l = _lockDirParts("/home/me/Apps", "linux");
  assertEquals(l.scope, "-home-me-Apps");
  assertEquals(l.legacyScope, undefined);
  assert(l.scope !== _lockDirParts("/home/me/apps", "linux").scope);
});

Deno.test("lock scope: an older build's as-given dir is used only when it alone is on disk", () => {
  const base = tempDirSync("lockcase-");
  try {
    const parts = {
      base,
      scope: "-users-me-apps",
      legacyScope: "-Users-me-Apps",
    };
    // Nothing on disk: the folded name.
    assertEquals(_lockDirInUse(parts).scope, "-users-me-apps");
    // Only the old spelling (a case-sensitive volume): that one — an app
    // started before the upgrade is still found.
    Deno.mkdirSync(join(base, "aio-Users-me-Apps"));
    assertEquals(_lockDirInUse(parts).scope, "-Users-me-Apps");
    // Both (or one dir under both names, a case-insensitive volume): folded.
    Deno.mkdirSync(join(base, "aio-users-me-apps"));
    assertEquals(_lockDirInUse(parts).scope, "-users-me-apps");
    // No legacy spelling: nothing to fall back to.
    assertEquals(
      _lockDirInUse({ base, scope: "-x" }).scope,
      "-x",
    );
  } finally {
    Deno.removeSync(base, { recursive: true });
  }
});

Deno.test("lockKey: the default home in another case is the default home (darwin, windows)", () => {
  const prev = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", "/Users/me/Apps");
  try {
    assertEquals(
      lockKey("notes", "/users/me/apps/notes", undefined, "darwin"),
      "notes",
    );
    assertEquals(
      lockKey("notes", "/Users/me/Apps/notes", undefined, "windows"),
      "notes",
    );
    // Linux: another spelling is another directory — a non-default home.
    assertMatch(
      lockKey("notes", "/users/me/apps/notes", undefined, "linux"),
      /^notes@[0-9a-f]{8}$/,
    );
    // A real non-default home keeps its hash of the case as given (an older
    // build filed its lock under exactly that).
    assertMatch(
      lockKey("notes", "/Users/me/Elsewhere", undefined, "darwin"),
      /^notes@[0-9a-f]{8}$/,
    );
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
  }
});

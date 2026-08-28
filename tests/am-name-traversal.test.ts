// `am remove ..` deleted $HOME.
//
// Two commands took an app NAME straight from argv and handed it to `join()`:
// `am remove` and `am upgrade`. `join()` normalizes, and every path an install
// owns is derived by joining the name onto a root — so the name was a path
// traversal with a recursive delete on the end of it.
//
// Measured on this repo before the fix, with HOME pointed at a temp dir:
//
//   am remove ..   → removed $HOME (recursively) and $HOME/.local
//   am remove .    → removed $HOME/app (every installed app) and
//                    $HOME/.local/bin (every symlink on the machine, aio's
//                    and not) — and exited 0
//   am remove . --data → its data dir resolved to dirname($HOME)
//
// There is no confirmation prompt anywhere in `am`, so nothing stood between
// a typo and that. `am create` had validated its name since the day it was
// written; the other two never did. One fact, three deciders, one of them
// correct.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { join } from "@std/path";
import { APP_NAME_RE, appNameError } from "../src/am/am-utils.ts";
import { dataRemovalGate } from "../src/am/am-cmd-remove.ts";
import { appHome, installedAppPaths } from "../src/server/app-dirs.ts";

const AM = new URL("../src/am.ts", import.meta.url).pathname;

/** Run `am` with HOME pointed somewhere disposable. */
async function am(
  home: string,
  args: string[],
): Promise<{ code: number; out: string }> {
  const o = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", AM, ...args],
    env: { HOME: home, AIO_INSTALL_ROOT: join(home, "app") },
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  const d = new TextDecoder();
  return { code: o.code, out: d.decode(o.stdout) + d.decode(o.stderr) };
}

/** A believable home: an install root with two apps, and a ~/.local/bin that
 *  is NOT ours (the symlink of some other program). */
async function fakeHome(): Promise<string> {
  const home = await Deno.makeTempDir({ prefix: "aio-traversal-" });
  await Deno.mkdir(join(home, "app", "demo"), { recursive: true });
  await Deno.mkdir(join(home, "app", "other"), { recursive: true });
  await Deno.mkdir(join(home, ".local", "bin"), { recursive: true });
  await Deno.writeTextFile(join(home, "PRECIOUS"), "not the app's to delete");
  await Deno.writeTextFile(join(home, ".local", "bin", "ripgrep"), "#!/bin/sh");
  return home;
}

function present(path: string): boolean {
  try {
    Deno.lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// ── the traversal shapes, end to end ─────────────────────────

// Every shape the audit executed, plus the ones next to them. The assertion is
// not "it printed an error" — it is that nothing outside the install root was
// touched, which is the property that failed.
for (
  const name of [
    "..",
    ".",
    "../../..",
    "x/../..",
    "a/b",
    "/etc",
    "~",
    "..\\..",
    "",
  ]
) {
  Deno.test(`am remove ${JSON.stringify(name)}: refused, nothing deleted`, async () => {
    const home = await fakeHome();
    try {
      const r = await am(home, ["remove", name]);
      assert(
        r.code !== 0,
        `am remove ${JSON.stringify(name)} must not succeed`,
      );
      assert(
        present(join(home, "PRECIOUS")),
        `$HOME was modified by "am remove ${name}"`,
      );
      assert(
        present(join(home, "app", "demo")) &&
          present(join(home, "app", "other")),
        `the install root was modified by "am remove ${name}"`,
      );
      assert(
        present(join(home, ".local", "bin", "ripgrep")),
        `~/.local/bin was modified by "am remove ${name}" — those symlinks ` +
          `are not aio's to delete`,
      );
      assert(present(home), "$HOME itself is gone");
    } finally {
      await Deno.remove(home, { recursive: true }).catch(() => {});
    }
  });
}

Deno.test("am upgrade takes a name too, and refuses the same shapes", async () => {
  // alpha70: `am upgrade <checkout>` absorbed `am update <path>`, so a
  // path-shaped argument is read as a framework checkout — and `..` is not
  // one (no mod.ts), so it is refused BEFORE anything is joined or touched.
  const home = await fakeHome();
  try {
    const r = await am(home, ["upgrade", ".."]);
    assert(r.code !== 0);
    assertMatch(r.out, /not an aio checkout|not an app name/);
    assert(present(join(home, "PRECIOUS")), "$HOME was modified");
  } finally {
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
});

// ── the rule itself ──────────────────────────────────────────

Deno.test("app names: the shapes that make join() escape are unrepresentable", () => {
  for (
    const bad of [
      "..",
      ".",
      "../../..",
      "./x",
      "a/b",
      "a\\b",
      "/etc",
      "C:\\x",
      "~",
      "",
      " demo",
      "-demo", // a name that reads as a flag
      ".hidden",
      "..demo",
    ]
  ) {
    assert(
      !APP_NAME_RE.test(bad),
      `${JSON.stringify(bad)} must not be a valid app name`,
    );
    assert(
      appNameError(bad, "am remove"),
      `${JSON.stringify(bad)} must produce a refusal`,
    );
  }
  for (const good of ["demo", "demo-electron", "a", "app.2", "x_y", "A1"]) {
    assert(APP_NAME_RE.test(good), `${good} is a normal app name`);
    assertEquals(appNameError(good, "am remove"), null);
  }
});

Deno.test("app names: the derived paths stay one level under their roots", () => {
  for (const n of ["demo", "demo-electron", "app.2", "x_y", "A1"]) {
    const p = installedAppPaths(n);
    assertEquals(p.dir.split("/").pop(), n);
    assertEquals(p.binLink.split("/").pop(), n);
    // `appHome`, not `appDirs`: the RULE, not whatever a `--home` in some
    // other test happened to register for this id. The last segment is `.<n>`
    // by default and `<n>` under AIO_APPS_DIR — either way it is DERIVED from
    // the name and cannot be `..`, which is the property that failed:
    // `.` → `.${appId}` → ".." → dirname($HOME).
    const seg = appHome(n).split("/").pop();
    assertEquals(
      seg === n || seg === `.${n}`,
      true,
      `appHome(${n}) escaped its root: ${appHome(n)}`,
    );
  }
});

// ── the data gate ────────────────────────────────────────────

Deno.test("am remove --data: unrecoverable, so it is never one word in a script", () => {
  // No --data: the program is recoverable, so nothing to confirm.
  assertEquals(
    dataRemovalGate({ data: false, force: false, interactive: false }),
    "skip",
  );
  assertEquals(
    dataRemovalGate({ data: false, force: true, interactive: true }),
    "skip",
  );
  // --data at a terminal: ask.
  assertEquals(
    dataRemovalGate({ data: true, force: false, interactive: true }),
    "ask",
  );
  // --data in a script: refuse, because there is nobody to ask.
  assertEquals(
    dataRemovalGate({ data: true, force: false, interactive: false }),
    "refuse",
  );
  // --data --force: said twice, on purpose.
  assertEquals(
    dataRemovalGate({ data: true, force: true, interactive: false }),
    "force",
  );
});

Deno.test("am remove --data in a script refuses, and names the flag", async () => {
  const home = await fakeHome();
  try {
    // A real data dir for a real app name.
    await Deno.mkdir(join(home, ".demo"), { recursive: true });
    await Deno.writeTextFile(join(home, ".demo", "state.db"), "x");
    const r = await am(home, ["remove", "demo", "--data"]);
    assert(r.code !== 0, "a script must not delete data on one word");
    assertMatch(r.out, /--data --force/);
    assert(
      present(join(home, ".demo", "state.db")),
      "the data was deleted without confirmation",
    );
  } finally {
    await Deno.remove(home, { recursive: true }).catch(() => {});
  }
});

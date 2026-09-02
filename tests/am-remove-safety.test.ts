// `am remove` — the one command with no undo.
//
// `dataRemovalGate` and `installedFootprint` are covered
// (tests/am-name-traversal, tests/install-remove-update). What was not is
// `cmdRemove` itself: the orchestration that decides what is actually deleted
// from the disk, which is where the consequences live. It ran at 28%.
//
// Every case here works inside a temp AIO_INSTALL_ROOT and AIO_APPS_DIR, so
// what a failing assertion costs is a temp directory.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, join, resolve } from "@std/path";
import {
  cmdRemove,
  insideParent,
  installedFootprint,
} from "../src/am/am-cmd-remove.ts";
import {
  appDirs,
  installedAppParents,
  installedAppPaths,
  installRoot,
} from "../src/server/app-dirs.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";

class ExitSignal extends Error {
  constructor(public code: number) {
    super(`exit ${code}`);
  }
}

type Env = { installRoot: string; appsDir: string; home: string };

async function withHomes(fn: (env: Env) => Promise<void>): Promise<void> {
  const base = await Deno.makeTempDir({ prefix: "am-remove-" });
  const env: Env = {
    installRoot: join(base, "opt"),
    appsDir: join(base, "apps"),
    home: join(base, "home"),
  };
  const prevI = Deno.env.get("AIO_INSTALL_ROOT");
  const prevA = Deno.env.get("AIO_APPS_DIR");
  const prevH = Deno.env.get("HOME");
  Deno.env.set("AIO_INSTALL_ROOT", env.installRoot);
  Deno.env.set("AIO_APPS_DIR", env.appsDir);
  // HOME TOO, and this is not optional. `installedAppPaths` builds the
  // `.desktop` entry and the PATH symlink from `homedir()`, not from
  // `installRoot()` — so AIO_INSTALL_ROOT alone leaves two of the three paths
  // pointing at the real home, and `installedAppPaths("..").binLink` is
  // `~/.local`. Setting only the two aio variables here is what let a mutation
  // run of this very file delete ~/.local/share on 2026-09-02.
  Deno.env.set("HOME", env.home);
  await Deno.mkdir(env.installRoot, { recursive: true });
  await Deno.mkdir(env.appsDir, { recursive: true });
  await Deno.mkdir(join(env.home, ".local", "bin"), { recursive: true });
  await Deno.mkdir(join(env.home, ".local", "share", "applications"), {
    recursive: true,
  });
  try {
    await fn(env);
  } finally {
    if (prevI === undefined) Deno.env.delete("AIO_INSTALL_ROOT");
    else Deno.env.set("AIO_INSTALL_ROOT", prevI);
    if (prevA === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prevA);
    if (prevH === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", prevH);
    await Deno.remove(base, { recursive: true }).catch(() => {});
  }
}

/** An installed program, its data, or both. */
async function install(
  name: string,
  what: { program?: boolean; data?: boolean },
): Promise<{ dir: string; dataDir: string }> {
  const dir = join(installRoot(), name);
  const dataDir = appDirs(name).home;
  if (what.program) {
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(join(dir, "the-binary"), "#!/bin/sh\n");
  }
  if (what.data) {
    await Deno.mkdir(join(dataDir, "data"), { recursive: true });
    await Deno.writeTextFile(
      join(dataDir, "data", "state.db"),
      "irreplaceable",
    );
    await Deno.writeTextFile(join(dataDir, "data", "app.key"), "secret");
  }
  return { dir, dataDir };
}

type Run = { logs: string[]; errors: string[]; code: number | null };

async function run(
  args: string[],
  flags: Partial<GlobalFlags> = {},
  opts: { stdinTty?: boolean; answer?: string | null } = {},
): Promise<Run> {
  const logs: string[] = [], errors: string[] = [];
  const l = console.log, e = console.error, realExit = Deno.exit;
  const realStdinTty = Deno.stdin.isTerminal;
  const realStdoutTty = Deno.stdout.isTerminal;
  const realPrompt = globalThis.prompt;
  if (opts.stdinTty) {
    Deno.stdin.isTerminal = () => true;
    // `interactive` needs pretty mode, which needs a stdout terminal too.
    Deno.stdout.isTerminal = () => true;
    globalThis.prompt = () => opts.answer ?? null;
  }
  console.log = (...a: unknown[]) => logs.push(a.join(" "));
  console.error = (...a: unknown[]) => errors.push(a.join(" "));
  // deno-lint-ignore no-explicit-any
  (Deno as any).exit = (c?: number) => {
    throw new ExitSignal(c ?? 0);
  };
  let code: number | null = null;
  try {
    await cmdRemove(args, flags as GlobalFlags);
  } catch (err) {
    if (!(err instanceof ExitSignal)) throw err;
    code = err.code;
  } finally {
    console.log = l;
    console.error = e;
    Deno.exit = realExit;
    Deno.stdin.isTerminal = realStdinTty;
    Deno.stdout.isTerminal = realStdoutTty;
    globalThis.prompt = realPrompt;
  }
  return { logs, errors, code };
}

const said = (r: Run) => r.logs.join("\n") + "\n" + r.errors.join("\n");
const there = async (p: string) => {
  try {
    await Deno.lstat(p);
    return true;
  } catch {
    return false;
  }
};

// ── data survives everything that is not an explicit, doubled request ──

Deno.test("am remove: the program goes, the data stays, and it says where", async () => {
  await withHomes(async () => {
    const { dir, dataDir } = await install("notes", {
      program: true,
      data: true,
    });
    const r = await run(["notes"]);
    assertEquals(r.code, null);
    assertEquals(await there(dir), false, "the program was not removed");
    assertEquals(await there(dataDir), true, "DATA was removed without --data");

    const j = JSON.parse(r.logs.join("\n")) as {
      dataRemoved: boolean;
      dataKept: string | null;
    };
    assertEquals(j.dataRemoved, false);
    assertEquals(j.dataKept, dataDir, "kept data must be named, not implied");
  });
});

Deno.test("am remove --data: outside a terminal it refuses and names the way", async () => {
  await withHomes(async () => {
    const { dataDir } = await install("notes", { program: true, data: true });
    // A pipe: a script, CI, or an agent. It has to be said twice.
    const r = await run(["notes"], { data: true });
    assertEquals(r.code, 1);
    assertEquals(
      await there(dataDir),
      true,
      "data deleted without confirmation",
    );
    const msg = said(r);
    assertStringIncludes(msg, "--data --force");
    assertStringIncludes(msg, "no undo");
  });
});

Deno.test("am remove --data --force: said twice, so it happens", async () => {
  await withHomes(async () => {
    const { dir, dataDir } = await install("notes", {
      program: true,
      data: true,
    });
    const r = await run(["notes"], { data: true, force: true });
    assertEquals(r.code, null);
    assertEquals(await there(dir), false);
    assertEquals(
      await there(dataDir),
      false,
      "--data --force did not remove data",
    );
    const j = JSON.parse(r.logs.join("\n")) as { dataRemoved: boolean };
    assertEquals(j.dataRemoved, true);
  });
});

Deno.test("am remove --data: at a terminal, the wrong answer removes nothing", async () => {
  await withHomes(async () => {
    const { dir, dataDir } = await install("notes", {
      program: true,
      data: true,
    });
    // Typing anything but the app name — including the habitual "y".
    for (const answer of ["y", "yes", "", "note", null]) {
      const r = await run(["notes"], { data: true }, {
        stdinTty: true,
        answer,
      });
      assertEquals(r.code, 1, `"${answer}" was accepted as confirmation`);
      assertStringIncludes(said(r), "nothing was removed");
      assertEquals(await there(dataDir), true, `"${answer}" deleted the data`);
      assertEquals(await there(dir), true, `"${answer}" deleted the program`);
    }
  });
});

Deno.test("am remove --data: typing the app name is what confirms it", async () => {
  await withHomes(async () => {
    const { dir, dataDir } = await install("notes", {
      program: true,
      data: true,
    });
    const r = await run(["notes"], { data: true }, {
      stdinTty: true,
      answer: "notes",
    });
    assertEquals(r.code, null);
    assertEquals(await there(dir), false);
    assertEquals(await there(dataDir), false);
  });
});

// ── it refuses rather than doing half a job ──────────────────

Deno.test("am remove: an app that is not installed says so, and points at its data", async () => {
  await withHomes(async () => {
    const { dataDir } = await install("notes", { data: true });
    const r = await run(["notes"]);
    assertEquals(r.code, 1);
    const msg = said(r);
    assertStringIncludes(msg, "nothing installed");
    // The data is the thing a person is actually looking for.
    assertStringIncludes(msg, dataDir);
    assertStringIncludes(msg, "--data");
    assertEquals(await there(dataDir), true);
  });
});

Deno.test("am remove: no name at all asks which app", async () => {
  await withHomes(async () => {
    const r = await run([]);
    assertEquals(r.code, 1);
    assertStringIncludes(said(r), "which app?");
  });
});

Deno.test("am remove: a traversing name is refused before anything is deleted", async () => {
  await withHomes(async (env) => {
    // `join()` normalizes, so this used to resolve to $HOME with a recursive
    // delete on the end of it — measured, exit 0.
    //
    // The canaries sit on EVERY path a traversing name actually reaches, not
    // just the one that was easy to think of. The first version of this test
    // put its canary in the temp install root only — which a traversing name
    // never touches, because `.desktop` and the PATH symlink are built from
    // `homedir()`. It passed while ~/.local was being deleted.
    const canaries = [
      join(env.installRoot, "CANARY"),
      join(env.home, "CANARY"),
      join(env.home, ".local", "CANARY"),
      join(env.home, ".local", "bin", "CANARY"),
      join(env.home, ".local", "share", "CANARY"),
      join(env.home, ".local", "share", "applications", "CANARY"),
    ];
    for (const c of canaries) await Deno.writeTextFile(c, "still here");

    for (const bad of ["..", "../..", "a/../..", "/etc", ".", "../../.."]) {
      const r = await run([bad], { data: true, force: true });
      assertEquals(r.code, 1, `"${bad}" was not refused`);
      for (const c of canaries) {
        assertEquals(await there(c), true, `"${bad}" deleted ${c}`);
      }
    }
    for (
      const dir of [
        env.installRoot,
        env.appsDir,
        env.home,
        join(env.home, ".local"),
        join(env.home, ".local", "bin"),
        join(env.home, ".local", "share"),
      ]
    ) {
      assertEquals(await there(dir), true, `${dir} was removed`);
    }
  });
});

Deno.test("am remove: --data alone removes data even with no program left", async () => {
  await withHomes(async () => {
    // Half-removed state: the program is gone, the data is not. `am remove
    // notes --data --force` has to be able to finish the job.
    const { dataDir } = await install("notes", { data: true });
    const r = await run(["notes"], { data: true, force: true });
    assertEquals(r.code, null);
    assertEquals(await there(dataDir), false);
  });
});

// ── the second guard, tested without the first ───────────────
//
// On 2026-09-02 a mutation run of this file disabled `appNameError` — the one
// guard — and the traversal case then deleted the contents of ~/.local before
// its assertion could fail. `insideParent` is the guard that does not depend on
// the name, and these test it directly: no mutation, no delete, no home
// directory involved.

Deno.test("am remove: insideParent refuses the parent itself, not just outside it", () => {
  // Deleting the parent IS the failure mode — `~/.local/bin/..` is `~/.local`.
  assertEquals(insideParent("/a/b", "/a/b"), false);
  assertEquals(insideParent("/a/b/", "/a/b"), false);
  assertEquals(insideParent("/a", "/a/b"), false);
  assertEquals(insideParent("/", "/a/b"), false);
  assertEquals(insideParent("/other/c", "/a/b"), false);
  // A sibling with a shared prefix is not inside it.
  assertEquals(insideParent("/a/bc", "/a/b"), false);
  // Proper descendants, which are the only paths it may delete.
  assertEquals(insideParent("/a/b/c", "/a/b"), true);
  assertEquals(insideParent("/a/b/c/d", "/a/b"), true);
  // …and it resolves before comparing, so a traversal cannot sneak past.
  assertEquals(insideParent("/a/b/c/../..", "/a/b"), false);
  assertEquals(insideParent("/a/b/c/../d", "/a/b"), true);
});

Deno.test("am remove: every path a traversing name produces is refused by containment", async () => {
  // The exact resolutions measured during the incident:
  //   installedAppPaths("..").binLink     → ~/.local
  //   installedAppPaths("../..").binLink  → ~
  //   installedAppPaths(".").binLink      → ~/.local/bin
  // Each is the PARENT of where an install may write, which is why equality
  // has to be refused rather than merely "outside".
  await withHomes(async () => {
    for (const bad of ["..", "../..", "a/../..", ".", "../../.."]) {
      const fp = await installedFootprint(bad);
      // The two that escape are the two built from `homedir()` and the one
      // built from `installRoot()`. (`.desktop` does NOT escape: the appended
      // suffix turns `..` into a file literally named `...desktop` INSIDE
      // applications/, which is harmless and correctly accepted — the guard
      // must not be so blunt that it refuses real paths.)
      for (const kind of ["the app and its versions", "PATH symlink"]) {
        const f = fp.find((x) => x.kind === kind)!;
        assertEquals(
          insideParent(f.path, f.parent),
          false,
          `"${bad}" → ${f.path} was ACCEPTED as inside ${f.parent}`,
        );
      }
      // Whatever containment accepts is a proper descendant by definition —
      // what matters is that the count is non-vacuous: three paths went in.
      assertEquals(fp.length, 3, "an install occupies three paths");
    }
    // …and an ordinary name is accepted by all three, or the guard is useless.
    const ok = await installedFootprint("notes");
    assertEquals(ok.length, 3, "an install occupies three paths");
    for (const f of ok) {
      assertEquals(
        insideParent(f.path, f.parent),
        true,
        `a legitimate name was refused: ${f.path} vs ${f.parent}`,
      );
    }
  });
});

Deno.test("am remove: the owning directories are the ones an install writes to", () => {
  // `installedAppPaths` is built FROM `installedAppParents`, so the two cannot
  // drift — the check would silently start passing if they did.
  const parents = installedAppParents();
  const p = installedAppPaths("notes");
  assertEquals(dirname(p.dir), parents.dir);
  assertEquals(dirname(p.desktop), parents.desktop);
  assertEquals(dirname(p.binLink), parents.binLink);
});

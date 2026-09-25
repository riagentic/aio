// report 9b §2: `am create x` ran with `~/.x/data/state.db` already present
// from an older app with the same appId (its meta.json said aio alpha68,
// created weeks before). The output was the usual success with no warning, and
// the first `deno task dev` booted on that state — then refused on shape
// drift, and finding WHERE the data lived cost an agent ~6.5 minutes of
// whole-disk searching. `am create` knows the rule (`appHome`: `$AIO_APPS_DIR/
// <appId>`, else `~/.<appId>`), so it says what is already there, and points
// at `am data`.
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  cmdCreate,
  priorAppData,
  priorAppDataLine,
} from "../src/am/am-cmd-create.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";

const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

async function withAppsDir<T>(fn: (apps: string) => Promise<T>): Promise<T> {
  const apps = await tempDir("aio-create-apps-");
  const prev = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", apps);
  try {
    return await fn(apps);
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    await dropTempDir(apps);
  }
}

async function oldApp(apps: string, appId: string, meta?: object) {
  await Deno.mkdir(join(apps, appId, "data"), { recursive: true });
  await Deno.writeTextFile(join(apps, appId, "data", "state.db"), "");
  if (meta) {
    await Deno.writeTextFile(
      join(apps, appId, "data", "meta.json"),
      JSON.stringify(meta),
    );
  }
}

async function createJson(cwd: string, name: string) {
  const orig = Deno.cwd();
  const lines: string[] = [];
  const real = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    Deno.chdir(cwd);
    await cmdCreate([name, `--mirror=${ROOT}`], { json: true } as GlobalFlags);
  } finally {
    console.log = real;
    Deno.chdir(orig);
  }
  return JSON.parse(lines.at(-1)!) as Record<string, unknown>;
}

Deno.test("priorAppData: nothing there → null; a home with meta.json → its aio version and dates", async () => {
  await withAppsDir(async (apps) => {
    assertEquals(priorAppData("fresh"), null);
    await oldApp(apps, "pomodoro", {
      appId: "pomodoro",
      aio: "1.0.0-alpha68",
      createdAt: "2026-08-26T09:00:00.000Z",
      updatedAt: "2026-08-30T10:00:00.000Z",
    });
    assertEquals(priorAppData("pomodoro"), {
      home: join(apps, "pomodoro"),
      aio: "1.0.0-alpha68",
      createdAt: "2026-08-26T09:00:00.000Z",
      updatedAt: "2026-08-30T10:00:00.000Z",
    });
    // A home with no (or an unreadable) meta.json is still data — said, with
    // what could not be read left null rather than invented.
    await oldApp(apps, "nometa");
    assertEquals(priorAppData("nometa"), {
      home: join(apps, "nometa"),
      aio: null,
      createdAt: null,
      updatedAt: null,
    });
  });
});

Deno.test("priorAppDataLine: names the directory, the aio version, the date, and `am data`", () => {
  const line = priorAppDataLine("pomodoro", {
    home: "/h/.pomodoro",
    aio: "1.0.0-alpha68",
    createdAt: "2026-08-26T09:00:00.000Z",
    updatedAt: "2026-08-30T10:00:00.000Z",
  });
  for (const part of ["/h/.pomodoro", "alpha68", "2026-08-26", "am data"]) {
    assertStringIncludes(line, part);
  }
  const bare = priorAppDataLine("x", {
    home: "/h/.x",
    aio: null,
    createdAt: null,
    updatedAt: null,
  });
  assertStringIncludes(bare, "/h/.x");
  assertStringIncludes(bare, "am data");
});

Deno.test("am create --json: `existingData` names the old app's home (report 9b §2)", async () => {
  await withAppsDir(async (apps) => {
    const cwd = await tempDir("aio-create-cwd-");
    try {
      await oldApp(apps, "pomo", {
        appId: "pomo",
        aio: "1.0.0-alpha68",
        createdAt: "2026-08-26T09:00:00.000Z",
        updatedAt: "2026-08-26T09:00:00.000Z",
      });
      const doc = await createJson(cwd, "pomo");
      const prior = doc.existingData as Record<string, unknown> | null;
      assert(prior, `expected existingData: ${JSON.stringify(doc)}`);
      assertEquals(prior.home, join(apps, "pomo"));
      assertEquals(prior.aio, "1.0.0-alpha68");
      // A fresh appId: the field is present and null — additive, never absent.
      const fresh = await createJson(cwd, "brandnew");
      assert("existingData" in fresh, JSON.stringify(fresh));
      assertEquals(fresh.existingData, null);
    } finally {
      await dropTempDir(cwd);
    }
  });
});

// `am create x --mirror` (bare — the spelling the help's `--mirror[=<path>]`
// and the module doc offer for framework development) parsed to `""`, which
// the create path read as "no mirror": the app was pinned to the newest
// RELEASE and linked to a provisioned worktree, not the checkout. The
// `--aio-version` below is a tripwire so the regression fails fast (a missing
// path pin) instead of provisioning a release worktree; a mirror ignores it.
Deno.test("am create --mirror (bare): links and path-pins the checkout am runs from", async () => {
  await withAppsDir(async () => {
    const cwd = await tempDir("aio-create-cwd-");
    const orig = Deno.cwd();
    const lines: string[] = [];
    const log = console.log, err = console.error, exit = Deno.exit;
    console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => lines.push(a.map(String).join(" "));
    // deno-lint-ignore no-explicit-any
    (Deno as any).exit = (c?: number) => {
      throw new Error(`exit ${c}: ${lines.join("\n")}`);
    };
    try {
      Deno.chdir(cwd);
      await cmdCreate(
        ["mirrored", "--mirror", "--aio-version=path:/nonexistent-aio-x"],
        { json: true } as GlobalFlags,
      );
    } finally {
      console.log = log;
      console.error = err;
      Deno.exit = exit;
      Deno.chdir(orig);
    }
    try {
      const doc = JSON.parse(lines.at(-1)!) as Record<string, unknown>;
      assertEquals(doc.aioVersion, `path:${ROOT}`);
      assertEquals(doc.framework, ROOT);
      assertEquals(
        await Deno.realPath(join(cwd, "mirrored", "dep", "aio")),
        await Deno.realPath(ROOT),
      );
    } finally {
      await dropTempDir(cwd);
    }
  });
});

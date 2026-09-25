// `am restore` never leaves a home its app refuses to boot from.
//
// A backup carries its `meta.json`, and `meta.json` records the PROFILE the
// folder belongs to. Restoring a `--profile=p1` archive into the default home
// (or a default archive into `--profile=dev`) used to exit 0 — restore
// compared only the appId — and then the app refused to boot:
// `…/app belongs to profile "p1" of app "…", not to app "…"`. Now every
// (archive, target) pair either restores into a home that passes the SAME
// owner check boot runs, or is refused up front with data/ untouched and the
// command that restores it into its own home.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { cmdRestore } from "../src/am/am-cmd-data.ts";
import { _resetHomePin, targetHome } from "../src/am/am-utils.ts";
import {
  _resetAppDirs,
  appDirs,
  ensureAppDirs,
  homeOwnerError,
  profileHome,
  writeAppMeta,
} from "../src/server/app-dirs.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const APP = "rsprof";
const SUITE_HOME = Deno.env.get("AIO_APPS_DIR");

async function run(
  args: string[],
  flags: Record<string, unknown>,
): Promise<{ out: string; exited: number | null }> {
  const chunks: string[] = [];
  const [log, err, exit] = [console.log, console.error, Deno.exit];
  let exited: number | null = null;
  console.log = (...a: unknown[]) => chunks.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => chunks.push(a.map(String).join(" "));
  // deno-lint-ignore no-explicit-any
  (Deno as any).exit = (code = 0) => {
    exited = code;
    throw new Error("__exit__");
  };
  try {
    await cmdRestore(args, { app: APP, json: true, ...flags });
  } catch (e) {
    if (!(e instanceof Error) || e.message !== "__exit__") throw e;
  } finally {
    console.log = log;
    console.error = err;
    // deno-lint-ignore no-explicit-any
    (Deno as any).exit = exit;
  }
  return { out: chunks.join("\n"), exited };
}

/** An archive as `am backup` writes it; `profile: null` = an archive with no
 *  meta.json at all (a hand-made copy). */
function archive(dir: string, profile: string | undefined | null): void {
  Deno.mkdirSync(dir, { recursive: true });
  Deno.writeTextFileSync(join(dir, "state.db"), `ARCHIVE:${profile}`);
  if (profile === null) return;
  Deno.writeTextFileSync(
    join(dir, "meta.json"),
    JSON.stringify({
      appId: APP,
      aio: "1.0.0-test",
      ...(profile ? { profile } : {}),
      createdAt: "x",
      updatedAt: "x",
    }),
  );
}

Deno.test("am restore: every archive/target pair ends bootable or refused", async () => {
  const base = await tempDir("am-restore-prof-");
  Deno.env.set("AIO_APPS_DIR", join(base, "apps"));
  try {
    const archives = {
      none: null,
      plain: undefined,
      p1: "p1",
      dev: "dev",
    } as const;
    const targets: { name: string; profile?: string }[] = [
      { name: "default" },
      { name: "dev", profile: "dev" },
    ];
    const verdicts: string[] = [];
    for (const t of targets) {
      for (const [an, ap] of Object.entries(archives)) {
        _resetAppDirs();
        _resetHomePin();
        // What `am.ts` binds for `--profile=<name>` before any verb runs.
        if (t.profile) targetHome(APP, profileHome(APP, t.profile), t.profile);
        const d = appDirs(APP);
        try {
          Deno.removeSync(d.home, { recursive: true });
        } catch { /* first pair: no home yet */ }
        ensureAppDirs(d);
        Deno.writeTextFileSync(d.stateDb, "LIVE");
        writeAppMeta(d, { appId: APP, aio: "1.0.0-test", profile: t.profile });
        const src = join(base, `ar-${t.name}-${an}`);
        archive(src, ap);
        const r = await run([src], t.profile ? { profile: t.profile } : {});
        const label = `${an} → ${t.name}`;
        if (r.exited === null) {
          assertEquals(Deno.readTextFileSync(d.stateDb), `ARCHIVE:${ap}`);
          // The check boot runs — requested home = strict, plain = profiles.
          const owner = homeOwnerError(d, APP, t.profile, !t.profile);
          assertEquals(owner, null, `${label}: restored, then unbootable`);
          verdicts.push(`${label}: ok`);
        } else {
          assertEquals(r.exited, 1, r.out);
          assertEquals(Deno.readTextFileSync(d.stateDb), "LIVE", label);
          const doc = JSON.parse(r.out) as { error?: string };
          assert(doc.error, r.out);
          assertStringIncludes(doc.error, `am restore ${src}`);
          verdicts.push(`${label}: refused`);
        }
      }
    }
    // Same-profile restores still work; cross-profile ones are refused.
    assertEquals(verdicts, [
      "none → default: ok",
      "plain → default: ok",
      "p1 → default: refused",
      "dev → default: refused",
      "none → dev: ok",
      "plain → dev: refused",
      "p1 → dev: refused",
      "dev → dev: ok",
    ]);
  } finally {
    if (SUITE_HOME === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", SUITE_HOME);
    _resetAppDirs();
    _resetHomePin();
    await dropTempDir(base);
  }
});

// Every runnable example must NAME ITSELF.
//
// These examples live inside the aio repo, so the nearest deno.json is the
// FRAMEWORK's. Five of them (counter, todo, contacts, disk, updates) had no
// deno.json of their own and passed no `appId`, so each booted as appId "aio":
// one identity, one lock, one `~/.aio` and one state.db shared between five
// different apps. MEASURED before the fix — starting the counter example while
// the updates example ran:
//
//   [AIO] Already running: aio at http://localhost:52312 (pid …) (home /home/dev/.aio)
//   … the appId also picks the data home, so both would read and write one
//   database. Rename this one: aio.run({ appId: "…" })
//
// The framework diagnosed its own examples correctly. They are the first thing
// a reader runs, so they must not teach the collision.
import { assert, assertEquals } from "@std/assert";

const ROOT = new URL("../examples/", import.meta.url);

/** Every directory under examples/ (recursively) that has an app entry. */
async function appDirs(base: URL, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(base)) {
    if (!e.isDirectory) continue;
    const here = `${prefix}${e.name}`;
    const dir = new URL(`${e.name}/`, base);
    let hasApp = false;
    for await (const f of Deno.readDir(dir)) {
      if (f.isFile && f.name === "app.ts") hasApp = true;
    }
    if (hasApp) out.push(here);
    out.push(...await appDirs(dir, `${here}/`));
  }
  return out.sort();
}

Deno.test("examples: every runnable example declares its own identity", async () => {
  const dirs = await appDirs(ROOT);
  // VERIFY THE INSTRUMENT: a walk that found nothing would pass vacuously.
  assert(
    dirs.length >= 5,
    `found ${dirs.length} example apps — the walk broke, so this proves nothing`,
  );

  const ids = new Map<string, string>();
  const nameless: string[] = [];
  for (const d of dirs) {
    const entry = await Deno.readTextFile(new URL(`${d}/app.ts`, ROOT));
    const m = /appId:\s*"([^"]+)"/.exec(entry);
    if (m) {
      ids.set(d, m[1]!);
      continue;
    }
    // …or the NEAREST deno.json at or above it, which is where a real
    // project's identity lives and exactly how aio resolves it. Stop at
    // examples/: one level further up is the framework's own config, which is
    // the inheritance this test exists to catch.
    let found: string | undefined;
    const segs = d.split("/");
    for (let i = segs.length; i > 0 && !found; i--) {
      const at = segs.slice(0, i).join("/");
      try {
        const cfg = JSON.parse(
          await Deno.readTextFile(new URL(`${at}/deno.json`, ROOT)),
        ) as { appId?: string; title?: string; name?: string };
        const id = cfg.appId ?? cfg.title ?? cfg.name;
        if (id) found = String(id);
      } catch {
        // aio-ok: keep walking up; no config here is not an answer either way.
      }
    }
    if (found) {
      ids.set(d, found);
      continue;
    }
    nameless.push(d);
  }

  assertEquals(
    nameless,
    [],
    `these examples inherit the FRAMEWORK's deno.json, so each boots as ` +
      `appId "aio" and shares one lock and one state.db with its siblings: ` +
      `${nameless.join(", ")}. Give each an appId in aio.run({…}) or its own ` +
      `deno.json.`,
  );

  // …and no two may claim the same name, which is the same collision by
  // another route. Every app dir is in `ids` by now (the assertion above
  // proves none were nameless), so this is stated as an equality rather than
  // left to a loop that would run zero times if the walk had failed.
  assertEquals(
    ids.size,
    dirs.length,
    "every example app must have resolved an identity by now",
  );
  const seen = new Map<string, string>();
  for (const [dir, id] of ids) {
    const prev = seen.get(id);
    assertEquals(
      prev,
      undefined,
      `examples/${dir} and examples/${prev} both claim appId "${id}" — one ` +
        `data home, one lock, two apps`,
    );
    seen.set(id, dir);
  }
});

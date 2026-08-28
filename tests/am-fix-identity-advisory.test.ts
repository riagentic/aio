// `am fix`'s identity advisory used to fire on EVERY app `am create` had just
// scaffolded: run the two commands back to back and the framework's repair
// tool told you to change what the framework had generated one command
// earlier. An advisory that fires on its own output is noise, and noise is how
// the advisories that matter get skipped.
//
// It asked the wrong question — "is `appId` in `aio.run()`" — when
// `resolveAppId` infers from `deno.json`'s `appId > title > name` and only
// falls back to the entry's DIRECTORY name if a project declares none of the
// three. A scaffold writes a `name`, so its identity is already deterministic
// and renaming the folder moves nothing.
//
// Driven through the real `am fix --dry-run --json`, because the thing under
// test is what a user is told, not a predicate.
import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const REPO = dirname(dirname(fromFileUrl(import.meta.url)));

/** Build a minimal app, run `am fix --dry-run --json`, return its report. */
async function fixReport(
  denoJson: Record<string, unknown>,
  entry: string,
): Promise<{ advise: number; results: { name: string; outcome: string }[] }> {
  const dir = await Deno.makeTempDir({ prefix: "aio-fix-identity-" });
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ tasks: { dev: "deno run -A src/app.ts" }, ...denoJson }),
    );
    await Deno.writeTextFile(join(dir, "src", "app.ts"), entry);
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        join(REPO, "src", "am.ts"),
        "fix",
        "--dry-run",
        "--json",
      ],
      cwd: dir,
      env: { ...Deno.env.toObject(), AIO_APPS_DIR: dir },
      stdout: "piped",
      stderr: "null",
    }).output();
    return JSON.parse(new TextDecoder().decode(out.stdout));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

const RUN = `import { aio } from "aio";\nawait aio.run({ ui: {} });\n`;

Deno.test({
  name: "am fix: a scaffolded app is not told to fix its identity",
  async fn() {
    // What `am create` writes: a `name` in deno.json, no appId in aio.run().
    const r = await fixReport({ name: "scaffolded" }, RUN);
    const identity = r.results.filter((x) => /identity|appId/i.test(x.name));
    assertEquals(
      identity.map((x) => x.outcome),
      identity.map(() => "ok"),
      "the repair tool flagged an app the scaffold had just produced",
    );
  },
});

Deno.test({
  name: "am fix: `title` alone pins the identity too",
  async fn() {
    // resolveAppId reads appId > title > name; any of the three is enough.
    const r = await fixReport({ title: "My App" }, RUN);
    const identity = r.results.filter((x) => /identity|appId/i.test(x.name));
    assertEquals(identity.every((x) => x.outcome === "ok"), true);
  },
});

Deno.test({
  name: "am fix: an app with NOTHING declaring its identity is still advised",
  async fn() {
    // The case the advisory is actually for: identity falls back to the
    // entry's directory name, so moving the folder orphans the stored state.
    const r = await fixReport({}, RUN);
    const identity = r.results.filter((x) => /identity|appId/i.test(x.name));
    assertEquals(
      identity.some((x) => x.outcome === "advise"),
      true,
      "the advisory stopped firing where it is the whole point",
    );
  },
});

// `am pin` on a `deno.jsonc` app: the pin is WRITTEN into the file Deno reads.
//
// `cmdPin` accepted both config names at its door (`DENO_JSON_NAMES`), then
// `writeDenoJsonPin` read `deno.json` by literal name — so on a `.jsonc` app
// the version was provisioned, `dep/aio` relinked, and the command died on
// NotFound: half-pinned, with a stack trace where the report should be.
// `syncFrameworkDeps` had the same literal name AND a raw `JSON.parse`, so a
// `deno.json` holding one `//` comment threw AFTER the pin was written (the
// exact case `cmdPin`'s own comment names), and a `.jsonc` app silently got
// no dep sync at all. Both go through THE reader now.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { syncFrameworkDeps, writePin } from "../src/am/am-versions.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const APP_JSONC = `{
  // an app's own config, in the spelling Deno accepts
  "title": "demo",
  "imports": {
    "immer": "npm:immer@^10",
  },
}
`;

/** A stand-in for a provisioned framework checkout: only its deno.json is
 *  read by the dep sync. */
async function framework(): Promise<string> {
  const fw = await tempDir("aio-fw-");
  await Deno.writeTextFile(
    join(fw, "deno.json"),
    JSON.stringify({ imports: { immer: "npm:immer@10.2.0" } }),
  );
  return fw;
}

async function exists(p: string): Promise<boolean> {
  try {
    await Deno.stat(p);
    return true;
  } catch {
    return false;
  }
}

Deno.test("pin: a deno.jsonc app gets its pin written into deno.jsonc, and no deno.json appears", async () => {
  const dir = await tempDir("aio-pin-jsonc-");
  try {
    await Deno.writeTextFile(join(dir, "deno.jsonc"), APP_JSONC);
    const wrote = await writePin(dir, "v1.0.0-alpha76");
    assertEquals(wrote.file, "deno.json"); // the REPORT's word for "the config"
    const after = await Deno.readTextFile(join(dir, "deno.jsonc"));
    assertStringIncludes(after, '"aioVersion": "v1.0.0-alpha76"');
    assertStringIncludes(
      after,
      "// an app's own config",
      "the comment survives",
    );
    assert(
      !(await exists(join(dir, "deno.json"))),
      "a second config file must never be created beside the app's own",
    );
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("pin: the dep sync reads and edits deno.jsonc, comment intact", async () => {
  const dir = await tempDir("aio-pin-jsonc-sync-");
  const fw = await framework();
  try {
    await Deno.writeTextFile(join(dir, "deno.jsonc"), APP_JSONC);
    const changes = await syncFrameworkDeps(dir, fw);
    assertEquals(changes, [{
      key: "immer",
      from: "npm:immer@^10",
      to: "npm:immer@10.2.0",
    }]);
    const after = await Deno.readTextFile(join(dir, "deno.jsonc"));
    assertStringIncludes(after, '"immer": "npm:immer@10.2.0"');
    assertStringIncludes(after, "// an app's own config");
    // Idempotent: a second sync has nothing to say.
    assertEquals(await syncFrameworkDeps(dir, fw), []);
  } finally {
    await dropTempDir(fw);
    await dropTempDir(dir);
  }
});

Deno.test("pin: a deno.json with a comment is synced, not thrown out of JSON.parse", async () => {
  const dir = await tempDir("aio-pin-json-comment-");
  const fw = await framework();
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), APP_JSONC);
    const changes = await syncFrameworkDeps(dir, fw);
    assertEquals(changes.length, 1, JSON.stringify(changes));
    assertStringIncludes(
      await Deno.readTextFile(join(dir, "deno.json")),
      '"immer": "npm:immer@10.2.0"',
    );
  } finally {
    await dropTempDir(fw);
    await dropTempDir(dir);
  }
});

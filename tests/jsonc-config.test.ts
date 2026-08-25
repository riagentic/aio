// `deno.json` is JSONC, and `deno.jsonc` exists (R-12).
//
// Deno reads both, and accepts `//` comments in either — which is the natural
// place to explain a non-obvious import alias. The framework read the file with
// `JSON.parse` in ELEVEN places, so one comment broke each of them differently:
// every `--compile` build died with `SyntaxError: Expected double-quoted
// property name in JSON at position 1464` (naming neither the file nor the
// reason), and `am fix` fell back to a null config, resolved the entry to the
// scaffold default and SKIPPED the dependency repair while still printing "Now
// run: deno task dev".
//
// That second one was found, fixed and given a post-mortem — in one module.
// The other ten kept the bug. This pins the fix at the reader all of them now
// share, and covers the case none of them handled at all: a project that uses
// the `.jsonc` extension, which was invisible even with no comment in it.
import { assert, assertEquals, assertThrows } from "@std/assert";
import {
  parseDenoJson,
  readDenoJson,
  readDenoJsonSync,
} from "../src/server/deno-json.ts";
import { join } from "@std/path";

const COMMENTED = `{
  // The relay and the agent share one import map; this alias is why.
  "title": "commented",
  "aioVersion": "v1.0.0-alpha61", // pinned deliberately
  "imports": { "aio": "./dep/aio/mod.ts" }
}`;

async function fixture(files: Record<string, string>): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "aio-jsonc-" });
  for (const [name, body] of Object.entries(files)) {
    await Deno.writeTextFile(join(dir, name), body);
  }
  return dir;
}

Deno.test("a comment in deno.json is read, not a SyntaxError", async () => {
  const dir = await fixture({ "deno.json": COMMENTED });
  try {
    const got = await readDenoJson(dir);
    assertEquals(got?.config.title, "commented");
    assertEquals(got?.config.aioVersion, "v1.0.0-alpha61");
    assertEquals(readDenoJsonSync(dir)?.config.title, "commented");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("deno.jsonc is found — the documented way to ask for comments", async () => {
  const dir = await fixture({ "deno.jsonc": COMMENTED });
  try {
    const got = await readDenoJson(dir);
    assert(got, "a project using the .jsonc extension was invisible entirely");
    assertEquals(got.config.title, "commented");
    assert(got.path.endsWith("deno.jsonc"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("deno.json wins over deno.jsonc, as Deno resolves it", async () => {
  const dir = await fixture({
    "deno.json": `{ "title": "primary" }`,
    "deno.jsonc": `{ "title": "secondary" }`,
  });
  try {
    assertEquals((await readDenoJson(dir))?.config.title, "primary");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("absent and malformed are DIFFERENT facts", async () => {
  // Absent → null, so a caller can fall back deliberately.
  const empty = await Deno.makeTempDir({ prefix: "aio-jsonc-" });
  try {
    assertEquals(await readDenoJson(empty), null);
  } finally {
    await Deno.remove(empty, { recursive: true });
  }

  // Malformed → throws, naming the file and the likely cause. Collapsing this
  // into "absent" is what silently skipped a repair and reported success.
  const bad = await fixture({ "deno.json": `{ "title": "x",, }` });
  try {
    const e = await readDenoJson(bad).then(() => null, (e: Error) => e);
    assert(
      e instanceof Error,
      "a broken config must not read as an absent one",
    );
    assert(e.message.includes("deno.json"), `must name the file: ${e.message}`);
    assert(
      e.message.includes("Comments ARE allowed"),
      `must rule out the wrong suspect: ${e.message}`,
    );
  } finally {
    await Deno.remove(bad, { recursive: true });
  }

  // …and the same for the pure parser.
  assertThrows(() => parseDenoJson("[1,2,3]", "x/deno.json"), Error);
});

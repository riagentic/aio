// `am pin <ver>` on a deno.json whose `aioVersion` member is not alone on its
// own line: the pin must MOVE, not be shadowed.
//
// `writeDenoJsonPin` found the member with a line-anchored regex, so a compact
// file (`{"aioVersion":"v1.0.20",…}`), a member sharing a line, or one closed
// by `}` on the same line was "not there" — a SECOND `aioVersion` was inserted
// first, and JSON(C)'s last-duplicate-wins kept the OLD pin while `dep/aio`
// was relinked to the new one: success reported, two versions in play. An
// unpinned file whose leading comment held a `{` got the key written INSIDE
// the comment. The writer now scans code (strings/comments masked, depth
// tracked) and reads the pin back before writing.
import "./store-sandbox.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { readPin, writeDenoJsonPin } from "../src/am/am-versions.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function pin(content: string, ref = "v1.0.24") {
  const dir = await tempDir("am-pin-compact-");
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), content);
    await writeDenoJsonPin(dir, ref);
    return {
      out: await Deno.readTextFile(join(dir, "deno.json")),
      pin: await readPin(dir),
    };
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("am pin: a compact deno.json is re-pinned in place", async () => {
  const r = await pin(
    `{"aioVersion":"v1.0.20","imports":{"aio":"./dep/aio/mod.ts"}}\n`,
  );
  assertEquals(r.pin, "v1.0.24");
  assertEquals(
    r.out,
    `{"aioVersion":"v1.0.24","imports":{"aio":"./dep/aio/mod.ts"}}\n`,
  );
});

Deno.test("am pin: aioVersion sharing a line with another key", async () => {
  const r = await pin(
    `{\n  "appId": "x", "aioVersion": "v1.0.20",\n  "tasks": {}\n}\n`,
  );
  assertEquals(r.pin, "v1.0.24");
  assertEquals(
    r.out,
    `{\n  "appId": "x", "aioVersion": "v1.0.24",\n  "tasks": {}\n}\n`,
  );
});

Deno.test("am pin: aioVersion as the last member, `}` on its line", async () => {
  const r = await pin(`{\n  "appId": "x",\n  "aioVersion": "v1.0.20" }\n`);
  assertEquals(r.pin, "v1.0.24");
  assertEquals(r.out, `{\n  "appId": "x",\n  "aioVersion": "v1.0.24" }\n`);
});

Deno.test("am pin: a `{` in a leading comment is not the object", async () => {
  const r = await pin(
    `// app config — see docs {build}\n{\n  "appId": "x"\n}\n`,
  );
  assertEquals(r.pin, "v1.0.24");
  assertEquals(
    r.out,
    `// app config — see docs {build}\n{\n  "aioVersion": "v1.0.24",\n  "appId": "x"\n}\n`,
  );
});

Deno.test("am pin: a nested or commented aioVersion is not the member", async () => {
  const r = await pin(
    `{\n  // "aioVersion": "v0.0.1"\n  "x": { "aioVersion": "keep" },\n  "y": "aioVersion"\n}\n`,
  );
  assertEquals(r.pin, "v1.0.24");
  assertEquals(
    r.out,
    `{\n  "aioVersion": "v1.0.24",\n  // "aioVersion": "v0.0.1"\n  "x": { "aioVersion": "keep" },\n  "y": "aioVersion"\n}\n`,
  );
});

Deno.test("am pin: a file the old writer left with two pins is repaired", async () => {
  const r = await pin(
    `{\n  "aioVersion": "v1.0.22",\n  "a": 1, "aioVersion": "v1.0.20"\n}\n`,
  );
  assertEquals(r.pin, "v1.0.24");
  assertEquals(
    r.out,
    `{\n  "aioVersion": "v1.0.24",\n  "a": 1, "aioVersion": "v1.0.24"\n}\n`,
  );
});

Deno.test("am pin: a non-string aioVersion throws and leaves the file alone", async () => {
  const dir = await tempDir("am-pin-compact-");
  try {
    const raw = `{ "aioVersion": null }\n`;
    await Deno.writeTextFile(join(dir, "deno.json"), raw);
    await assertRejects(
      () => writeDenoJsonPin(dir, "v1.0.24"),
      Error,
      "not a string",
    );
    assertEquals(await Deno.readTextFile(join(dir, "deno.json")), raw);
  } finally {
    await dropTempDir(dir);
  }
});

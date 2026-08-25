// A path pin is per-MACHINE. `am pin /abs/checkout` used to write
// `aioVersion: "path:/…"` into the committed deno.json, pinning every clone to
// a directory that exists on one laptop. It lives in the git-ignored
// `.aio/pin.local` now; THE reader (`readFrameworkPin`) prefers it, and a
// legacy in-file `path:` value is still honoured.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { readPin, writePin } from "../src/am/am-versions.ts";
import {
  LOCAL_PIN_FILE,
  readFrameworkPin,
  readFrameworkPinSync,
} from "../src/server/deno-json.ts";

async function app(denoJson: Record<string, unknown>, gitignore?: string) {
  const dir = await Deno.makeTempDir({ prefix: "aio-localpin-" });
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify(denoJson, null, 2) + "\n",
  );
  if (gitignore !== undefined) {
    await Deno.writeTextFile(join(dir, ".gitignore"), gitignore);
  }
  const checkout = join(dir, "checkout");
  await Deno.mkdir(checkout);
  await Deno.writeTextFile(join(checkout, "mod.ts"), "export {};\n");
  return {
    dir,
    checkout,
    [Symbol.asyncDispose]: () => Deno.remove(dir, { recursive: true }),
  };
}

Deno.test("writePin(path:): writes .aio/pin.local, deno.json untouched, .gitignore covers .aio/", async () => {
  await using a = await app({ aioVersion: "v1.0.0-alpha66" }, "dist/\n");
  const before = await Deno.readTextFile(join(a.dir, "deno.json"));
  const wrote = await writePin(a.dir, `path:${a.checkout}`);
  assertEquals(wrote, { file: LOCAL_PIN_FILE, removedLocal: false });
  assertEquals(
    await Deno.readTextFile(join(a.dir, LOCAL_PIN_FILE)),
    a.checkout + "\n",
  );
  assertEquals(await Deno.readTextFile(join(a.dir, "deno.json")), before);
  assertEquals(
    await Deno.readTextFile(join(a.dir, ".gitignore")),
    "dist/\n.aio/\n",
  );
  // Idempotent on the ignore file.
  await writePin(a.dir, `path:${a.checkout}`);
  assertEquals(
    await Deno.readTextFile(join(a.dir, ".gitignore")),
    "dist/\n.aio/\n",
  );
});

Deno.test("reader: the local override wins over aioVersion, and says where it came from", async () => {
  await using a = await app({ aioVersion: "v1.0.0-alpha66" });
  await writePin(a.dir, `path:${a.checkout}`);
  assertEquals(await readPin(a.dir), `path:${a.checkout}`);
  assertEquals(await readFrameworkPin(a.dir), {
    pin: `path:${a.checkout}`,
    source: "local",
  });
});

Deno.test("reader: a legacy in-file path: value is still read", async () => {
  await using a = await app({ aioVersion: `path:${a_placeholder()}` });
  // rewrite with the real checkout path now that it exists
  await Deno.writeTextFile(
    join(a.dir, "deno.json"),
    JSON.stringify({ aioVersion: `path:${a.checkout}` }),
  );
  assertEquals(readFrameworkPinSync(a.dir), {
    pin: `path:${a.checkout}`,
    source: "deno.json",
  });
});
function a_placeholder(): string {
  return "/nowhere";
}

Deno.test("writePin(release): records aioVersion AND removes the local override, so the release really wins", async () => {
  await using a = await app({ name: "demo" });
  await writePin(a.dir, `path:${a.checkout}`);
  const wrote = await writePin(a.dir, "v1.0.0-alpha67");
  assertEquals(wrote, { file: "deno.json", removedLocal: true });
  assertEquals(await readPin(a.dir), "v1.0.0-alpha67");
  let gone = false;
  try {
    await Deno.stat(join(a.dir, LOCAL_PIN_FILE));
  } catch {
    gone = true;
  }
  assert(gone, "the override must not outlive a release pin");
});

Deno.test("reader: a dangling local override FAILS LOUDLY instead of falling back", async () => {
  await using a = await app({ aioVersion: "v1.0.0-alpha67" });
  await Deno.mkdir(join(a.dir, ".aio"));
  await Deno.writeTextFile(join(a.dir, LOCAL_PIN_FILE), "/no/such/checkout\n");
  assertThrows(() => readFrameworkPinSync(a.dir), Error, "pin.local");
});

Deno.test("reader: unpinned is null/null", async () => {
  await using a = await app({ name: "demo" });
  assertEquals(await readFrameworkPin(a.dir), { pin: null, source: null });
});

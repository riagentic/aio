// One identity: the name a release is SIGNED for must be the id the artifact
// RUNS as — every install compares the two and refuses a mismatch.
//
// `ship` names a release from deno.json (appId > title > name); the running app
// takes `aio.run({ appId })` from code first. An app with `appId: "x"` in code
// and only `"title": "X Wallet"` in deno.json published every release as
// `x-wallet`, and every install refused every one — with nothing said at
// publish time. The artifact now reports the id it runs as beside its data
// contract, and `shipApp` refuses the mismatch on the publisher's machine.
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { shipApp } from "../src/build/ship.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

/** A project whose deno.json says `title: "X Wallet"`, and a real aio app in
 *  it whose code says `aio.run({ appId: "x" })`, spawnable as a binary. */
async function project(): Promise<{ dir: string; bin: string }> {
  const dir = await tempDir("aio-ship-identity-");
  const repo = new URL("../", import.meta.url).pathname;
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ title: "X Wallet", version: "1.0.0" }),
  );
  await Deno.mkdir(join(dir, "src"), { recursive: true });
  await Deno.writeTextFile(join(dir, "src", "a.ts"), `fetch("x");`);
  const entry = join(dir, "app.ts");
  await Deno.writeTextFile(
    entry,
    `import { aio, cell } from "${repo}mod.ts";\n` +
      `const notes = cell("notes", { version: 1, state: { n: 0 }, methods: {} });\n` +
      `await aio.run({ cells: [notes], appId: "x", libraryMode: true, ` +
      `baseDir: "${dir}" });\n`,
  );
  const bin = join(dir, "app.bin");
  await Deno.writeTextFile(
    bin,
    `#!/bin/sh\nexec "${Deno.execPath()}" run -A --config "${repo}deno.json" ` +
      `"${entry}" "$@"\n`,
  );
  await Deno.chmod(bin, 0o755);
  return { dir, bin };
}

async function inProject<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const cwd = Deno.cwd();
  Deno.chdir(dir);
  try {
    return await fn();
  } finally {
    Deno.chdir(cwd);
  }
}

Deno.test({
  name:
    "shipApp: refuses a release named for an id the artifact does not run as",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const { dir, bin } = await project();
    try {
      await inProject(dir, async () => {
        // deno.json → "x-wallet"; the artifact → "x". Refused, and taught.
        const e = await assertRejects(() =>
          shipApp({ binaryPath: bin, version: "1.0.0" })
        );
        const msg = (e as Error).message;
        assertStringIncludes(msg, 'runs as "x"');
        assertStringIncludes(msg, 'signed for "x-wallet"');
        assertStringIncludes(msg, '"appId": "x"');
        assertStringIncludes(msg, "--name=x");
        // An explicit --name that disagrees is refused the same way.
        const e2 = await assertRejects(() =>
          shipApp({ binaryPath: bin, version: "1.0.0", name: "other" })
        );
        assertStringIncludes((e2 as Error).message, 'runs as "x"');
        // …and one that agrees publishes.
        const m = await shipApp({
          binaryPath: bin,
          version: "1.0.0",
          name: "x",
        });
        assertEquals(m.name, "x");
        assertEquals(m.data?.cells.notes, { version: 1, migratesFrom: 1 });
      });
    } finally {
      await dropTempDir(dir);
    }
  },
});

Deno.test({
  name: "shipApp: an older artifact that reports no id is published as before",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    const { dir } = await project();
    try {
      // A pre-1.0.13 binary: the contract on stdout, no identity marker.
      const old = join(dir, "old.bin");
      await Deno.writeTextFile(
        old,
        `#!/bin/sh\necho '{"schema":1,"cells":{}}'\n`,
      );
      await Deno.chmod(old, 0o755);
      const m = await inProject(
        dir,
        () => shipApp({ binaryPath: old, version: "1.0.0" }),
      );
      assertEquals(m.name, "x-wallet");
    } finally {
      await dropTempDir(dir);
    }
  },
});

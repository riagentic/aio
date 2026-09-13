// `am add server <name>` — the module AND the line that makes it exist.
//
// Scaffolding the file is the easy half. A `serverFns` namespace that nothing
// imports is registered NOWHERE, so calling it from a cell fails at runtime
// with "unknown namespace" — and the author has a file that looks finished.
// The wiring is the part a generator is actually for.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = new URL("..", import.meta.url).pathname;

async function am(args: string[], cwd: string) {
  const p = await new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", `${REPO}src/am.ts`, ...args],
    cwd,
    env: { AIO_APPS_DIR: `${cwd}/.aio-home` },
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: p.code,
    out: new TextDecoder().decode(p.stdout),
    err: new TextDecoder().decode(p.stderr),
  };
}

Deno.test("it writes the module and imports it from the app entry", async () => {
  const dir = await tempDir("am-add-server-");
  try {
    await Deno.mkdir(`${dir}/src`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/src/app.ts`,
      `import { aio } from "aio";\nawait aio.run();\n`,
    );
    const r = await am(["add", "server", "billing"], dir);
    assertEquals(r.code, 0, r.out + r.err);

    const mod = await Deno.readTextFile(`${dir}/src/server/billing.server.ts`);
    assertStringIncludes(mod, 'serverFns("billing"');
    // From "aio" — `aio/server` does not export serverFns (the generated
    // import resolving is pinned in am-add-server-imports-resolve.test.ts).
    assertStringIncludes(mod, 'import { serverFns } from "aio";');
    // The `.server.ts` NAME is the convention aio enforces — a generator that
    // produced `billing.ts` would put the keys in the browser bundle.
    assert(mod.includes("server-only") || mod.includes(".server.ts"));

    const entry = await Deno.readTextFile(`${dir}/src/app.ts`);
    assertStringIncludes(
      entry,
      'import "./server/billing.server.ts";',
      "the module was scaffolded and never imported — which registers it " +
        "nowhere, and is the half that matters",
    );
    // Piped stdout is JSON mode — which is what a script and an agent see,
    // and `wired` is the fact that matters: the file alone is the easy half.
    assertEquals(JSON.parse(r.out).wired, "src/app.ts");
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("no app entry is SAID, not silently skipped", async () => {
  // A file that looks finished and is wired to nothing is worse than no file.
  const dir = await tempDir("am-add-server-noentry-");
  try {
    await Deno.mkdir(`${dir}/src`, { recursive: true });
    const r = await am(["add", "server", "billing"], dir);
    assertEquals(r.code, 0);
    assertEquals(
      JSON.parse(r.out).wired,
      null,
      "`wired: null` is how a script learns the module is registered nowhere " +
        "— a file that looks finished and is wired to nothing is worse than " +
        "no file",
    );
    // The module is still written — the author asked for it, and they can
    // import it themselves.
    await Deno.stat(`${dir}/src/server/billing.server.ts`);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("it is idempotent: a second run does not duplicate the import", async () => {
  const dir = await tempDir("am-add-server-twice-");
  try {
    await Deno.mkdir(`${dir}/src`, { recursive: true });
    await Deno.writeTextFile(`${dir}/src/app.ts`, `await 1;\n`);
    await am(["add", "server", "billing"], dir);
    await Deno.remove(`${dir}/src/server/billing.server.ts`);
    await am(["add", "server", "billing"], dir);
    const entry = await Deno.readTextFile(`${dir}/src/app.ts`);
    const n = entry.split('import "./server/billing.server.ts";').length - 1;
    assertEquals(n, 1, `the import was added ${n} times`);
  } finally {
    await dropTempDir(dir);
  }
});

Deno.test("the name is validated — it becomes a PATH and an IDENTIFIER", async () => {
  const dir = await tempDir("am-add-server-bad-");
  try {
    await Deno.mkdir(`${dir}/src`, { recursive: true });
    for (const bad of ["../etc/x", "a b", "1st"]) {
      const r = await am(["add", "server", bad], dir);
      assertEquals(r.code, 1, `"${bad}" was accepted`);
      assert((r.out + r.err).includes("invalid name"), r.out + r.err);
    }
  } finally {
    await dropTempDir(dir);
  }
});

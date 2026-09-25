// A reducer's FIRST `import()` of a module must not leak its boot's scope into
// the next test (field report, a desktop wallet app on v1.0.11-beta: 19 of 105
// tests failing — every testUI after the first in a file).
//
// Deno pins the process's AMBIENT async context — the one a callback Rust
// starts runs in, the next `Deno.test` body included — to the context a module
// is first evaluated in, and never puts it back (measured, Deno 2.9.7). A
// reducer runs inside its boot's fence (`BootScope`, standalone-air.ts), so a
// fresh `import()` there made that fence every later test body's context, and
// once its test disposed, the next body's first cell call met the dead-boot
// refusal: "dispatched into a torn-down runtime". A module already loaded
// never re-evaluates, so only a FIRST import did it.
//
// The fix: every harness entry sheds the in-process scopes it did not open
// itself (`_shedLeakedScopes`, boot-refusals.ts) — a harness body is never a
// boot's code. The real refusal is untouched: a retired boot's own late call
// runs in ITS context, not a harness body's (tests/bootcells-generation-
// fence.test.ts).
//
// The child is a test file of its own: the leak crosses from one Deno.test to
// the next, which no single test body can show.
import { assert } from "@std/assert";
import { homeStoreEnv } from "../src/testing/test-strict.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

/** Run one child suite with fresh modules `names` in a temp dir; assert it
 *  passed `passed` tests and nothing was refused as `refusal` says. */
async function assertChildSuitePasses(
  suite: string,
  names: string[],
  passed: number,
  refusal: RegExp,
): Promise<void> {
  const root = await tempDir("aio-bsfi-");
  try {
    const mods = `${root}/mods`;
    await Deno.mkdir(mods, { recursive: true });
    for (const m of names) {
      await Deno.writeTextFile(`${mods}/${m}.ts`, "export const x = 1;\n");
    }
    for (const d of ["apps", "run"]) {
      await Deno.mkdir(`${root}/${d}`, { recursive: true, mode: 0o700 });
    }
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "test",
        "-A",
        "--no-check",
        "--config",
        new URL("../deno.json", import.meta.url).pathname,
        new URL(`./fixtures/boot-scope-first-import/${suite}`, import.meta.url)
          .pathname,
      ],
      env: {
        ...homeStoreEnv(`${root}/stores`),
        AIO_APPS_DIR: `${root}/apps`,
        XDG_RUNTIME_DIR: `${root}/run`,
        AIO_FRESH_MODULE_DIR: mods,
        NO_COLOR: "1",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
    assert(
      out.success &&
        new RegExp(`ok \\| ${passed} passed \\| 0 failed`).test(text),
      `child suite failed (exit ${out.code}):\n${text.slice(-4000)}`,
    );
    assert(
      !refusal.test(text),
      `a live test's body was refused as another scope's code:\n${
        text.slice(-4000)
      }`,
    );
  } finally {
    await dropTempDir(root);
  }
}

Deno.test({
  name:
    "boot scope: a reducer's first import() of a module never leaks its boot into the next test (testUI, testCell, bootCells)",
  sanitizeResources: false, // aio-ok: the child deno test process owns its resources; this test only waits for its exit
  fn: () =>
    assertChildSuitePasses("suite.tsx", ["ui", "cell", "boot"], 7, /torn-down/),
});

Deno.test({
  name:
    "worker scope: a worker cell's first import() of a module never makes the next test's body read as the worker's code",
  sanitizeResources: false, // aio-ok: the child deno test process owns its resources; this test only waits for its exit
  fn: () =>
    assertChildSuitePasses(
      "worker-suite.ts",
      ["worker"],
      2,
      /bsfiw_heavy" runs in|called while the app is still booting|not bound/,
    ),
});

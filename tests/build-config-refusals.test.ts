// Build config that is wrong, said once, up front, by name.
//
// A deno.json `entry` that names no file. A compiled target used to bundle,
// stage, and then die on deno compile's raw `TS2307 Cannot find module` under
// a hint about server-only imports; the web target built green and silently
// baked none of the entry's aio.run() options. Both now say so, by name.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir } from "../src/testing/temp-dir.ts";
import { makeApp, task } from "./e2e-app-harness.ts";

async function withConfig(
  edit: (cfg: Record<string, unknown>) => void,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await makeApp("counter", "build-config-");
  try {
    const path = join(dir, "deno.json");
    const cfg = JSON.parse(await Deno.readTextFile(path));
    edit(cfg);
    await Deno.writeTextFile(path, JSON.stringify(cfg, null, 2));
    await fn(dir);
  } finally {
    await dropTempDir(dir);
  }
}

const withMissingEntry = (fn: (dir: string) => Promise<void>) =>
  withConfig((cfg) => cfg.entry = "src/nope.ts", fn);

Deno.test("build: a compiled target with a missing entry is refused by name, before deno compile", async () => {
  await withMissingEntry(async (dir) => {
    const r = await task(dir, "build", "--targets=server");
    const all = r.out + r.err;
    assertEquals(r.code, 1, all);
    assertStringIncludes(all, `entry not found: ${join(dir, "src/nope.ts")}`);
    assertStringIncludes(all, `deno.json "entry"`);
    assert(!all.includes("TS2307"), all);
  });
});

Deno.test("build: the web target with a missing entry builds and SAYS no aio.run() options were baked", async () => {
  await withMissingEntry(async (dir) => {
    const r = await task(dir, "build", "--targets=web");
    const all = r.out + r.err;
    assertEquals(r.code, 0, all);
    assertStringIncludes(
      all,
      "the entry src/nope.ts does not exist — no aio.run() options",
    );
  });
});

// It was refused only inside the target, as an uncaught stack trace.
Deno.test("build: a build.minify that is not a boolean is refused before any target, without a stack trace", async () => {
  await withConfig(
    (cfg) => (cfg.build as Record<string, unknown>).minify = "no",
    async (dir) => {
      const r = await task(dir, "build", "--targets=web");
      const all = r.out + r.err;
      assertEquals(r.code, 1, all);
      assertStringIncludes(
        all,
        'build.minify is "no" — it must be true or false',
      );
      assert(!all.includes("Uncaught"), all);
      assert(!all.includes("▶ web"), all);
    },
  );
});

// A per-target `ui` reached the build as `--ui=`, and its refusal blamed that
// flag — one nobody typed.
Deno.test("build: a per-target ui that names no file is refused as the deno.json key it is", async () => {
  await withConfig(
    (cfg) =>
      (cfg.build as Record<string, unknown>).targets = {
        web: { ui: "Nope.tsx" },
      },
    async (dir) => {
      const r = await task(dir, "build");
      const all = r.out + r.err;
      assertEquals(r.code, 1, all);
      assertStringIncludes(all, "build.targets ui not found");
      assertStringIncludes(all, `web → ${join(dir, "src", "Nope.tsx")}`);
      assert(!all.includes("--ui="), all);
    },
  );
});

// `"toString" in TARGETS` is true: the label passed the unknown-target check
// and died on `spec.flags is not iterable`.
Deno.test("build: an Object.prototype name is an unknown target, not a crash", async () => {
  await withConfig(() => {}, async (dir) => {
    const r = await task(dir, "build", "--targets=toString");
    const all = r.out + r.err;
    assertEquals(r.code, 1, all);
    assertStringIncludes(all, "unknown target(s): toString");
    assert(!all.includes("Uncaught"), all);
  });
});

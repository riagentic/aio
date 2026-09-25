// Artifact-level half of build-machine-bound-imports.test.ts: a REAL build of
// an app whose deno.json maps `aio*` to ABSOLUTE paths must say so. Measured
// on Deno 2.9.7: that binary loads the framework from the absolute path at run
// time, so it runs on the build machine and dies with `Module not found`
// anywhere else — and the build printed ✓ with no word about it.
//
// A real `deno compile` (~1 min), so gated with the other artifact tests:
// AIO_BUILD_E2E=1 (`deno task test:build`).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { buildFlags, makeApp, REPO_ROOT } from "./e2e-app-harness.ts";
import { dropTempDir, keepTempDir } from "../src/testing/temp-dir.ts";

const GATE = Deno.env.get("AIO_BUILD_E2E") === "1";

Deno.test({
  name:
    "build e2e: an absolute-path import map is warned about, naming key, value and the relative fix",
  ignore: !GATE,
  fn: async () => {
    const dir = keepTempDir(await makeApp("counter", "build-e2e-abs-map-"));
    try {
      const path = join(dir, "deno.json");
      const cfg = JSON.parse(await Deno.readTextFile(path));
      for (
        const [k, v] of Object.entries(cfg.imports as Record<string, string>)
      ) {
        if (v.startsWith("./dep/aio/")) {
          cfg.imports[k] = `${REPO_ROOT}/${v.slice("./dep/aio/".length)}`;
        }
      }
      assertEquals(cfg.imports["aio"], `${REPO_ROOT}/mod.ts`);
      // Framework files OUTSIDE the project resolve their bare deps through
      // THIS map, at the framework's exact pins (a relative dep/aio link needs
      // neither) — so the build succeeds and the warning is what is tested.
      const repoMap = JSON.parse(
        await Deno.readTextFile(join(REPO_ROOT, "deno.json")),
      ).imports as Record<string, string>;
      for (
        const k of ["@std/jsonc", "@std/yaml", ...Object.keys(cfg.imports)]
      ) {
        if (!k.startsWith("aio") && repoMap[k]) cfg.imports[k] = repoMap[k];
      }
      await Deno.writeTextFile(path, JSON.stringify(cfg, null, 2));

      const r = await buildFlags(dir, "--compile");
      const err = r.err.replace(/\s+/g, " "); // the block renderer wraps
      // Not a refusal: the artifact does run on this machine.
      assertEquals(r.code, 0, r.out + r.err);
      assertStringIncludes(err, `imports["aio"] = "${REPO_ROOT}/mod.ts"`);
      assertStringIncludes(err, "bind the binary to THIS machine");
      assertStringIncludes(err, "./dep/aio/");
      assert(/imports\["aio"\]: "(\.\.\/)+/.test(err), r.err);
    } finally {
      await dropTempDir(dir);
    }
  },
});

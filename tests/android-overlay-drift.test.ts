// An `android/` overlay file freezes aio's template at the day it was copied
// (field reports: seven releases of MainActivity.kt fixes never reached two
// APKs, with only `✓ overlay: 4 files` said). The build records the template
// it first saw an overlay replace, and warns once that template moves on.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  checkOverlayDrift,
  OVERLAY_RECORD,
  overlayDrift,
} from "../src/build/android-overlay-drift.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MA = "app/src/main/java/aio/app/MainActivity.kt";

Deno.test("overlayDrift: first sight records, a moved template warns, a re-based overlay clears", () => {
  const first = overlayDrift(
    {},
    { [MA]: { template: "t1", overlay: "o1" } },
    "1.0.12",
  );
  assertEquals(first.warnings, []);
  assertEquals(first.record[MA], {
    template: "t1",
    overlay: "o1",
    aio: "1.0.12",
  });
  // Same template: quiet.
  assertEquals(
    overlayDrift(
      first.record,
      { [MA]: { template: "t1", overlay: "o1" } },
      "1.0.13",
    )
      .warnings,
    [],
  );
  // The template moved, the overlay did not: warned, naming both versions,
  // and the record keeps the old template so every build says it.
  const drift = overlayDrift(
    first.record,
    { [MA]: { template: "t2", overlay: "o1" } },
    "1.0.20",
  );
  assertEquals(drift.warnings.length, 1);
  assert(drift.warnings[0]!.includes(`android/${MA} overlays a template`));
  assert(drift.warnings[0]!.includes("aio 1.0.12 → 1.0.20"));
  assertEquals(drift.record[MA], first.record[MA]);
  // The overlay changed (re-based): recorded afresh, quiet.
  const rebased = overlayDrift(
    drift.record,
    { [MA]: { template: "t2", overlay: "o2" } },
    "1.0.20",
  );
  assertEquals(rebased.warnings, []);
  assertEquals(rebased.record[MA], {
    template: "t2",
    overlay: "o2",
    aio: "1.0.20",
  });
});

Deno.test("checkOverlayDrift: on disk — recorded in .aio/, only for files that replace a template", async () => {
  const root = await tempDir("aio-overlay-drift-");
  try {
    await Deno.mkdir(join(root, "android", "app/src/main/java/aio/app"), {
      recursive: true,
    });
    await Deno.writeTextFile(join(root, "android", MA), "class Mine");
    await Deno.writeTextFile(join(root, "android", "extra.kt"), "x");
    const overlaid = [MA, "extra.kt"];
    assertEquals(
      await checkOverlayDrift(root, overlaid, { [MA]: "v1" }, "1.0.12"),
      [],
    );
    const rec = JSON.parse(await Deno.readTextFile(join(root, OVERLAY_RECORD)));
    assertEquals(Object.keys(rec), [MA]);
    const w = await checkOverlayDrift(root, overlaid, { [MA]: "v2" }, "1.0.20");
    assertEquals(w.length, 1, String(w));
    assert(w[0]!.includes("re-base it"), w[0]);
    // Re-based: quiet from then on.
    await Deno.writeTextFile(join(root, "android", MA), "class Mine2");
    assertEquals(
      await checkOverlayDrift(root, overlaid, { [MA]: "v2" }, "1.0.20"),
      [],
    );
  } finally {
    await dropTempDir(root);
  }
});

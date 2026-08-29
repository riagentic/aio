// A data contract with no cells has TWO meanings, and they are opposite.
//
// `cells: {}` on the wire is both "this app persists nothing" (fine) and
// "this app persists, and promised nothing about it" (a release that cannot
// read a user's existing store installs cleanly over it). A cell reaches the
// contract only by declaring `version` or an `onMigrate`, so an app whose
// cells declare neither publishes the dangerous empty one.
//
// A field report (dm) published EVERY release that way. `aio ship`'s CLI does
// print the count — but a repo with two apps must call `shipApp()` directly
// (the fleet builder reads one `entry`), and the function said nothing. The
// count was in the wrapper, not in the thing that builds the manifest.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { unpublishableReason } from "../src/server/app-version.ts";

// ── the refusal names a remedy ITS READER can perform ────────────────
//
// The message hardcoded `--allow-dirty`, a flag on the `ship` CLI. A
// programmatic caller has `allowDirty: true` and its own wrapper may expose
// no flag at all — so the refusal named a fix that changed nothing when
// typed, and read as a dead end.
Deno.test("unpublishable: the escape is the caller's own spelling", () => {
  const dirty = "1.2.3-dirty.abcd1234";
  assertStringIncludes(
    unpublishableReason(dirty, "allowDirty: true")!,
    "allowDirty: true",
  );
  assertStringIncludes(
    unpublishableReason(dirty, "--allow-dirty")!,
    "--allow-dirty",
  );
  // The CLI spelling stays the default, so every existing caller reads as before.
  assertStringIncludes(unpublishableReason(dirty)!, "--allow-dirty");
  assertEquals(unpublishableReason("1.2.3"), null);
  assertEquals(unpublishableReason("1.2.3", "anything"), null);
});

// ── the binary reports what the contract cannot say ──────────────────
Deno.test("a persisting app prints its cell count beside the contract", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-contract-" });
  try {
    const mod = new URL("../mod.ts", import.meta.url).href;
    await Deno.writeTextFile(
      `${dir}/app.ts`,
      `import { aio, cell } from ${JSON.stringify(mod)};\n` +
        `const notes = cell("notes", { state: { items: [] }, methods: {} });\n` +
        `const scratch = cell("scratch", {\n` +
        `  state: { n: 0 }, persist: "none", methods: {},\n` +
        `});\n` +
        `await aio.run({ cells: [notes, scratch], persist: false });\n`,
    );
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        new URL("../deno.json", import.meta.url).pathname,
        `${dir}/app.ts`,
        "--aio-data-contract",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stdout = new TextDecoder().decode(out.stdout);
    const stderr = new TextDecoder().decode(out.stderr);

    // stdout stays PURE JSON — `aio ship` and `updates-rebuild` parse it.
    const contract = JSON.parse(stdout) as { cells: Record<string, unknown> };
    assertEquals(
      Object.keys(contract.cells).length,
      0,
      "neither cell declared a version, so the contract is empty — which is " +
        "exactly the case the marker exists to disambiguate",
    );

    // …and the count that tells the two empty contracts apart is on stderr.
    const m = /^\[aio\] persisting-cells: (\d+)$/m.exec(stderr);
    assert(m, `no persisting-cells marker on stderr:\n${stderr.slice(-600)}`);
    assertEquals(
      m[1],
      "1",
      '`persist: "none"` does not reach the store and must not be counted',
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

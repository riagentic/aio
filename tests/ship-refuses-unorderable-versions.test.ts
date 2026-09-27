// Bug hunt r3 (build/updates): `shipApp` signs a `minFrom` that no client can
// order. ship.ts says identity fields are refused "at the PRODUCER, not only at
// the consumer … so a bad [value] fails on the publisher's machine instead of
// on every user's" — but `minFrom` is never checked there. The client
// (`decide`, updates-core.ts) then refuses EVERY install of the release with
// "minFrom … is not a version number … Fix: re-publish with `aio ship`" —
// which is exactly the command that signed it.
import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { shipApp } from "../src/build/ship.ts";
import { decide } from "../src/server/updates-core.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function project(): Promise<{ root: string; bin: string }> {
  const root = await tempDir("aio-ship-");
  await Deno.writeTextFile(
    join(root, "deno.json"),
    JSON.stringify({ appId: "wallet", entry: "src/app.ts" }),
  );
  await Deno.mkdir(join(root, "src"));
  await Deno.writeTextFile(join(root, "src/app.ts"), "export const x = 1;\n");
  const bin = join(root, "wallet");
  // ELF magic — a recognisable program for artifactFormat.
  await Deno.writeFile(
    bin,
    new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]),
  );
  return { root, bin };
}

Deno.test("hunt-r3 build: shipApp refuses an unorderable minFrom at the producer", async () => {
  const { root, bin } = await project();
  const cwd = Deno.cwd();
  Deno.chdir(root);
  try {
    // Sanity: what a client does with such a release — refuse it.
    const m = await shipApp({
      binaryPath: bin,
      version: "1.2.0",
      minFrom: "1.1.x",
      noData: true,
      channel: "prod",
      out: join(root, "probe.ship.json"),
    }).catch((e) => e as Error);
    if (!(m instanceof Error)) {
      const verdict = decide({
        current: "1.1.5",
        manifest: m,
        local: { schema: 1, cells: {} },
        canInstall: [m.target],
      });
      // Documents the consequence: every client refuses this signed release.
      assertEquals(verdict.kind, "refused");
    }
    await assertRejects(
      () =>
        shipApp({
          binaryPath: bin,
          version: "1.2.0",
          minFrom: "1.1.x",
          noData: true,
          channel: "prod",
        }),
      Error,
      "minFrom",
    );
  } finally {
    Deno.chdir(cwd);
    await dropTempDir(root);
  }
});

// Same hole for `version` itself: SAFE_TOKEN is a CHARSET check, so
// `--version=latest` / `--version=nightly` is signed and published, and every
// client answers `refused` ("declares version … which is not a version
// number"). The producer is the one place that can catch it cheaply.
Deno.test("hunt-r3 build: shipApp refuses a version no client can order", async () => {
  const { root, bin } = await project();
  const cwd = Deno.cwd();
  Deno.chdir(root);
  try {
    await assertRejects(
      () =>
        shipApp({
          binaryPath: bin,
          version: "nightly",
          noData: true,
          channel: "prod",
        }),
      Error,
      "version",
    );
  } finally {
    Deno.chdir(cwd);
    await dropTempDir(root);
  }
});

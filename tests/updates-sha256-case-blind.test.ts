// A manifest may state its digest in UPPERCASE — the validator accepts
// `/^[0-9a-f]{64}$/i`, and PowerShell's `Get-FileHash` prints it that way. The
// digests the client computes are lowercase, and every compare was exact: the
// download of a perfectly good artifact was refused ("does not match the
// manifest", naming two identical digests), and a same-version install whose
// digest was measured from disk was offered its own build back as a "rebuild"
// on every check.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { createHash } from "node:crypto";
import { buildShipManifest, type ShipManifest } from "../src/build/ship.ts";
import {
  downloadArtifact,
  verifyDownload,
} from "../src/server/updates-check.ts";
import { decide } from "../src/server/updates-core.ts";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const bytes = new TextEncoder().encode("APP 2.0.0 ".repeat(1000));
const sha = createHash("sha256").update(bytes).digest("hex");

Deno.test("updates: an UPPERCASE manifest digest downloads — the compare is case-blind", async () => {
  const port = freePort();
  const server = Deno.serve(
    { port, hostname: "127.0.0.1", onListen: () => {} },
    () => new Response(bytes),
  );
  try {
    const dir = await tempDir("aio-upd-shacase-");
    const dest = join(dir, "app.new");
    const r = await downloadArtifact({
      url: `http://127.0.0.1:${port}/app`,
      dest,
      expectSha256: sha.toUpperCase(),
      expectSize: bytes.byteLength,
    });
    assert(
      r.ok,
      `the same digest in another case must verify: ${JSON.stringify(r)}`,
    );
    assertEquals(await Deno.readFile(dest), bytes);
  } finally {
    await server.shutdown();
  }
});

Deno.test("updates: an UPPERCASE manifest digest of the RUNNING build is not a rebuild offer", () => {
  const m = {
    manifestVersion: 1,
    name: "app",
    version: "2.0.0",
    channel: "prod",
    target: "binary",
    platform: { os: "linux", arch: "x86_64" },
    releasedAt: "2026-08-08T00:00:00.000Z",
    sha256: sha.toUpperCase(),
    size: bytes.byteLength,
  } as unknown as ShipManifest;
  const d = decide({
    current: "2.0.0",
    manifest: m,
    local: { schema: 1, cells: {}, installedSha256: sha },
    canInstall: ["binary"],
  });
  assertEquals(
    d.kind,
    "current",
    `the installed bytes ARE the release: ${JSON.stringify(d)}`,
  );
});

Deno.test("updates: verifyDownload accepts an UPPERCASE digest of the same bytes", async () => {
  const dir = await tempDir("aio-upd-shacase-verify-");
  const file = join(dir, "artifact");
  await Deno.writeFile(file, bytes);
  const m = await buildShipManifest({
    name: "app",
    version: "2.0.0",
    binary: bytes,
    sources: [],
  });
  const upper = { ...m, sha256: m.sha256.toUpperCase() };
  const v = await verifyDownload(file, upper, { allowUnsigned: true });
  assert(v.ok, `the staged bytes match the manifest: ${v.reason}`);
});

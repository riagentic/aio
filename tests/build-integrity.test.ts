// build-integrity — SHA-256 verification of fetched build sources (CDN /
// MITM / DNS-hijack guard). A silent no-op here would disable the control, so
// pin: first fetch records, matching content passes, changed content throws.
// The module keys its state file off Deno.cwd(); we run in a temp cwd and
// restore it so the repo's own .aio-integrity.json is never touched.
import { assert, assertRejects } from "@std/assert";

Deno.test("verifyIntegrity: record-first, match-passes, mismatch-throws", async () => {
  const origCwd = Deno.cwd();
  const tmp = await Deno.makeTempDir({ prefix: "aio-integrity-" });
  Deno.chdir(tmp);
  try {
    // Fresh module instance so its cwd-derived state file points at tmp.
    const { verifyIntegrity } = await import(
      `../src/build/build-integrity.ts#${crypto.randomUUID()}`
    );
    const url = "https://cdn.example/aio/mod.ts";

    // First fetch: records the hash, no throw.
    await verifyIntegrity(url, "export const x = 1;");
    // The integrity map is now on disk.
    const saved = JSON.parse(
      await Deno.readTextFile(`${tmp}/.aio-integrity.json`),
    );
    assert(saved[url], "hash recorded on first fetch");

    // Same content on a later build: passes.
    await verifyIntegrity(url, "export const x = 1;");

    // Tampered content: throws loudly (the whole point of the control).
    await assertRejects(
      () => verifyIntegrity(url, "export const x = 1; /* injected */"),
      Error,
      "Integrity check failed",
    );
  } finally {
    Deno.chdir(origCwd);
    await Deno.remove(tmp, { recursive: true });
  }
});

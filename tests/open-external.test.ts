// openExternal — the exported per-OS desktop launcher (a field report: three
// apps re-derived the open/start/xdg-open ternary; two internal copies had
// already drifted apart on Windows). Spawning a real desktop handler is not
// CI-testable; the contract that is: bad input fails loud, and the symbol is
// on the server-only surface.
import { assertRejects } from "@std/assert";
import { openExternal } from "../src/server/open-external.ts";

Deno.test("openExternal: empty target rejects loudly", async () => {
  await assertRejects(() => openExternal(""), Error, "non-empty");
});

Deno.test("openExternal: exported from aio/server", async () => {
  const entry = await import("../src/server-entry.ts");
  if (typeof entry.openExternal !== "function") {
    throw new Error("aio/server must export openExternal");
  }
});

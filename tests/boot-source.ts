// The boot's source, for the tests that check its shape: `aio.ts` and the
// steps `_runPhases` calls out to (src/server/boot-*.ts). A moved step reads
// the boot's locals through `ctx.` (boot-ctx.ts) — a pattern on one of them
// allows that prefix. The steps come first, so a search for a function finds
// its body, not the stub in aio.ts that forwards to it.
import { fromFileUrl } from "@std/path";

const REPO = fromFileUrl(new URL("../", import.meta.url));

/** The files the boot is written in, steps first. */
export const BOOT_FILES = [
  "src/server/boot-config.ts",
  "src/server/boot-storage.ts",
  "src/server/boot-dispatch.ts",
  "src/server/boot-transport.ts",
  "src/server/boot-ctx.ts",
  "src/server/aio.ts",
] as const;

/** Every boot file's text, joined. */
export async function bootSource(): Promise<string> {
  const parts = await Promise.all(
    BOOT_FILES.map((f) => Deno.readTextFile(REPO + f)),
  );
  return parts.join("\n");
}

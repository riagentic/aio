// `processStartEpoch` asks `ps` for `lstart` under TZ=UTC and parses it as UTC.
//
// The two halves only agree while BOTH say UTC: `ps` prints lstart in the
// zone its environment names, and `parseLstartUtc` reads it as UTC. Drop or
// change the `TZ: "UTC"` and an owner read from Auckland is 12 h off — a live
// app judged recycled, and a second instance takes its state.db. The real-`ps`
// check beside it (lock-identity-print.test.ts) allows a 24 h tolerance, so
// it cannot see that. This stub `ps` prints one fixed instant in whatever TZ
// it is handed, from a test process that itself sits in Pacific/Auckland: only
// an exact UTC request reads back the exact second.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  processStartEpoch,
  PS_TIMEOUT,
} from "../src/server/single-instance-lock.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const AT = 1790150137; // Wed Sep 23 07:55:37 2026 UTC — 19:55:37 in Auckland

Deno.test({
  name:
    "processStartEpoch: lstart is asked for in UTC — exact to the second from any reader's zone",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await tempDir("ps-tz-");
    const was = { ...PS_TIMEOUT };
    const tz = Deno.env.get("TZ");
    try {
      const fake = join(dir, "ps");
      // GNU date takes `-d @N`, BSD date `-r N`; both honour $TZ and LC_ALL.
      Deno.writeTextFileSync(
        fake,
        `#!/bin/sh\nif date -d @0 >/dev/null 2>&1; then\n` +
          `  exec date -d @${AT} '+%a %b %e %H:%M:%S %Y'\nfi\n` +
          `exec date -r ${AT} '+%a %b %e %H:%M:%S %Y'\n`,
      );
      Deno.chmodSync(fake, 0o755);
      PS_TIMEOUT.ps = fake;
      // The reader's own zone is NOT UTC — what `ps` inherits unless told.
      Deno.env.set("TZ", "Pacific/Auckland");
      assertEquals(processStartEpoch(Deno.pid, "darwin"), AT);
    } finally {
      if (tz === undefined) Deno.env.delete("TZ");
      else Deno.env.set("TZ", tz);
      Object.assign(PS_TIMEOUT, was);
      await dropTempDir(dir);
    }
  },
});

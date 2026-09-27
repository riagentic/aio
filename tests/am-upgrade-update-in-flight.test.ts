// `am upgrade` refuses while an in-app update has not proven itself — and a
// marker its build stamped confirmed at a clean exit HAS: refusing it said
// "start the app once" to an app that had already started fine.
import { assertEquals } from "@std/assert";
import { updateInFlight } from "../src/am/am-cmd-remove.ts";
import {
  type PendingUpdate,
  readPending,
  writePending,
} from "../src/server/updates-apply.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const MARKER: PendingUpdate = {
  from: "1.0.0",
  to: "2.0.0",
  previous: "/x.old-1.0.0",
  attempts: 1,
  startedAt: "2026-09-27T00:00:00.000Z",
};

Deno.test("am upgrade: an unproven in-app update is in flight; one stamped confirmed at a clean exit is not, and is cleared", async () => {
  const dir = await tempDir("aio-am-upgrade-");
  try {
    assertEquals(updateInFlight(dir), null);
    writePending(dir, MARKER);
    assertEquals(updateInFlight(dir)?.to, "2.0.0");
    assertEquals(readPending(dir)?.to, "2.0.0", "an unproven marker is kept");
    writePending(dir, { ...MARKER, confirmedAt: "2026-09-27T00:01:00.000Z" });
    assertEquals(updateInFlight(dir), null);
    assertEquals(readPending(dir), null);
  } finally {
    await dropTempDir(dir);
  }
});

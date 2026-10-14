// `am upgrade` refuses while an in-app update has not proven itself — and a
// marker its build stamped confirmed at a clean exit HAS: refusing it said
// "start the app once" to an app that had already started fine.
import "./store-sandbox.ts";
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { oneClickInstall, updateInFlight } from "../src/am/am-cmd-remove.ts";
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

// A running one-click install is refused before the build: found by its
// folder under %LOCALAPPDATA%\aio-sfx, on Windows only.
Deno.test("am upgrade: an app's one-click install is found by its folder — on Windows, and only when it is there", async () => {
  const dir = await tempDir("aio-am-upgrade-oneclick-");
  try {
    const env = (n: string) => n === "LOCALAPPDATA" ? dir : undefined;
    assertEquals(await oneClickInstall("notes", "windows", env), null);
    await Deno.mkdir(join(dir, "aio-sfx", "notes"), { recursive: true });
    assertEquals(
      await oneClickInstall("notes", "windows", env),
      join(dir, "aio-sfx", "notes"),
    );
    assertEquals(await oneClickInstall("notes2", "windows", env), null);
    assertEquals(await oneClickInstall("notes", "linux", env), null);
    assertEquals(
      await oneClickInstall("notes", "windows", () => undefined),
      null,
    );
  } finally {
    await dropTempDir(dir);
  }
});

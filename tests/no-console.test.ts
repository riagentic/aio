// The no-console spawn rule (src/server/no-console.ts): a `--no-terminal` GUI
// exe opened by double-click on Windows has no std handles, so inheriting them
// throws `Invalid handle`. Both production spawns that inherit — the Electron
// window and the update/restart relaunch — retry with the handles discarded.
import { assertEquals, assertThrows } from "@std/assert";
import {
  adoptHiddenConsole,
  spawnInheritingOrNull,
} from "../src/server/no-console.ts";

/** A fake command whose `inherit` spawn fails the way Windows fails it. */
function fakeMake(failInherit: Error | null) {
  const tried: string[] = [];
  const make = (stdio: "inherit" | "null") => {
    tried.push(stdio);
    return {
      spawn: () => {
        if (stdio === "inherit" && failInherit) throw failInherit;
        return { stdio } as unknown as Deno.ChildProcess;
      },
    } as unknown as Deno.Command;
  };
  return { make, tried };
}

const invalidHandle = () =>
  new TypeError("Failed to spawn 'C:\\app\\app.exe': Invalid handle");

Deno.test("no-console: Windows' Invalid handle retries with the handles discarded", () => {
  const { make, tried } = fakeMake(invalidHandle());
  const child = spawnInheritingOrNull(make, "windows");
  assertEquals(tried, ["inherit", "null"]);
  assertEquals((child as unknown as { stdio: string }).stdio, "null");
});

Deno.test("no-console: a console-backed spawn inherits, and never retries", () => {
  const { make, tried } = fakeMake(null);
  spawnInheritingOrNull(make, "windows");
  assertEquals(tried, ["inherit"]);
});

Deno.test("no-console: any other failure is thrown, not retried into silence", () => {
  for (
    const [err, os] of [
      [new Error("Invalid handle"), "windows"], // not the TypeError spawn throws
      [new TypeError("No such file or directory"), "windows"],
      [invalidHandle(), "linux"], // the rule is Windows'
    ] as const
  ) {
    const { make, tried } = fakeMake(err);
    assertThrows(() => spawnInheritingOrNull(make, os));
    assertEquals(tried, ["inherit"]);
  }
});

Deno.test("adoptHiddenConsole: off Windows it does nothing, and it never throws", () => {
  assertEquals(adoptHiddenConsole("linux"), "not-windows");
  assertEquals(adoptHiddenConsole("darwin"), "not-windows");
  // Asked to act as Windows on a machine without kernel32: a reason string,
  // never a throw — boot must go on exactly as before.
  const r = adoptHiddenConsole("windows");
  assertEquals(typeof r, "string");
});

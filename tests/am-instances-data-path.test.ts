// `am instances` must say where the DATA is, not only where the home is.
//
// Three things are spelled like "where this app lives" and only one of them
// moves the database (wallet report §20):
//
//   --home <dir>     addresses an existing instance; moves nothing
//   AIO_APPS_DIR     moves the ROOT that homes resolve under
//   appDir           moves the app's own directory, and the data with it
//
// `AIO_APPS_DIR` therefore *appears* to work — the lock and discovery files
// move, so `am` follows the app — while an `appDir` set in code leaves the
// database exactly where it was. The lock recorded `home` and not the data
// directory, so nothing could show the difference, and the answer was only
// reachable by reading the app's source.
import { assert, assertEquals } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { instances, writeLock } from "../src/server/single-instance-lock.ts";

const REPO = new URL("..", import.meta.url).pathname;

Deno.test("am instances --json reports dataDir, and null when unrecorded", async () => {
  const appsDir = await tempDir("am-instances-data-");
  const prev = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", appsDir);
  try {
    writeLock({
      appId: "with-data",
      pid: Deno.pid,
      port: 1,
      startedAt: Date.now(),
      status: "started",
      cwd: Deno.cwd(),
      home: `${appsDir}/with-data`,
      dataDir: "/somewhere/else/data",
    });
    writeLock({
      appId: "old-lock",
      pid: Deno.pid,
      port: 2,
      startedAt: Date.now(),
      status: "started",
      cwd: Deno.cwd(),
      home: `${appsDir}/old-lock`,
    });

    // The lock round-trips it.
    const all = instances();
    const withData = all.find((i) => i.appId === "with-data");
    const oldLock = all.find((i) => i.appId === "old-lock");
    assert(withData, "the lock with a dataDir was not listed");
    assertEquals(withData!.dataDir, "/somewhere/else/data");
    assertEquals(
      oldLock?.dataDir,
      undefined,
      "a lock written before the field must not grow one from nowhere",
    );

    // And the CLI reports it — always present, never conditional: a field that
    // appears only sometimes is a field a script has to guess about.
    const p = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", `${REPO}src/am.ts`, "instances", "--json"],
      env: { AIO_APPS_DIR: appsDir },
      stdout: "piped",
      stderr: "null",
    }).output();
    const rows = JSON.parse(new TextDecoder().decode(p.stdout)) as {
      appId: string;
      dataDir: string | null;
      home?: string;
    }[];
    const a = rows.find((r) => r.appId === "with-data");
    const b = rows.find((r) => r.appId === "old-lock");
    assertEquals(a?.dataDir, "/somewhere/else/data");
    assert(
      b !== undefined && "dataDir" in b,
      "dataDir must be present on every row — a conditional field is one a " +
        "script cannot rely on",
    );
    assertEquals(b?.dataDir, null);
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    await dropTempDir(appsDir);
  }
});

// `am instances` printed LISTENING `uds` for an app that has a TCP port as
// well (a socket for the window, and `--port` for a browser or `am --port`):
// the column read the socket first and hid the port, so the one number a
// person scans that table for — "which port is this on" — was missing for the
// very app that had one. Both wires are shown when both exist.
import { assert } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { writeLock } from "../src/server/single-instance-lock.ts";
import { cmdInstances } from "../src/am/am-cmd-process.ts";

Deno.test("am instances: LISTENING shows the TCP port AND the socket when an app has both", async () => {
  const appsDir = await tempDir("am-instances-listen-");
  const prev = Deno.env.get("AIO_APPS_DIR");
  Deno.env.set("AIO_APPS_DIR", appsDir); // the lock dir writeLock uses
  const base = {
    pid: Deno.pid,
    startedAt: Date.now(),
    status: "started" as const,
    cwd: Deno.cwd(),
  };
  writeLock({
    ...base,
    appId: "both-wires",
    port: 47391,
    home: `${appsDir}/both-wires`,
    socketPath: `${appsDir}/both.sock`,
  });
  writeLock({
    ...base,
    appId: "uds-only",
    port: 0,
    home: `${appsDir}/uds-only`,
    socketPath: `${appsDir}/only.sock`,
  });
  // The pretty table is what a person reads — rendered in-process, as on a
  // terminal (piped, `am` answers JSON, which names both already).
  const isTerm = Deno.stdout.isTerminal;
  const log = console.log;
  const lines: string[] = [];
  try {
    Deno.stdout.isTerminal = () => true;
    console.log = (...a: unknown[]) => lines.push(...a.map(String));
    try {
      cmdInstances([], {});
    } finally {
      Deno.stdout.isTerminal = isTerm;
      console.log = log;
    }
    const out = lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    const rows = out.split("\n");
    const both = rows.find((l) => l.includes("both-wires"));
    const only = rows.find((l) => l.includes("uds-only"));
    assert(both !== undefined && only !== undefined, out);
    assert(both.includes(":47391"), `the TCP port is shown: ${both}`);
    assert(both.includes("uds"), `the socket is shown too: ${both}`);
    assert(only.includes("uds") && !only.includes(":0"), only);
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    await dropTempDir(appsDir);
  }
});

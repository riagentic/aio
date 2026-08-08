// Client logs go to ONE place — including in prod.
//
// `initClientLog(getLogDir())` used to sit inside `if (!prod)`, but the UDS
// transport writes client log frames regardless (uds.ts). So a prod Electron
// app kept the module default — `".aio/log"`, a CWD-RELATIVE path — and its
// renderer logs landed wherever it happened to be launched from: a fourth
// location, wiped by no policy, and not the one `am log --client` reads
// (`~/.<appId>/logs/client.log`).
import { assert, assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { initClientLog, writeClientLog } from "../src/server/client-log.ts";

const SRC = join(dirname(fromFileUrl(import.meta.url)), "..", "src");

Deno.test("client log: writes land in the directory it was initialised with", async () => {
  const dir = await Deno.makeTempDir({ prefix: "aio-clientlog-" });
  try {
    initClientLog(dir);
    writeClientLog(
      0,
      {
        ts: Date.now(),
        level: "info",
        msg: "hello from the renderer",
      } as Parameters<typeof writeClientLog>[1],
    );
    // The append is fire-and-forget; give it a tick to land.
    await new Promise((r) => setTimeout(r, 100));
    const text = await Deno.readTextFile(join(dir, "client.log"));
    assert(
      text.includes("hello from the renderer"),
      `client.log did not receive the entry: ${text}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("client log: the directory is set on EVERY boot, not only in dev", async () => {
  // A guard on the wiring, because the failure is invisible from inside the
  // module: it happily writes to a relative path and reports success.
  const src = await Deno.readTextFile(join(SRC, "server", "server.ts"));
  const call = src.indexOf("initClientLog(getLogDir())");
  assert(call > 0, "server.ts no longer initialises the client log dir");
  // The 200 characters before the call must not open a prod gate around it.
  const before = src.slice(Math.max(0, call - 200), call);
  assert(
    !/if\s*\(\s*!prod\s*\)\s*\{[^}]*$/.test(before),
    "initClientLog must not sit behind `if (!prod)` — the UDS transport " +
      "writes client frames in prod too, and the default path is cwd-relative",
  );
});

Deno.test("client log: nothing else invents a client.log location", async () => {
  // `am` used to carry its own literal "log/client.log". One writer, one
  // reader, one path.
  const offenders: string[] = [];
  const walk = async function* (dir: string): AsyncGenerator<string> {
    for await (const e of Deno.readDir(dir)) {
      const p = join(dir, e.name);
      if (e.isDirectory) yield* walk(p);
      else if (e.name.endsWith(".ts")) yield p;
    }
  };
  for await (const path of walk(SRC)) {
    const rel = path.slice(SRC.length + 1);
    if (rel.endsWith(join("server", "client-log.ts"))) continue;
    // Code only: these files DISCUSS the old literal in their comments, which
    // is exactly the history worth keeping written down.
    const code = (await Deno.readTextFile(path))
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    // A hardcoded directory joined onto client.log — the shape that drifts.
    if (/["'][^"']*log\/client\.log["']/.test(code)) offenders.push(rel);
  }
  assertEquals(
    offenders,
    [],
    "these hardcode a client.log path instead of asking the logger",
  );
});

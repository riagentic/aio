// The dev shape-drift refusal names WHERE the stored data is, and the way out
// — report 9b §2.
//
// The refusal was exact about what drifted (cell, key, stored vs declared
// type) and then said "clear the stored data" with no path. The boot banner's
// `data` row answers that, but the refusal throws before the banner prints.
// An agent spent ~6.5 min in whole-disk `find … | xargs grep` before finding
// the app home; inside a sandbox that set `AIO_APPS_DIR` the same app booted,
// because that root was empty — so the directory is not guessable from the
// appId alone and has to come from the boot that opened it.
import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { _resetParsedCli } from "../src/server/aio-cli.ts";
import { _resetAppDirs } from "../src/server/app-dirs.ts";
import { shapeDriftRefusal } from "../src/server/aio-boot.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const DRIFT = [{
  cell: "counter",
  path: "count",
  issue: "type-changed" as const,
  storedType: "number",
  declaredType: "string",
}];

Deno.test("drift refusal: a real dev boot under AIO_APPS_DIR names the data dir it opened", async () => {
  const root = await tempDir("drift-datadir-");
  const appId = "drift-datadir";
  const argsDesc = Object.getOwnPropertyDescriptor(Deno, "args")!;
  const prevApps = Deno.env.get("AIO_APPS_DIR");
  Object.defineProperty(Deno, "args", {
    value: [],
    configurable: true,
    enumerable: true,
  });
  _resetParsedCli();
  Deno.env.set("AIO_APPS_DIR", root);
  const boot = (state: Record<string, unknown>) => {
    const counter = cell("counter", {
      state,
      methods: {
        bump(s: Record<string, unknown>) {
          s.count = 1;
        },
      },
    });
    return {
      counter,
      app: aio.run({
        cells: [counter],
        appId,
        client: "server-only",
        port: freePort(),
        persistDebounceMs: 10,
      }),
    };
  };
  try {
    {
      const { counter, app } = boot({ count: 0 });
      const a = await app;
      await (counter as unknown as { bump: () => Promise<void> }).bump();
      await new Promise((r) => setTimeout(r, 200));
      await a.close();
    }
    _resetAppDirs();
    let msg = "";
    try {
      const a = await boot({ count: "0" }).app;
      await a.close();
    } catch (e) {
      msg = (e as Error).message;
    }
    assertStringIncludes(msg, "REFUSING to boot (dev)");
    const data = join(root, appId, "data");
    // The drifted database really is there — the path is the one opened.
    await Deno.stat(join(data, "state.db"));
    assertStringIncludes(msg, `data: ${data}`);
    assertStringIncludes(msg, `AIO_APPS_DIR=${root}`);
    assertStringIncludes(msg, "`am data`");
    assertStringIncludes(msg, "`am backup`");
    assertStringIncludes(msg, `\`rm -r ${data}\``);
  } finally {
    Object.defineProperty(Deno, "args", argsDesc);
    _resetParsedCli();
    _resetAppDirs();
    if (prevApps === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prevApps);
    await dropTempDir(root);
  }
});

Deno.test("drift refusal: a dbPath outside the data dir is named, and removing data/ is not offered", () => {
  const msg = shapeDriftRefusal(DRIFT, "summary", {
    dataDir: "/home/u/.x/data",
    dbPath: "/srv/x/state.db",
  });
  assertStringIncludes(msg, "data: /home/u/.x/data");
  assertStringIncludes(msg, "db: /srv/x/state.db");
  assertStringIncludes(
    msg,
    "`rm /srv/x/state.db /srv/x/state.db-wal /srv/x/state.db-shm`",
  );
  assert(!msg.includes("rm -r"), msg);
  assert(!msg.includes("AIO_APPS_DIR"), "no env note when it placed nothing");
});

Deno.test("drift refusal: a path with a space is quoted in the command", () => {
  const msg = shapeDriftRefusal(DRIFT, "summary", {
    dataDir: "/home/a b/.x/data",
    dbPath: "/home/a b/.x/data/state.db",
  });
  assertStringIncludes(msg, '`rm -r "/home/a b/.x/data"`');
});

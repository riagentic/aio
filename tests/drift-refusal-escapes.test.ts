// The shape-drift refusal names the escapes people actually reach for.
//
//  • `am start --instance=<name>` — run the new build against a PRIVATE,
//    empty data home and leave the refused data untouched. Not offered under
//    AIO_APPS_DIR, where `--instance` is ignored (loudly) and would mislead.
//  • `am migrations` reads a RUNNING app; on an app that refused to boot it
//    used to answer only "am does not know which app to target" while the
//    docs said it shows the drift. It now says it needs a running app and
//    that the refusal itself is the drift report.
import { assert, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { shapeDriftRefusal } from "../src/server/aio-boot.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const DRIFT = [{
  cell: "counter",
  path: "old",
  issue: "unknown-field" as const,
  storedType: "number",
}];

Deno.test("drift refusal: names `am start --instance=<name>` as the private-copy escape", () => {
  const msg = shapeDriftRefusal(DRIFT, "summary", {
    dataDir: "/home/u/.counter/data",
    dbPath: "/home/u/.counter/data/state.db",
  });
  assertStringIncludes(msg, "am start --instance=<name>");
});

Deno.test("drift refusal: under AIO_APPS_DIR, `--instance` (which is ignored there) is not offered", () => {
  const msg = shapeDriftRefusal(DRIFT, "summary", {
    dataDir: "/srv/aio/counter/data",
    dbPath: "/srv/aio/counter/data/state.db",
    appsDir: "/srv/aio",
  });
  assert(!msg.includes("--instance"), msg);
});

Deno.test("am migrations on an app that is not running says it needs a running app", async () => {
  const home = await tempDir("aio-am-migrations-offline-");
  try {
    const REPO = new URL("..", import.meta.url).pathname;
    const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        join(REPO, "deno.json"),
        join(REPO, "src/am.ts"),
        "migrations",
        "--app=not-running-drift-app",
      ],
      cwd: home,
      env: { AIO_APPS_DIR: home, NO_COLOR: "1" },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(stdout) +
      new TextDecoder().decode(stderr);
    assert(code !== 0, out);
    assertStringIncludes(out, "needs a running app");
    assertStringIncludes(out, "REFUSING to boot");
  } finally {
    await dropTempDir(home);
  }
});

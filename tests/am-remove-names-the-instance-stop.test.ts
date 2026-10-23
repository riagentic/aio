// `am remove <app>` refuses while the app runs, and names the stop. It named
// `am stop --app=<app>` whatever home the instance was booted with — so for an
// instance started with --home/--profile the command, run as written, answered
// "not running" and the remove was refused again.
import "./store-sandbox.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { cmdRemove } from "../src/am/am-cmd-remove.ts";
import { AppLock } from "../src/server/single-instance-lock.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("am remove: a running --home instance's refusal names ITS stop", async () => {
  const root = await tempDir("am-remove-home-");
  const app = `rmhome${Deno.pid}`;
  const home = join(root, "elsewhere");
  const prevRoot = Deno.env.get("AIO_INSTALL_ROOT");
  Deno.env.set("AIO_INSTALL_ROOT", join(root, "apps"));
  await Deno.mkdir(join(root, "apps", app), { recursive: true });
  await Deno.writeTextFile(
    join(root, "apps", app, "installed.json"),
    JSON.stringify({ name: app, version: "1.0.0" }),
  );
  const lock = new AppLock(app, home);
  const chunks: string[] = [];
  const [log, err, exit] = [console.log, console.error, Deno.exit];
  try {
    assertEquals((await lock.acquire(4555)).ok, true);
    console.log = (...a: unknown[]) => chunks.push(a.map(String).join(" "));
    console.error = (...a: unknown[]) => chunks.push(a.map(String).join(" "));
    // deno-lint-ignore no-explicit-any
    (Deno as any).exit = () => {
      throw new Error("__exit__");
    };
    await cmdRemove([app], { json: true }).catch((e) => {
      if (!(e instanceof Error) || e.message !== "__exit__") throw e;
    });
  } finally {
    console.log = log;
    console.error = err;
    // deno-lint-ignore no-explicit-any
    (Deno as any).exit = exit;
    lock.release();
    if (prevRoot === undefined) Deno.env.delete("AIO_INSTALL_ROOT");
    else Deno.env.set("AIO_INSTALL_ROOT", prevRoot);
    await dropTempDir(root);
  }
  const said = JSON.parse(chunks.join("\n")).error as string;
  assertStringIncludes(said, "is running");
  assertStringIncludes(said, `am stop --app=${app} --home=${home}`);
});

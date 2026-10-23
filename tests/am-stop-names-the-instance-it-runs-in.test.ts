// `am stop` outside the `--instance` an app runs in. status / state /
// dispatch say "running in --instance=<name> — add --instance=<name>"; the
// stop's "not running" listed every OTHER app and never the instance.
import "./store-sandbox.ts";
import { assertStringIncludes } from "@std/assert";
import { noLockMessage } from "../src/am/am-cmd-start.ts";
import { instanceAppsDir } from "../src/server/app-dirs.ts";
import { AppLock } from "../src/server/single-instance-lock.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

Deno.test("am stop: 'not running' names the --instance the app runs in", async () => {
  const home = await tempDir("am-stop-inst-");
  const env = (k: string) => Deno.env.get(k);
  const prev = { HOME: env("HOME"), AIO_APPS_DIR: env("AIO_APPS_DIR") };
  const put = (k: string, v: string | undefined) =>
    v === undefined ? Deno.env.delete(k) : Deno.env.set(k, v);
  const app = `stopinst${Deno.pid}`;
  let lock: AppLock | undefined;
  try {
    Deno.env.set("HOME", home);
    Deno.env.set("AIO_APPS_DIR", instanceAppsDir("agent1"));
    await Deno.mkdir(instanceAppsDir("agent1"), { recursive: true });
    lock = new AppLock(app);
    await lock.acquire(4701);
    Deno.env.delete("AIO_APPS_DIR"); // the shared scope, where `am stop` ran
    assertStringIncludes(
      noLockMessage(app),
      "running in --instance=agent1 — add --instance=agent1",
    );
  } finally {
    Deno.env.set("AIO_APPS_DIR", instanceAppsDir("agent1"));
    lock?.release();
    put("HOME", prev.HOME);
    put("AIO_APPS_DIR", prev.AIO_APPS_DIR);
    await dropTempDir(home);
  }
});

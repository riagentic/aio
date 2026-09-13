// `am stop --all` run OUTSIDE a project stopped every project's apps under the
// cwd.
//
// "--all" means "every app of THIS project" — the help says it, `am agent`
// says it, and `instancesInProject` scopes by `projectRoot()`. But with no
// deno.json above the cwd, `projectRoot()` falls back to the cwd itself, so
// `cd ~ && am stop --all` scoped to the whole home directory and stopped every
// app launched from anywhere beneath it. Measured by a hunter running `am` as a
// user; this drives the real CLI the same way.
//
// The victim is a real process (`sleep`) holding a real lock whose cwd sits
// under the non-project directory. Without the fix `am` SIGTERMs it.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  type LockData,
  writeLock,
} from "../src/server/single-instance-lock.ts";
import { isProcessAlive } from "../src/server/single-instance-lock.ts";

const AM = new URL("../src/am.ts", import.meta.url).pathname;
const CONFIG = new URL("../deno.json", import.meta.url).pathname;

Deno.test("am stop --all outside a project refuses, and stops nothing", async () => {
  const base = await Deno.makeTempDir({ prefix: "am-stopall-noproj-" });
  const apps = join(base, "apps");
  const nowhere = join(base, "not-a-project");
  const launched = join(nowhere, "some-checkout", "dist");
  await Deno.mkdir(apps, { recursive: true });
  await Deno.mkdir(launched, { recursive: true });

  const victim = new Deno.Command("sleep", {
    args: ["60"],
    stdout: "null",
    stderr: "null",
  }).spawn();
  const prev = Deno.env.get("AIO_APPS_DIR");
  try {
    // The lock dir scopes with AIO_APPS_DIR — write it where the child reads.
    Deno.env.set("AIO_APPS_DIR", apps);
    const lock: LockData = {
      appId: "someone-elses-server",
      pid: victim.pid,
      port: 1, // nothing listens: stop falls through to the signal
      startedAt: Date.now(),
      status: "started",
      cwd: launched,
    };
    writeLock(lock);
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);

    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", CONFIG, AM, "stop", "--all", "--json"],
      cwd: nowhere,
      env: {
        ...Deno.env.toObject(),
        AIO_APPS_DIR: apps,
        AIO_AM_NO_DELEGATE: "1",
        NO_COLOR: "1",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);

    assertEquals(out.code, 1, `expected a refusal, got: ${text}`);
    assertStringIncludes(text, "not inside one");
    assertStringIncludes(text, "--app=");
    assert(
      isProcessAlive(victim.pid),
      "`am stop --all` outside a project stopped another project's app",
    );
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    try {
      victim.kill("SIGKILL");
    } catch { /* already gone — the failing case */ }
    await victim.status;
    await Deno.remove(base, { recursive: true }).catch(() => {});
  }
});

// `am instances --json` prints `stopWith` — the command that ends THAT instance
// and nothing else. It was `am stop --app=<id>` whatever scope the list was
// read in, so under `--instance=agent1` (or AIO_APPS_DIR, or a second data
// home) the printed command addressed the DEFAULT scope: it stopped the
// human's copy of the same app, or found nothing. Measured by a hunter running
// `am` as a user.
//
// And `--instance` itself did nothing, silently, when AIO_APPS_DIR was set.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { stopCommandFor } from "../src/am/am-cmd-process.ts";
import { homedir } from "../src/server/paths.ts";

const DEFAULT_HOME = "/home/u/.notes";

Deno.test("stopWith: the default scope and home is the plain command", () => {
  assertEquals(
    stopCommandFor({ appId: "notes", home: DEFAULT_HOME }, {
      defaultHome: DEFAULT_HOME,
    }),
    "am stop --app=notes",
  );
});

Deno.test("stopWith: an --instance scope is named by --instance", () => {
  assertEquals(
    stopCommandFor({ appId: "notes" }, {
      instance: "agent1",
      appsDir: join(homedir(), ".aio-instances", "agent1"),
      defaultHome: "",
    }),
    "am stop --app=notes --instance=agent1",
  );
});

Deno.test("stopWith: an AIO_APPS_DIR scope carries the variable", () => {
  assertEquals(
    stopCommandFor({ appId: "notes", home: "/srv/apps/notes" }, {
      appsDir: "/srv/apps",
      defaultHome: "/srv/apps/notes",
    }),
    "AIO_APPS_DIR=/srv/apps am stop --app=notes",
  );
  // A path that needs quoting is quoted, so the line runs as printed.
  assertEquals(
    stopCommandFor({ appId: "notes" }, {
      appsDir: "/tmp/my apps",
      defaultHome: "",
    }),
    "AIO_APPS_DIR='/tmp/my apps' am stop --app=notes",
  );
  // --instance given but AIO_APPS_DIR won (see below): the variable is the
  // truth, not the flag.
  assertEquals(
    stopCommandFor({ appId: "notes" }, {
      instance: "agent1",
      appsDir: "/srv/apps",
      defaultHome: "",
    }),
    "AIO_APPS_DIR=/srv/apps am stop --app=notes",
  );
});

Deno.test("stopWith: a second data home is addressed by --home", () => {
  assertEquals(
    stopCommandFor({ appId: "notes", home: "/data/notes-b" }, {
      defaultHome: DEFAULT_HOME,
    }),
    "am stop --app=notes --home=/data/notes-b",
  );
});

Deno.test("am --instance with a different AIO_APPS_DIR says it was ignored", async () => {
  const apps = await Deno.makeTempDir({ prefix: "am-inst-ignored-" });
  try {
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        new URL("../deno.json", import.meta.url).pathname,
        new URL("../src/am.ts", import.meta.url).pathname,
        "instances",
        "--instance=agent1",
        "--json",
      ],
      cwd: apps,
      env: {
        ...Deno.env.toObject(),
        AIO_APPS_DIR: apps,
        AIO_AM_NO_DELEGATE: "1",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const err = new TextDecoder().decode(out.stderr);
    assertStringIncludes(err, "--instance=agent1 is ignored");
    assertStringIncludes(err, apps);
    // Only a warning: stdout is still the command's one JSON document.
    JSON.parse(new TextDecoder().decode(out.stdout));
  } finally {
    await Deno.remove(apps, { recursive: true });
  }
});

Deno.test("am instances --json: stopWith, as printed, names the scope it was listed in", async () => {
  const { writeLock } = await import("../src/server/single-instance-lock.ts");
  const apps = await Deno.makeTempDir({ prefix: "am-inst-scope-" });
  const alive = new Deno.Command("sleep", {
    args: ["60"],
    stdout: "null",
    stderr: "null",
  }).spawn();
  const prev = Deno.env.get("AIO_APPS_DIR");
  try {
    Deno.env.set("AIO_APPS_DIR", apps);
    writeLock({
      appId: "scoped-notes",
      pid: alive.pid,
      port: 1,
      startedAt: Date.now(),
      status: "started",
      cwd: apps,
      home: join(apps, "scoped-notes"),
    });
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);

    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        new URL("../deno.json", import.meta.url).pathname,
        new URL("../src/am.ts", import.meta.url).pathname,
        "instances",
        "--json",
      ],
      cwd: apps,
      env: {
        ...Deno.env.toObject(),
        AIO_APPS_DIR: apps,
        AIO_AM_NO_DELEGATE: "1",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const rows = JSON.parse(new TextDecoder().decode(out.stdout)) as {
      appId: string;
      stopWith: string;
    }[];
    const row = rows.find((r) => r.appId === "scoped-notes");
    assertEquals(
      row?.stopWith,
      `AIO_APPS_DIR=${apps} am stop --app=scoped-notes`,
      "the printed command must reach THIS scope's instance, not the default's",
    );
  } finally {
    if (prev === undefined) Deno.env.delete("AIO_APPS_DIR");
    else Deno.env.set("AIO_APPS_DIR", prev);
    alive.kill("SIGKILL");
    await alive.status;
    await Deno.remove(apps, { recursive: true }).catch(() => {});
  }
});

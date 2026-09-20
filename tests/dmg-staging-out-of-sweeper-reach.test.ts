// A macOS `.dmg` built from Linux packs the `.app` into `payload.tgz`, then
// `scp`s it to the Mac. The payload was staged under `/tmp/aio-dmg-*` — the
// exact namespace every aio temp-dir sweeper walks — and once vanished between
// `tar` and `scp` while a test suite started beside the build (a field report,
// #7). The sweep is fixed (tests/clean-stale-spares-foreign-tmp.test.ts); this
// pins the other half: the build's own scratch never lives under an `aio*`
// name, locally or on the Mac, and the Mac-side dir is unique per build — it
// was `/tmp/aio-dmg-<pid>`, which two builds (two hosts, or a pid reused after
// a failed run that left the dir behind) share.
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { basename, dirname, join } from "@std/path";
import { finalizeMacDmg } from "../src/build/dmg.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

type Seen = { payload: string; payloadExisted: boolean; remoteWork: string };

async function buildOnce(appPath: string): Promise<Seen> {
  const seen: Seen = { payload: "", payloadExisted: false, remoteWork: "" };
  const ok = { success: true, code: 0, stdout: "", stderr: "" };
  await finalizeMacDmg({
    appPath,
    outPath: join(dirname(appPath), "out.dmg"),
    volumeName: "Probe",
    declaredHost: "dev@mac.invalid",
    os: "linux",
    binaryName: "probe",
    sign: false,
    remote: {
      ssh: (command: string) => {
        const m = /^mkdir -p '([^']+)'$/.exec(command);
        if (m) seen.remoteWork = m[1]!;
        return Promise.resolve(ok);
      },
      up: async (local: string) => {
        seen.payload = local;
        seen.payloadExisted = await Deno.stat(local).then(
          () => true,
          () => false,
        );
        return ok;
      },
      down: () => Promise.resolve(ok),
    },
  });
  return seen;
}

Deno.test("dmg: the payload and the Mac-side work dir are out of every aio* sweeper's reach", async () => {
  const root = await tempDir("dmg-stage-probe-");
  const app = join(root, "Probe.app");
  await Deno.mkdir(join(app, "Contents", "MacOS"), { recursive: true });
  await Deno.writeTextFile(
    join(app, "Contents", "MacOS", "probe"),
    "#!/bin/sh",
  );

  const a = await buildOnce(app);
  const b = await buildOnce(app);

  assert(a.payloadExisted, "the payload exists when it is copied");
  const stage = basename(dirname(a.payload));
  assert(
    !stage.startsWith("aio"),
    `the local payload is staged under ${dirname(a.payload)} — an aio* name ` +
      `is exactly what the temp sweepers walk`,
  );
  assertEquals(
    await Deno.stat(dirname(a.payload)).then(() => "left", () => "gone"),
    "gone",
    "the local staging dir is removed after the build",
  );

  assert(a.remoteWork !== "", "the Mac-side work dir was created");
  assert(
    !basename(a.remoteWork).startsWith("aio"),
    `the Mac-side work dir ${a.remoteWork} has an aio* name`,
  );
  assertNotEquals(
    a.remoteWork,
    b.remoteWork,
    "two builds from one process must not share the Mac-side work dir",
  );
});

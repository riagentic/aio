// `am start` waits through a first-run Electron download (cc §6).
//
// A fresh user's first `am start --client=electron` downloads the Electron
// runtime (~100 MB) before the app can answer. `am start` gave up at its
// default 10 s with exit 1 and "not responding on socket … after 10s"; the
// window appeared a few seconds later and `am status` said `started`. An
// agent reads exit 1 as "failed" and starts it again. Now the child's own log
// line announces the download, and `am start` waits for it — bounded,
// announced, and only when no explicit `--wait` was given.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  SLOW_START_WAIT_MS,
  slowStartReason,
} from "../src/am/am-cmd-process.ts";
import { childEnv, makeApp } from "./e2e-app-harness.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const DOWNLOADING =
  "downloading runtime 44.3.0 for linux-x64 (~100 MB, once per machine)…";

Deno.test("slowStartReason: the download line means wait; cached or failed means the default", () => {
  assertEquals(slowStartReason(""), null);
  assertEquals(slowStartReason("12:00:00.000 app started\n"), null);
  const r = slowStartReason(`boot\n${DOWNLOADING}\n`);
  assert(r && r.includes("Electron runtime"), String(r));
  // Finished since: the download is not what is taking the time now.
  assertEquals(
    slowStartReason(`${DOWNLOADING}\n✓ runtime 44.3.0 (linux-x64) — cached\n`),
    null,
  );
  // Failed since: exit 1 with the real reason is right, not a 3-minute wait.
  assertEquals(
    slowStartReason(
      `${DOWNLOADING}\nError: could not download the Electron runtime for linux-x64: 404\n`,
    ),
    null,
  );
  // A LATER download line after an earlier cached one counts again.
  assert(
    slowStartReason(
      `${DOWNLOADING}\n✓ runtime 44.3.0 (linux-x64) — cached\n${DOWNLOADING}\n`,
    ),
  );
  assert(SLOW_START_WAIT_MS > 60_000, "minutes, not seconds — a slow line");
});

Deno.test({
  name:
    "am start: a child whose log says it is downloading Electron gets more than 10 s, and starts",
  ignore: Deno.build.os === "windows",
  async fn() {
    const dir = await makeApp("counter", "am-slow-start-");
    const apps = await tempDir("am-slow-start-apps-");
    const dec = new TextDecoder();
    let pid = 0;
    try {
      // The scaffold's own entry, with a first-run download STANDING IN: the
      // marker line the runtime fetch prints, then 13 s of nothing — past the
      // default wait, well inside the extended one — then the real boot.
      const entry = join(dir, "src", "app.ts");
      const app = await Deno.readTextFile(entry);
      await Deno.writeTextFile(
        entry,
        `console.log(${JSON.stringify(DOWNLOADING)});\n` +
          `await new Promise((r) => setTimeout(r, 13_000));\n` +
          app,
      );
      const t0 = Date.now();
      const r = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "-A",
          join(dir, "dep", "aio", "src", "am.ts"),
          "start",
          "--client=server-only",
          "--json",
        ],
        cwd: dir,
        env: {
          ...Deno.env.toObject(),
          ...childEnv({ AIO_APPS_DIR: apps }),
          AIO_AM_NO_DELEGATE: "1",
          NO_COLOR: "1",
        },
        stdout: "piped",
        stderr: "piped",
      }).output();
      const took = Date.now() - t0;
      const out = dec.decode(r.stdout);
      const err = dec.decode(r.stderr);
      assertEquals(r.code, 0, `am start must succeed:\n${out}\n${err}`);
      const started = JSON.parse(out.trim().split("\n").at(-1)!);
      assertEquals(started.status, "started", out);
      pid = started.pid;
      assert(took > 10_000, `waited past the default 10 s (took ${took} ms)`);
      // …and SAID why it was waiting, with the way to change it.
      assertStringIncludes(err, "am: note: first run");
      assertStringIncludes(err, "Electron runtime");
      assertStringIncludes(err, "--wait=N");
    } finally {
      if (pid > 0) {
        try {
          Deno.kill(pid, "SIGTERM");
        } catch { /* gone */ }
        // Give it a moment to release its lock before the dirs go.
        for (let i = 0; i < 50; i++) {
          try {
            Deno.kill(pid, "SIGCONT");
          } catch {
            break;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      await dropTempDir(apps);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

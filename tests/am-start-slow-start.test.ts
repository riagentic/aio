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
  startWaitMs,
} from "../src/am/am-cmd-process.ts";
import { FETCH_STALL_MS, fetchStallNote } from "../src/am/am-cmd-start.ts";
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

// The long wait lasts as long as its reason. It used to be latched at the
// first look: a new app's first start shows Deno's `Initialize <package>`
// lines for a moment, and an app that then took 15 s to boot was waited for
// 180 s under "Deno is downloading the app's modules".
Deno.test("startWaitMs: the long wait holds while the reason does; after it, the default wait from then", () => {
  const why = "first run: …";
  assertEquals(startWaitMs(null, null, 500, 10_000, 10_000), 10_000);
  assertEquals(startWaitMs(null, why, 500, 10_000, 10_000), SLOW_START_WAIT_MS);
  assertEquals(
    startWaitMs(why, why, 47_000, SLOW_START_WAIT_MS, 10_000),
    SLOW_START_WAIT_MS,
  );
  assertEquals(
    startWaitMs(why, null, 46_300, SLOW_START_WAIT_MS, 10_000),
    57_000,
  );
  // …and that wait is not moved again by later looks.
  assertEquals(startWaitMs(null, null, 50_000, 57_000, 10_000), 57_000);
});

// Deno's own first-run fetch: the app has not run a line yet. The lines are
// Deno's, as it prints them into a log file (colours and all).
Deno.test("slowStartReason: Deno still downloading the app's modules means wait; the app's first line ends it", () => {
  const dl = (u: string) => `\x1b[0m\x1b[32mDownload\x1b[0m ${u}`;
  const fetching = [
    'Warning "exports" field should be specified when specifying a "name".',
    dl("https://jsr.io/@std/path/meta.json"),
    dl("https://jsr.io/@std/path/1.1.3_meta.json"),
  ].join("\n") + "\n";
  const r = slowStartReason(fetching);
  assert(r && r.includes("downloading the app's modules"), String(r));
  assert(slowStartReason("Initialize express@4.21.2\n"));
  // The same lines as Windows writes them (CRLF), and with a bare CR.
  for (const eol of ["\r\n", "\r"]) {
    const text = fetching.replaceAll("\n", eol);
    assert(slowStartReason(text), JSON.stringify(eol));
    assertEquals(slowStartReason(`${text}aio  starting my-app${eol}`), null);
  }
  // The app has spoken since: whatever takes the time now, it is not that.
  assertEquals(slowStartReason(`${fetching}aio  starting my-app\n`), null);
  assertEquals(slowStartReason(`${fetching}error: Module not found\n`), null);
  // A line that merely mentions a download is not Deno's.
  assertEquals(slowStartReason("my-app: Download finished\n"), null);
  // Windows: stderr is a file of its own, so Deno's lines are never followed
  // by the app's. Fetching while the app's file is empty; over once it is not
  // — and the Electron line is then read from wherever it is.
  const errFile = fetching.replaceAll("\n", "\r\n");
  assert(slowStartReason("", errFile));
  assertEquals(slowStartReason("booting\r\n", errFile), null);
  const el = slowStartReason(`${DOWNLOADING}\r\n`, errFile);
  assert(el && el.includes("Electron runtime"), String(el));
  assertEquals(
    slowStartReason(`${DOWNLOADING}\r\n`, `${errFile}Error: 404\r\n`),
    null,
  );
});

Deno.test({
  name:
    "am start: a child whose log says it is downloading Electron gets more than 10 s, and starts",
  async fn() {
    const dir = await makeApp("counter", "am-slow-start-");
    const apps = await tempDir("am-slow-start-apps-");
    const dec = new TextDecoder();
    let pid = 0;
    try {
      // The scaffold's own entry, with a first-run download STANDING IN: the
      // marker line the runtime fetch prints, then 13 s of nothing — past the
      // default wait, well inside the extended one — then the real boot.
      //
      // The app itself is imported AFTER the wait, from a file of its own:
      // static imports are hoisted, so with the marker written above them the
      // line was printed only once the whole framework graph had loaded — on
      // a loaded machine (measured: a busy Windows VM) later than the 10 s in
      // which `am start` must read it, and the run said "still starting after
      // 10s" about an app whose log had not said anything yet.
      const entry = join(dir, "src", "app.ts");
      await Deno.rename(entry, join(dir, "src", "app-real.ts"));
      await Deno.writeTextFile(
        entry,
        `console.log(${JSON.stringify(DOWNLOADING)});\n` +
          `await new Promise((r) => setTimeout(r, 13_000));\n` +
          `await import("./app-real.ts");\n`,
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

Deno.test("fetchStallNote: a still fetch line names both readings, only after the stall", () => {
  const why = slowStartReason("Download https://jsr.io/x/meta.json");
  assertEquals(fetchStallNote(why, FETCH_STALL_MS - 1), null);
  const note = fetchStallNote(why, FETCH_STALL_MS);
  assertEquals(note?.includes("still coming"), true, String(note));
  assertEquals(note?.includes("fetch is done"), true, String(note));
  // Not a Deno fetch (the Electron download prints its own progress).
  assertEquals(
    fetchStallNote(
      "first run: the app is downloading the Electron runtime",
      1e9,
    ),
    null,
  );
  assertEquals(fetchStallNote(null, 1e9), null);
});

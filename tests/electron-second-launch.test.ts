// Launching a running desktop app again brings ITS window to the front, and
// the second launch ends quietly (exit 0) — the desktop convention. It used to
// log "already running" and exit 1, leaving a window hidden to the tray (or
// minimized, or buried) exactly where it was.
//
// The DENO half, end to end: the refused boot writes the request beside the
// lock and waits; the running boot told its window where to watch
// (`AioMeta.showFile`). Instrument: `$ELECTRON_PATH` pointed at a shell stub
// that stands in for the window — it reads SHOW_FILE out of the main script
// it was handed (so the path is the one the lifecycle really passed) and takes
// the request the way the real shell does, by removing it. The real window's
// half is tests/electron-second-launch-show-e2e.test.ts.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { askRunningToShow } from "../src/server/aio-run-helpers.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { testDisplayEnv } from "../src/testing/test-display.ts";
import { writeDenoProgram } from "./fake-program-helper.ts";
import { spec } from "./module-spec-helper.ts";
import { askToStop } from "./proc-helper.ts";
import { childEnv } from "./e2e-app-harness.ts";

const ROOT = fromFileUrl(new URL("..", import.meta.url)).replace(/[\\/]$/, "");

Deno.test("askRunningToShow: nobody answers → false, and the request is withdrawn", async () => {
  const dir = await tempDir("show-req-");
  try {
    const f = join(dir, "x.show");
    const t0 = Date.now();
    assertEquals(await askRunningToShow(f, 300), false);
    assert(Date.now() - t0 >= 300, "gave up before the timeout");
    let left = true;
    try {
      Deno.statSync(f);
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
      left = false;
    }
    assertEquals(left, false, "an unanswered request must not stay behind");
  } finally {
    await dropTempDir(dir);
  }
});

async function scaffold(dir: string): Promise<string> {
  const app = join(dir, "app");
  await Deno.mkdir(join(app, "src"), { recursive: true });
  const head = JSON.parse(await Deno.readTextFile(join(ROOT, "deno.json")));
  const imports: Record<string, string> = {};
  for (
    const [k, v] of Object.entries(head.imports as Record<string, string>)
  ) {
    imports[k] = v.startsWith("./") ? `${spec(ROOT)}/${v.slice(2)}` : v;
  }
  await Deno.writeTextFile(
    join(app, "deno.json"),
    JSON.stringify({ compilerOptions: head.compilerOptions, imports }),
  );
  await Deno.writeTextFile(
    join(app, "src", "cell.ts"),
    `import { cell } from "aio";\nexport const c = cell("c", { state: { v: 0 }, methods: {} });\n`,
  );
  await Deno.writeTextFile(
    join(app, "src", "App.tsx"),
    `import { c } from "./cell.ts";\nexport default function App() { return <p>{c.v}</p>; }\n`,
  );
  await Deno.writeTextFile(
    join(app, "src", "app.ts"),
    `import { c } from "./cell.ts";\nimport { aio } from "aio";\nawait aio.run({ appId: "elsecond", cells: [c] });\n`,
  );
  return app;
}

/** A stand-in window: takes show requests (when `answer`) and counts them. */
async function stub(dir: string, answer: boolean): Promise<string> {
  const path = join(dir, answer ? "electron" : "electron-deaf");
  if (Deno.build.os === "windows") {
    // The same stand-in without a shell. (The show file's path is read out of
    // the main script, where it is a string literal: unescaped as one.)
    return await writeDenoProgram(
      path,
      String.raw`
const m = /^  const SHOW_FILE = (".*");$/m.exec(Deno.readTextFileSync(Deno.args[0]));
const f = m ? JSON.parse(m[1]) : "";
console.log("stub: show file [" + f + "]");
const there = () => { try { Deno.statSync(f); return true; } catch { return false; } };
while (true) {
  if (f && there() && ${
        String(answer)
      }) { Deno.removeSync(f); console.log("stub: shown"); }
  await new Promise((r) => setTimeout(r, 50));
}
`,
    );
  }
  await Deno.writeTextFile(
    path,
    `#!/bin/sh
f=$(sed -n 's/^  const SHOW_FILE = "\\(.*\\)";$/\\1/p' "$1")
echo "stub: show file [$f]"
while :; do
  if [ -n "$f" ] && [ -f "$f" ] && ${answer ? "true" : "false"}; then
    rm -f "$f"; echo "stub: shown"
  fi
  sleep 0.05
done
`,
  );
  await Deno.chmod(path, 0o755);
  return path;
}

function boot(app: string, home: string, electron: string) {
  const port = freePort();
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "src/app.ts",
      "--client=electron",
      `--port=${port}`,
    ],
    cwd: app,
    env: childEnv({
      ...testDisplayEnv(),
      ELECTRON_PATH: electron,
      AIO_APPS_DIR: home,
    }),
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let log = "";
  const dec = new TextDecoder();
  const pump = async (s: ReadableStream<Uint8Array>) => {
    for await (const x of s) log += dec.decode(x);
  };
  const pumps = Promise.all([pump(child.stdout), pump(child.stderr)]);
  return { child, port, pumps, log: () => log };
}

async function until(what: string, f: () => boolean, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (f()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

for (const answer of [true, false]) {
  Deno.test({
    name: answer
      ? "second launch of a desktop app: the running window shows, exit 0"
      : "second launch, window never answers: refused as before, exit 1",
    ignore: Deno.build.os === "darwin", // macOS: left out as it was (never run there)
    async fn() {
      const dir = await tempDir("el-second-");
      // Written once: Windows cannot rewrite a program that is running.
      const electron = await stub(dir, answer);
      const first = boot(await scaffold(dir), join(dir, "home"), electron);
      try {
        await until(
          "the first window",
          () => /stub: show file \[.+\.show\]/.test(first.log()),
        );
        const second = boot(join(dir, "app"), join(dir, "home"), electron);
        const st = await second.child.status;
        await second.pumps;
        if (answer) {
          assertEquals(st.code, 0, second.log());
          assertStringIncludes(second.log(), "brought its window to the front");
          assertStringIncludes(first.log(), "stub: shown");
        } else {
          assertEquals(st.code, 1, second.log());
          assertStringIncludes(second.log(), "Already running");
          const shown = /stub: show file \[(.+)\]/.exec(first.log())![1]!;
          let left = true;
          try {
            Deno.statSync(shown);
          } catch (e) {
            if (!(e instanceof Deno.errors.NotFound)) throw e;
            left = false;
          }
          assertEquals(left, false, "the unanswered request stayed behind");
        }
      } finally {
        // A graceful stop (it ends the window too), on every OS.
        await askToStop(
          first.child.pid,
          first.port,
          join(dir, "home", "elsecond", "data", "control.key"),
        );
        await first.child.status;
        await first.pumps;
        await dropTempDir(dir);
      }
    },
  });
}

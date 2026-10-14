// Windows, a local Electron app, no `--allow-ffi`. Its named pipe needs FFI.
//
// With no TCP port (the default) nothing could serve the app: the boot is
// refused, with the flag (tests/local-peer-lockdown-e2e.test.ts). With a port
// NAMED the app has another door, and through 1.0.19 it came up on it — the
// pipe's failure one ERROR line. Taking the pipe names at boot turned that
// into a refused boot too: an app that started under 1.0.19 no longer did.
// It starts again, and says what its window is missing.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { childEnv, freePort, kill, waitForHttp } from "./e2e-app-harness.ts";
import { EXE, writeProgram } from "./fake-program-helper.ts";
import { spec } from "./module-spec-helper.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const REPO = join(import.meta.dirname!, "..");

Deno.test({
  name:
    "windows, no --allow-ffi, a port named: the app comes up on the port and says its window has no pipe",
  ignore: Deno.build.os !== "windows", // a named pipe (FFI) is the local door only there
  async fn() {
    const dir = await tempDir("pipe-no-ffi-");
    const apps = join(dir, "apps");
    await Deno.mkdir(apps);
    const port = freePort();
    await Deno.writeTextFile(
      join(dir, "app.ts"),
      `import { aio, cell } from "${spec(REPO)}/mod.ts";
const c = cell("c", { state: { n: 1 }, visible: "all" });
await aio.run({ cells: [c], appId: "pipe-no-ffi", persist: false });
await new Promise(() => {});
`,
    );
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      `export default function App() { return <div>Hello</div>; }\n`,
    );
    // The "window": it only has to stay.
    const electron = join(dir, `electron${EXE}`);
    await writeProgram(electron, "#!/bin/sh\nexec sleep 600\n");
    const app = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-prompt",
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-net",
        "--allow-run",
        "--allow-sys",
        "--config",
        join(REPO, "deno.json"),
        join(dir, "app.ts"),
        "--client=electron",
        `--port=${port}`,
      ],
      cwd: dir,
      env: childEnv({
        ...Deno.env.toObject(),
        AIO_APPS_DIR: apps,
        ELECTRON_PATH: electron,
        NO_COLOR: "1",
      }),
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let log = "";
    const drain = (s: ReadableStream<Uint8Array>) =>
      s.pipeTo(
        new WritableStream({
          write: (c) => {
            log += new TextDecoder().decode(c);
          },
        }),
      ).catch(() => {});
    const drained = Promise.all([drain(app.stdout), drain(app.stderr)]);
    let exited: number | null = null;
    app.status.then((s) => exited = s.code);
    try {
      const page = await waitForHttp(`http://127.0.0.1:${port}/`, 90_000)
        .catch((e) => `${e}`);
      assertEquals(exited, null, `the app did not stay up:\n${log}`);
      assert(page.includes("<"), `the port did not serve the app: ${page}`);
      assertStringIncludes(log, "started without `--allow-ffi`");
      assertStringIncludes(
        log,
        `The app goes on, served on port ${port} only`,
      );
    } finally {
      await kill(app);
      await drained;
      await dropTempDir(dir);
    }
  },
});

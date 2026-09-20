// The window-owned pickFile (#10) through the REAL server: a zero-port
// `aio.run` app, its real dispatch pipeline, and an ASYNC cell method that
// awaits `pickFile` — whose body runs as a separate effect (`c:__exec`), so
// "which window asked?" has to survive the hop from the socket's frame to the
// method body. The Electron main process is a stand-in speaking the same wire
// (tests/fixtures/uds-dialog-standin.ts); the real Electron is covered by the
// stub harness in electron-main-relay and on real OSes by hand.
import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { tempDir } from "../src/testing/temp-dir.ts";

const REPO = dirname(dirname(fromFileUrl(import.meta.url)));
const DENO_JSON = join(REPO, "deno.json");

Deno.test({
  name:
    "e2e: an async method's pickFile opens in the Electron window that called it",
  // A local app listens on a named pipe on Windows; the stand-in dials a
  // unix socket (same limit as tests/am-uds-only-app.test.ts).
  ignore: Deno.build.os === "windows",
  // The app child is stopped in finally; its streams are drained there.
  fn: async () => {
    const dir = await tempDir("pick-e2e-");
    const apps = join(dir, "apps");
    await Deno.mkdir(apps);
    const outFile = join(dir, "standin.json");
    const appId = `pick-${crypto.randomUUID().slice(0, 8)}`;
    await Deno.writeTextFile(
      join(dir, "app.ts"),
      `import { aio, cell } from "${REPO}/mod.ts";
import { pickFile } from "${REPO}/src/server-entry.ts";
const c = cell("c", { state: { picked: [] as string[] }, methods: {
  async pick(s: { picked: string[] }) {
    await new Promise((r) => setTimeout(r, 1)); // a real hop, not a microtask
    const got = await pickFile({ multiple: true, title: "e2e pick" });
    s.picked = got ?? [];
    return got;
  },
} });
await aio.run({ cells: [c], appId: ${JSON.stringify(appId)}, persist: false });
await new Promise(() => {});
`,
    );
    await Deno.writeTextFile(
      join(dir, "App.tsx"),
      `export default function App() { return <div>Hello</div>; }\n`,
    );
    const electron = join(dir, "electron");
    await Deno.writeTextFile(
      electron,
      `#!/bin/sh\nexec "${Deno.execPath()}" run -A --config "${DENO_JSON}" ` +
        `"${join(REPO, "tests/fixtures/uds-dialog-standin.ts")}"\n`,
    );
    await Deno.chmod(electron, 0o755);

    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        DENO_JSON,
        join(dir, "app.ts"),
        "--client=electron",
      ],
      cwd: dir,
      env: {
        ...Deno.env.toObject(),
        AIO_APPS_DIR: apps,
        ELECTRON_PATH: electron,
        AIO_DIALOG_STANDIN_OUT: outFile,
        // No zenity/kdialog either way: the spawned-tool path would THROW
        // ("no file dialog available") rather than pass by accident.
        PATH: "/usr/bin/false-path-for-pick-e2e",
      },
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let log = "";
    const drain = (s: ReadableStream<Uint8Array>) =>
      s.pipeTo(
        new WritableStream({
          write: (c) => {
            log = (log + new TextDecoder().decode(c)).slice(-8000);
          },
        }),
      ).catch(() => {});
    const drained = Promise.all([drain(child.stdout), drain(child.stderr)]);
    try {
      const deadline = Date.now() + 90_000;
      let text = "";
      while (Date.now() < deadline) {
        text = await Deno.readTextFile(outFile).catch(() => "");
        if (text) break;
        await new Promise((r) => setTimeout(r, 200));
      }
      if (!text) {
        throw new Error(`the stand-in never finished; app log:\n${log}`);
      }
      const rec = JSON.parse(text) as {
        asked: { kind: string; title: string; id: string };
        ack: { cid: string; ok: boolean; value?: unknown; error?: string };
      };
      assertEquals(rec.asked.kind, "files");
      assertEquals(rec.asked.title, "e2e pick");
      assertEquals(
        rec.ack,
        {
          cid: "k1",
          ok: true,
          value: ["/picked/one.txt", "/picked/two words.txt"],
        },
        `the method must resolve with the window's pick; app log:\n${log}`,
      );
    } finally {
      try {
        child.kill("SIGTERM");
      } catch { /* already gone */ }
      await child.status;
      await drained;
    }
  },
});

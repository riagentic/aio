// The same promise as shutdown-signal-says-why.test.ts, kept by a real
// process: a desktop app that is signalled writes WHICH signal stopped it to
// its console and to app.log, above the `stopped uptime=…` line that used to
// stand alone. SIGHUP has its own listener (desktop apps only), so it is
// delivered here too.
//
// A stop asked for over the control API (`am stop`) is the same kind of
// outside ask and says so the same way — also when aio is embedded
// (`libraryMode`), where the app closes and the host process lives on.
//
// No window: "Electron" is a script that sleeps, on a display nothing listens
// on. Linux-only, as the SIGHUP rule reads /proc.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { walk } from "@std/fs/walk";
import { childEnv, freePort } from "./e2e-app-harness.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A one-cell app in a temp dir whose entry is `appTs`, started with `args`.
 *  `out()` is everything it has printed so far. */
async function startApp(appTs: string, args: string[]) {
  const dir = await Deno.realPath(await tempDir("aio-sigwhy"));
  const head = JSON.parse(await Deno.readTextFile(join(ROOT, "deno.json")));
  const imports: Record<string, string> = {};
  for (
    const [k, v] of Object.entries(head.imports as Record<string, string>)
  ) {
    imports[k] = v.startsWith("./") ? `${ROOT}/${v.slice(2)}` : v;
  }
  await Deno.mkdir(join(dir, "src"));
  await Deno.writeTextFile(
    join(dir, "deno.json"),
    JSON.stringify({ compilerOptions: head.compilerOptions, imports }),
  );
  await Deno.writeTextFile(
    join(dir, "src", "cell.ts"),
    `import { cell } from "aio";\nexport const c = cell("c", { state: { n: 0 }, methods: { inc(s) { s.n++; } } });\n`,
  );
  await Deno.writeTextFile(
    join(dir, "src", "App.tsx"),
    `import { c } from "./cell.ts";\nexport default function App() { return <p>{c.n}</p>; }\n`,
  );
  await Deno.writeTextFile(join(dir, "src", "app.ts"), appTs);
  const fake = join(dir, "electron");
  await Deno.writeTextFile(fake, "#!/bin/sh\nexec sleep 120\n");
  await Deno.chmod(fake, 0o755);
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--config",
      join(dir, "deno.json"),
      join(dir, "src", "app.ts"),
      ...args,
    ],
    cwd: dir,
    env: {
      DISPLAY: ":995", // a desktop session by name only — nothing draws
      ELECTRON_PATH: fake,
      ...childEnv({ AIO_APPS_DIR: join(dir, "home") }),
    },
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  let out = "";
  const dec = new TextDecoder();
  const pump = (s: ReadableStream<Uint8Array>) =>
    (async () => {
      for await (const c of s) out += dec.decode(c);
    })();
  const pumps = Promise.all([pump(child.stdout), pump(child.stderr)]);
  return {
    child,
    out: () => out,
    /** Up to a minute for `ready()`; says what the app printed if it never is. */
    until: async (what: string, ready: () => boolean | Promise<boolean>) => {
      for (let i = 0; i < 600 && !(await ready()); i++) await sleep(100);
      assert(await ready(), `${what}:\n${out.slice(-2000)}`);
    },
    /** The exit status, or null when it is still running after `ms`. */
    exited: async (ms: number) => {
      let t: ReturnType<typeof setTimeout> | undefined;
      const st = await Promise.race([
        child.status,
        new Promise<null>((r) => t = setTimeout(() => r(null), ms)),
      ]);
      clearTimeout(t);
      return st;
    },
    appLog: async () => {
      let text = "";
      for await (
        const f of walk(join(dir, "home"), { match: [/app\.log$/] })
      ) {
        text += await Deno.readTextFile(f.path);
      }
      return text;
    },
    [Symbol.asyncDispose]: async () => {
      try {
        child.kill("SIGKILL");
      } catch { /* aio-ok: already exited */ }
      await child.status;
      await pumps;
    },
  };
}

/** `said` stands in `text`, above the `stopped uptime=…` line. */
function assertSaidAboveStop(text: string, said: string, where: string) {
  const at = text.indexOf(said);
  const stopped = text.search(/stopped\s+uptime=/);
  assert(at >= 0, `${where} does not say why:\n${text.slice(-2000)}`);
  assertEquals(
    [stopped >= 0, at < stopped],
    [true, true],
    `${where}: the reason must stand above the stop:\n${text.slice(-2000)}`,
  );
}

const RUN = `import "./cell.ts";\nimport { aio } from "aio";\n`;

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  Deno.test({
    name: `a desktop app stopped by ${sig} says so, in the console and app.log`,
    ignore: Deno.build.os !== "linux",
    fn: async () => {
      await using app = await startApp(
        `${RUN}await aio.run({ ui: { title: "Why" } });\n`,
        ["--client=electron", `--port=${freePort()}`],
      );
      await app.until(
        "the app never reached its window launch",
        () => app.out().includes("launching Electron"),
      );
      app.child.kill(sig);
      assert(
        await app.exited(30_000),
        `the app did not exit on ${sig}:\n${app.out().slice(-2000)}`,
      );
      const said = `${sig} received — stopping`;
      assert(app.out().includes(said), `console:\n${app.out().slice(-2000)}`);
      assertSaidAboveStop(await app.appLog(), said, "app.log");
    },
  });
}

/** Ask the app on `port` to stop, as `am stop` does. */
async function controlStop(port: number): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/__aio/trojan/shutdown`, {
    method: "POST",
    headers: { "X-AIO": "1" },
  });
  await res.body?.cancel();
  assertEquals(res.status, 200);
}

/** Whether the app on `port` answers yet. */
const answers = (port: number) =>
  fetch(`http://127.0.0.1:${port}/health`).then(
    (r) => r.body?.cancel().then(() => r.ok) ?? r.ok,
    () => false,
  );

const ASKED = "stop requested over the control API (am stop)";

Deno.test({
  name:
    "an app stopped over the control API says so, in the console and app.log",
  ignore: Deno.build.os !== "linux",
  fn: async () => {
    const port = freePort();
    await using app = await startApp(
      `${RUN}await aio.run({ client: "server-only", ui: { title: "Why" } });\n`,
      [`--port=${port}`],
    );
    await app.until("the app never answered", () => answers(port));
    await controlStop(port);
    const st = await app.exited(30_000);
    assert(st, `the app did not exit:\n${app.out().slice(-2000)}`);
    assertEquals(st.code, 0);
    const said = `${ASKED} — stopping`;
    assertSaidAboveStop(app.out(), said, "console");
    assertSaidAboveStop(await app.appLog(), said, "app.log");
  },
});

Deno.test({
  name:
    "an embedded app closed over the control API says so, and its host lives on",
  ignore: Deno.build.os !== "linux",
  fn: async () => {
    const port = freePort();
    await using app = await startApp(
      `${RUN}await aio.run({ client: "server-only", libraryMode: true, ui: { title: "Why" } });\n` +
        `setInterval(() => console.log("HOST-ALIVE"), 100);\n`,
      [`--port=${port}`],
    );
    await app.until("the app never answered", () => answers(port));
    await controlStop(port);
    await app.until(
      "the app never closed",
      () => /stopped\s+uptime=/.test(app.out()),
    );
    assertSaidAboveStop(app.out(), `${ASKED} — closing this app`, "console");
    // Closing the app is aio's to do; ending the process is the host's.
    const closedAt = app.out().search(/stopped\s+uptime=/);
    await app.until(
      "the host stopped with the app",
      () => app.out().indexOf("HOST-ALIVE", closedAt) > 0,
    );
    assertEquals(await app.exited(300), null, "the host process must not exit");
  },
});

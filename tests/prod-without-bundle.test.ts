// `--prod` with no dist/app.js is the NORMAL state after a fleet build:
// `deno task build` moves the bundle into the binary and removes the file.
// Running the source that way booted with "running (prod, browser)" and
// printed "open http://localhost:PORT" — and every page there answered 503
// with a body claiming the server was built `--headless`, which it was not.
// The compiled-binary case has been guarded for a while; the source case had
// only a debug line, invisible at the default log level.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { freePort } from "../src/testing/server-test.ts";

const ROOT = new URL("../", import.meta.url).pathname.replace(/\/$/, "");

async function probeApp(client: string): Promise<{
  text: string;
  status: number | null;
}> {
  const dir = await Deno.makeTempDir({ prefix: "aio-prod-nobundle-" });
  const home = join(dir, "home");
  await Deno.mkdir(home);
  await Deno.mkdir(join(dir, "src"));
  const port = freePort();
  try {
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({
        title: `prodnobundle-${port}`,
        version: "0.1",
        imports: {
          "aio": `${ROOT}/mod.ts`,
          "aio/": `${ROOT}/src/`,
          "immer": "npm:immer@10.2.0",
          "@std/path": "jsr:@std/path@1.1.2",
        },
      }),
    );
    await Deno.writeTextFile(
      join(dir, "src", "App.tsx"),
      `export default function App() { return <div>hi</div>; }\n`,
    );
    await Deno.writeTextFile(
      join(dir, "src", "cell.ts"),
      `import { cell } from "aio";\n` +
        `export const counter = cell("counter", {\n` +
        `  state: { n: 0 },\n  methods: { inc(s: { n: number }) { s.n++; } },\n});\n`,
    );
    await Deno.writeTextFile(
      join(dir, "src", "app.ts"),
      `import { aio } from "aio";\nimport "./cell.ts";\n` +
        `await aio.run({ port: ${port}, persist: false });\n`,
    );
    // NOTE: no dist/ at all — exactly what `deno task build` leaves behind.
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-Aq",
        join(dir, "src", "app.ts"),
        "--prod",
        `--client=${client}`,
      ],
      cwd: dir,
      env: {
        PATH: Deno.env.get("PATH") ?? "",
        HOME: home,
        AIO_APPS_DIR: home,
        DENO_DIR: Deno.env.get("DENO_DIR") ??
          join(Deno.env.get("HOME") ?? ".", ".cache", "deno"),
      },
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    let status: number | null = null;
    try {
      for (let i = 0; i < 80; i++) {
        await new Promise((r) => setTimeout(r, 250));
        try {
          const res = await fetch(`http://127.0.0.1:${port}/`);
          status = res.status;
          await res.body?.cancel();
          break;
        } catch { /* not up yet */ }
      }
    } finally {
      try {
        child.kill("SIGTERM");
      } catch { /* gone */ }
      const out = await child.output();
      const text = new TextDecoder().decode(out.stdout) +
        new TextDecoder().decode(out.stderr);
      return { text, status };
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test({
  name: "--prod with no dist/app.js: the terminal says so, beside the URL",
  ignore: Deno.build.os === "windows",
  async fn() {
    const r = await probeApp("browser");
    assertEquals(r.status, 503, `the page really is unservable:\n${r.text}`);
    assertStringIncludes(r.text, "no");
    assert(
      /there is no .*dist\/app\.js to serve/.test(r.text),
      `boot must name the missing bundle, at a level people see:\n${r.text}`,
    );
    assertStringIncludes(r.text, "deno task build");
    assertStringIncludes(r.text, "deno task dev");
    // …and it is a WARN, not a debug line suppressed at the default level.
    assert(
      /WARN[^\n]*dist\/app\.js/.test(r.text),
      `a debug line is invisible — that is how this shipped:\n${r.text}`,
    );
  },
});

Deno.test({
  name: "--prod headless: no page, so no complaint about a page",
  ignore: Deno.build.os === "windows",
  async fn() {
    const r = await probeApp("server-only");
    assert(
      !/there is no .*dist\/app\.js to serve/.test(r.text),
      `a headless run serves no page and needs no bundle:\n${r.text}`,
    );
  },
});

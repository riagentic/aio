// `am` reads the port chain's bottom rung too.
//
// The runtime binds `--port` > `AIO_PORT` > `aio.run({ port })` >
// `AIO_DEFAULT_PORT` > a free one, and the generated systemd unit sets
// `AIO_DEFAULT_PORT=3000`. `declaredPort` stopped at the third rung, so `am` in
// the unit's environment said "the app picks a free port" (and probed nothing)
// about a service that binds 3000 on every restart — two deciders, one fact.
//
// Each case runs `declaredPort()` in a child whose cwd is a throwaway project,
// because the entry it reads is resolved from the cwd and cached per process.
import { assertEquals } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { spec } from "./module-spec-helper.ts";

const AM_UTILS = new URL("../src/am/am-utils.ts", import.meta.url).href;
// The repo's import map, so the child resolves `@std/*` the way the suite does;
// the throwaway project's own deno.json is still what `am` finds from the cwd.
const REPO_CONFIG = fromFileUrl(new URL("../deno.json", import.meta.url));

async function declaredIn(
  entryPort: number | undefined,
  env: Record<string, string>,
  extra = "",
  denoJson = `{"appId":"rungprobe"}`,
): Promise<string> {
  const proj = await tempDir("aio-am-default-rung-");
  try {
    await Deno.writeTextFile(join(proj, "deno.json"), denoJson);
    await Deno.mkdir(join(proj, "src"));
    await Deno.writeTextFile(
      join(proj, "src", "app.ts"),
      `aio.run({ appId: "rungprobe"${
        entryPort === undefined ? "" : `, port: ${entryPort}`
      }${extra} });\n`,
    );
    await Deno.writeTextFile(
      join(proj, "probe.ts"),
      `import { declaredPort } from "${spec(AM_UTILS)}";\n` +
        `console.log(String(declaredPort()));\n`,
    );
    const base = Deno.env.toObject();
    delete base.AIO_PORT;
    delete base.AIO_DEFAULT_PORT;
    const r = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--no-check",
        "--config",
        REPO_CONFIG,
        join(proj, "probe.ts"),
      ],
      cwd: proj,
      env: { ...base, ...env },
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const out = new TextDecoder().decode(r.stdout).trim();
    assertEquals(r.code, 0, new TextDecoder().decode(r.stderr));
    return out.split("\n").at(-1)!;
  } finally {
    await dropTempDir(proj);
  }
}

Deno.test("declaredPort: AIO_DEFAULT_PORT is the rung below aio.run({ port })", async () => {
  assertEquals(
    await declaredIn(undefined, { AIO_DEFAULT_PORT: "3000" }),
    "3000",
    "am must aim where the unit's service binds, not call it a free port",
  );
  assertEquals(
    await declaredIn(8123, { AIO_DEFAULT_PORT: "3000" }),
    "8123",
    "the app's own port outranks the default",
  );
  assertEquals(
    await declaredIn(8123, { AIO_DEFAULT_PORT: "3000", AIO_PORT: "9100" }),
    "9100",
  );
  // 0 is "pick a free one" — the same as saying nothing, so no port to aim at.
  assertEquals(
    await declaredIn(undefined, { AIO_DEFAULT_PORT: "0" }),
    "undefined",
  );
  assertEquals(await declaredIn(undefined, {}), "undefined");
});

// `electron: { ignoreDebugEnv: true }` takes `AIO_PORT` / `AIO_DEFAULT_PORT`
// out of an Electron client's boot. `am` still counted them, so it aimed at
// (and refused over) a port the app had said it would not open.
Deno.test("declaredPort: an app that ignores the debug env has no env rung", async () => {
  const ignore = ", electron: { ignoreDebugEnv: true }";
  const env = { AIO_PORT: "9100", AIO_DEFAULT_PORT: "3000" };
  assertEquals(await declaredIn(undefined, env, ignore), "undefined");
  assertEquals(await declaredIn(4100, env, ignore), "4100");
  // Only the Electron client ignores: a server run of the same app reads them.
  assertEquals(
    await declaredIn(undefined, env, ignore + ', client: "server-only"'),
    "9100",
  );
  assertEquals(
    await declaredIn(
      undefined,
      env,
      ignore,
      `{"appId":"rungprobe","client":"browser"}`,
    ),
    "9100",
  );
  // `false` is the key unset.
  assertEquals(
    await declaredIn(undefined, env, ", electron: { ignoreDebugEnv: false }"),
    "9100",
  );
});

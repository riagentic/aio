// Round 3 (am): `am` names a top-level deno.json "port" it no longer reads
// (the runtime ignores it too). The note read the file with `JSON.parse` on
// `deno.json` only, so a deno.jsonc — or a deno.json with one `//` comment,
// which Deno accepts — got no note at all. It now uses the shared JSONC reader.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const AM_UTILS = new URL("../src/am/am-utils.ts", import.meta.url).href;
const REPO_CONFIG = new URL("../deno.json", import.meta.url).pathname;

async function stderrOf(name: string, text: string): Promise<string> {
  const proj = await tempDir("aio-am-port-note-");
  try {
    await Deno.writeTextFile(join(proj, name), text);
    await Deno.mkdir(join(proj, "src"));
    await Deno.writeTextFile(
      join(proj, "src", "app.ts"),
      `aio.run({ appId: "portnote" });\n`,
    );
    await Deno.writeTextFile(
      join(proj, "probe.ts"),
      `import { declaredPort } from "${AM_UTILS}";\n` +
        `console.log(String(declaredPort()));\n`,
    );
    const env = Deno.env.toObject();
    delete env.AIO_PORT;
    delete env.AIO_DEFAULT_PORT;
    const r = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--no-check", "--config", REPO_CONFIG, "probe.ts"],
      cwd: proj,
      env,
      clearEnv: true,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const err = new TextDecoder().decode(r.stderr);
    assertEquals(r.code, 0, err);
    return err;
  } finally {
    await dropTempDir(proj);
  }
}

Deno.test("am: the ignored deno.json port is named for a commented deno.json and a deno.jsonc", async () => {
  const commented =
    `{\n  // dev port\n  "appId": "portnote",\n  "port": 4321\n}\n`;
  for (const name of ["deno.json", "deno.jsonc"]) {
    const err = await stderrOf(name, commented);
    assert(
      err.includes(`top-level "port": 4321`),
      `${name}: the note must be said — got: ${err}`,
    );
  }
});

// The test harness's app sandbox (`AIO_APPS_DIR` = `<test root>/apps-*`) is
// ONE dir per process, removed when the last test file using it unloads.
//
// `deno test` runs every file in one process with one environment but fires
// `unload` per file: the first file removed the dir while `AIO_APPS_DIR` still
// named it, the next file read that as a runner's pin, recreated it by using
// it, and nothing removed it again — one `apps-*` left per multi-file run.
import { assertEquals } from "@std/assert";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const STRICT = new URL("../src/testing/test-strict.ts", import.meta.url).href;
const file = (n: string) =>
  `import { _armTestStrict } from ${JSON.stringify(STRICT)};
Deno.test("${n}", () => {
  _armTestStrict();
  const d = Deno.env.get("AIO_APPS_DIR")!;
  Deno.mkdirSync(d + "/app-${n}", { recursive: true });
  Deno.writeTextFileSync(d + "/app-${n}/x", "1");
});
`;

for (const parallel of [false, true]) {
  Deno.test(`test harness: a ${parallel ? "--parallel " : ""}multi-file run leaves no apps-* sandbox behind`, async () => {
    const dir = await tempDir("aio-apps-sandbox-");
    try {
      const root = `${dir}/root`;
      await Deno.mkdir(root);
      // Eight: under --parallel they arm on several threads at once.
      const names = ["a", "b", "c", "d", "e", "f", "g", "h"];
      for (const n of names) {
        await Deno.writeTextFile(`${dir}/${n}.test.ts`, file(n));
      }
      const env = Deno.env.toObject();
      for (
        const k of [
          "AIO_APPS_DIR",
          "AIO_APPS_SANDBOX",
        ]
      ) delete env[k];
      const o = await new Deno.Command(Deno.execPath(), {
        args: [
          "test",
          "-A",
          "--no-lock",
          "--no-config",
          ...(parallel ? ["--parallel"] : []),
          ...names.map((n) => `${dir}/${n}.test.ts`),
        ],
        env: { ...env, AIO_TEST_ROOT: root, NO_COLOR: "1" },
        clearEnv: true,
        stdout: "piped",
        stderr: "piped",
      }).output();
      const text = new TextDecoder().decode(o.stdout) +
        new TextDecoder().decode(o.stderr);
      assertEquals(o.code, 0, text);
      const left = [...Deno.readDirSync(root)].map((e) => e.name)
        .filter((n) => n.startsWith("apps-"));
      assertEquals(left, [], "a sandbox outlived its run");
    } finally {
      await dropTempDir(dir);
    }
  });
}

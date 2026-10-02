// A usage line names a command that exists.
//
// `am timetravel goto` with no id (or an empty one) answered
// `usage: am tt goto <index>` — `am tt` was removed in alpha70 and the CLI
// refuses it by name, and help calls the argument `<id>`. A reader who typed
// what the error told them got a second error.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { freePort } from "../src/testing/server-test.ts";

const AM = new URL("../src/am.ts", import.meta.url).pathname;

Deno.test("am timetravel goto: the usage error spells the command as help does", async () => {
  // Refused before anything is asked of an app: no server is needed, and the
  // port is one nothing listens on.
  const port = String(freePort());
  for (const args of [["goto"], ["goto", ""], ["goto", "abc"]]) {
    const r = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--unstable-kv",
        AM,
        "--json",
        `--port=${port}`,
        "timetravel",
        ...args,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const dec = new TextDecoder();
    const out = dec.decode(r.stdout) + dec.decode(r.stderr);
    assertEquals(r.code, 1, out);
    assertStringIncludes(out, "usage: am timetravel goto <id>");
    assert(!/\bam tt\b/.test(out), out);
  }
});

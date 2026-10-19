// docs/clients/cli-toolkit.md lists the accepted spellings as "`--url=x`,
// `--url x`, `-n 3`" — but its own spec declared `n` with no `short`, and a
// short form exists only when declared, so the documented `-n 3` was refused
// ("unknown flag: -n"). The doc's spec now declares it; this pins that the
// spelling the page shows works against the spec the page shows.
import { assertEquals } from "@std/assert";
import { args, testIO } from "../src/cli.ts";

Deno.test("cli-toolkit.md: `-n 3` parses against the documented spec", async () => {
  const doc = await Deno.readTextFile(
    new URL("../docs/clients/cli-toolkit.md", import.meta.url),
  );
  const line = doc.split("\n").find((l) => l.trimStart().startsWith("n: {"));
  assertEquals(line?.includes('short: "n"'), true, `spec line: ${line}`);
  const a = args(
    {
      name: "todo",
      flags: { n: { type: "number", short: "n", required: true } },
    },
    { argv: ["-n", "3"], io: testIO() },
  );
  assertEquals(a.flags.n, 3);
});

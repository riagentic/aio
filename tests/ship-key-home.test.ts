// `am publish --key=~/keys/app.json` is the form the usage text teaches, and
// no shell expands a `~` after `=`: it was read as `./~/keys/app.json`.
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { expandHome, resolveSigningKey } from "../src/build/ship.ts";
Deno.test("resolveSigningKey: a leading ~/ is the home directory; any other ~ is refused by name", async () => {
  const home = () => "/home/me";
  assertEquals(
    expandHome("~/keys/app.json", "linux", home),
    join("/home/me", "keys", "app.json"),
  );
  assertEquals(expandHome("~", "linux", home), "/home/me");
  assertEquals(expandHome("/abs/k.json", "linux", home), "/abs/k.json");
  assertEquals(expandHome("rel/~/k.json", "linux", home), "rel/~/k.json");
  // `~\` is a home path on Windows only — on POSIX a backslash is a name byte.
  assertEquals(
    expandHome("~\\keys\\app.json", "windows", () => "C:\\Users\\me")
      .startsWith("C:\\Users\\me"),
    true,
  );
  assertThrows(
    () => expandHome("~\\keys", "linux", home),
    Error,
    "--key=~\\keys",
  );
  assertThrows(
    () => expandHome("~alice/k.json", "linux", home),
    Error,
    '"~alice"',
  );
  // …and the decider applies it.
  const got = await resolveSigningKey("~/k.json", "any");
  assertEquals(got.source, "flag");
  assertEquals(got.path!.includes("~"), false, got.path);
  await assertRejects(
    () => resolveSigningKey("~bob/k.json", "any"),
    Error,
    "~bob",
  );
});

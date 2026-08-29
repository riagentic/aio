// `am create` refuses a flag it does not know.
//
// The parser ended at the positional-name branch, so anything it did not
// recognise fell off the end in silence. Measured:
//
//     $ am create audit28 --dir=/tmp/somewhere
//     {"created":"audit28","dir":"/home/dev/code/gen/aio/audit28", …}
//
// — success, in the current directory, naming a path the user had not asked
// for. It scaffolded an app INSIDE the framework repo. The project's own words,
// in `server/config.ts` about deno.json keys: "silently ignoring input is the
// worst available behaviour". `am lab` and `am log` have refused unknown flags
// for releases; this is the same rule in the verb people run first.
// Found by the randomized audit's "be a user" round.
import { assertEquals, assertStringIncludes, assertThrows } from "@std/assert";
import { parseCreateArgs } from "../src/am/am-cmd-create.ts";

Deno.test("am create: an unknown flag is refused, naming the accepted ones", () => {
  for (const flag of ["--dir=/tmp/x", "--dir", "--name=x", "-d", "--Force"]) {
    const e = assertThrows(() => parseCreateArgs(["app", flag])) as Error;
    assertStringIncludes(e.message, "unknown flag");
    assertStringIncludes(e.message, flag.split("=")[0]!);
    assertStringIncludes(e.message, "--template=");
    assertStringIncludes(e.message, "--target=");
  }
});

Deno.test("am create: the refusal says where the app IS created", () => {
  // `--dir` is the flag people reach for, and the answer is not "use this one
  // instead" — it is "there isn't one". A refusal that does not say so leaves
  // the reader looking for the right spelling of a flag that never existed.
  const e = assertThrows(() =>
    parseCreateArgs(["app", "--dir=/tmp/x"])
  ) as Error;
  assertStringIncludes(e.message, "./<name>");
  assertStringIncludes(e.message, "there is no --dir");
});

Deno.test("am create: every real flag still parses", () => {
  assertEquals(parseCreateArgs(["myapp"]), {
    name: "myapp",
    template: "counter",
    target: "browser",
    force: false,
  });
  const full = parseCreateArgs([
    "myapp",
    "--template=todo",
    "--target=electron",
    "--aio-version=v1.2.3",
    "--mirror=/tmp/m",
    "--jsr",
    "--force",
  ]);
  assertEquals(full.name, "myapp");
  assertEquals(full.template, "todo");
  assertEquals(full.target, "electron");
  assertEquals(full.aioVersion, "v1.2.3");
  assertEquals(full.mirror, "/tmp/m");
  assertEquals(full.jsr, true);
  assertEquals(full.force, true);
  // The bare aliases too.
  assertEquals(parseCreateArgs(["a", "--dev"]).mirror, "");
  assertEquals(parseCreateArgs(["a", "--mirror"]).mirror, "");
  // A cli template with no --target defaults to cli, not browser.
  assertEquals(parseCreateArgs(["a", "--template=cli"]).target, "cli");
});

Deno.test("am create: a bad --target is still refused by name", () => {
  const e = assertThrows(() =>
    parseCreateArgs(["a", "--target=nope"])
  ) as Error;
  assertStringIncludes(e.message, "unknown --target=nope");
});

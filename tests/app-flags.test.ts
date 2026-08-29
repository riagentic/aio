// An app can declare its OWN flags — and the strict refusal stays.
//
// aio refuses an unknown flag rather than ignoring it, and that is right:
// `--experse` used to warn and boot, with the app bound to 127.0.0.1 while its
// author believed it was on the LAN. What was missing is a way for an app with
// its own verbs to take part.
//
// The escape the error offered — "put an app's own arguments after a bare
// `--`" — cannot work for a compiled binary that bakes arguments into its
// argv: the baked ones come first, the operator types theirs last, and no
// position satisfies both. A field report (dm, a relay documenting six verbs
// in its own `--help`) found its two fall-through verbs KILLED the process:
//
//     $ dm-relay --update
//     error: Uncaught (in promise) Error: [aio] unknown flag: --update
//
// …so the relay's self-update verb and its replace-the-running-build verb were
// the two things it could not do. It worked around this by deleting its words
// out of `Deno.args` with `Object.defineProperty` before calling `aio.run()`,
// which works only because that descriptor happens to be configurable.
import { assert, assertStringIncludes, assertThrows } from "@std/assert";
import {
  _resetParsedCli,
  declareAppFlags,
  parseCli,
} from "../src/server/aio-cli.ts";

function reset() {
  _resetParsedCli();
}

Deno.test("appFlags: a declared flag is passed through, not refused", () => {
  reset();
  assertThrows(
    () => parseCli(["--sync"]),
    Error,
    "unknown flag",
    "undeclared, it must still be refused",
  );
  declareAppFlags(["--sync", "--user="]);
  // Neither throws, and neither becomes one of aio's own values.
  parseCli(["--sync"]);
  parseCli(["--user=ada"]);
  parseCli(["--sync", "--user=ada", "--verbose"]);
  reset();
});

Deno.test("appFlags: everything else is STILL refused", () => {
  reset();
  declareAppFlags(["--sync"]);
  assertThrows(() => parseCli(["--nope"]), Error, "unknown flag");
  // …and a typo in an APP flag gets the same did-you-mean as aio's own.
  const e = assertThrows(() => parseCli(["--snyc"]), Error) as Error;
  assertStringIncludes(e.message, "--sync");
  reset();
});

Deno.test("appFlags: a name aio already owns is refused at declaration", () => {
  reset();
  const e = assertThrows(
    () => declareAppFlags(["--port="]),
    Error,
  ) as Error;
  assertStringIncludes(e.message, "one of aio's own flags");
  // A flag cannot mean two things in one process; the app must pick another.
  assertStringIncludes(e.message, "pick another name");
  reset();
});

Deno.test("appFlags: a value that is not a flag is refused with the spelling", () => {
  reset();
  const e = assertThrows(() => declareAppFlags(["sync"]), Error) as Error;
  assertStringIncludes(e.message, "is not a flag");
  assertStringIncludes(e.message, '"--sync"');
  reset();
});

Deno.test("appFlags: declaring resets a parse made under the old vocabulary", () => {
  reset();
  declareAppFlags(["--sync"]);
  parseCli(["--sync"]); // accepted under the declaration
  declareAppFlags([]); // …and withdrawn by the next one
  assertThrows(() => parseCli(["--sync"]), Error, "unknown flag");
  reset();
});

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

// ── …and it must work through aio.run(), which is where it did NOT ──────────
//
// Every test above calls `declareAppFlags` directly, and all of them passed
// while the feature was dead end to end: `aio.run()` called `parseCli()` for
// the `--help` query ~120 lines BEFORE it declared the app's flags, and
// `parseCli` refuses an unknown flag by throwing. So the field report that
// asked for this (dm §5) got a feature that could not be used, and the
// workaround it had already invented — deleting its own words out of
// `Deno.args` before calling `aio.run()` — remained the only thing that
// worked.
//
// This drives the real binary, because `Deno.args` is the whole point: a
// harness that hands the parser a fabricated array cannot see this bug. It is
// the transport-boundary gap in todo.md, in miniature.
const ROOT = new URL("..", import.meta.url).pathname;

async function bootWithArgs(
  args: string[],
): Promise<{ out: string; code: number }> {
  const probe = `${ROOT}tests/.app-flags-probe.tmp.ts`;
  await Deno.writeTextFile(
    probe,
    `import { aio } from "../mod.ts";\n` +
      `import { cell } from "../src/state/cell.ts";\n` +
      `const c = cell("appflagprobe", { state: { n: 0 }, methods: {} });\n` +
      `const app = await aio.run({\n` +
      `  cells: [c], appId: "appflagprobe", client: "server-only",\n` +
      `  persist: false, libraryMode: true, singleton: false, port: 0,\n` +
      `  baseDir: Deno.makeTempDirSync(), dbPath: ":memory:",\n` +
      `  appFlags: ["--sync", "--user="],\n` +
      `} as never);\n` +
      `console.log("BOOTED");\n` +
      `await (app as unknown as { close?: () => Promise<void> }).close?.();\n`,
  );
  try {
    const r = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", probe, ...args],
      cwd: ROOT,
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      out: new TextDecoder().decode(r.stdout) +
        new TextDecoder().decode(r.stderr),
      code: r.code,
    };
  } finally {
    await Deno.remove(probe).catch(() => {});
  }
}

Deno.test("appFlags: a declared flag survives aio.run() with it in argv", async () => {
  for (const arg of ["--sync", "--user=bob"]) {
    const { out, code } = await bootWithArgs([arg]);
    assert(
      out.includes("BOOTED"),
      `aio.run() refused the declared flag ${arg}:\n${out.slice(0, 500)}`,
    );
    assert(code === 0, `exit ${code} for ${arg}`);
  }
});

Deno.test("appFlags: an UNDECLARED flag is still refused — the strictness is the point", async () => {
  const { out, code } = await bootWithArgs(["--nope"]);
  assertStringIncludes(out, "unknown flag: --nope");
  assert(code !== 0, "an unknown flag must not boot the app");
});

// A value `am` cannot act on is an ERROR — never a guess, and never the one
// that happened to come last.
//
// `parseGlobalFlags` reads the command line left to right and assigns as it
// goes, so two spellings of "I could not say what you meant" came out as
// confident answers:
//
//  1. AN EMPTY VALUE WAS DROPPED. `--app=` set `flags.app = ""`, which is
//     falsy, so `resolveAmAppId` fell through to inference and `am` addressed
//     whatever the cwd looks like. `am stop --app="$APP"` with `APP` unset
//     stopped a DIFFERENT app from the one the script named, in silence.
//     `--entry=` did the same one layer down: the empty value vanished and the
//     default entry was launched. Their siblings already refuse — `--home=`
//     ("--home needs a directory") and `--instance=` ("--instance needs a
//     simple name") — so this was a gap in one parser, not a policy.
//  2. A FLAG GIVEN TWICE SILENTLY TOOK THE LAST. `am data --app=one
//     --app=two` answered for `two`, `--home=/a --home=/b` used `/b`,
//     `--port=1 --port=2` used `2`. Two values for one flag is a
//     contradiction, not a preference — and the verbs on the other side of it
//     delete data directories. `am build` already refuses its own version of
//     this ("targets were given twice … Use one").
//
// The whole point is that BOTH are caught before any verb runs, so no command
// has to grow its own opinion about them.
import { assert, assertEquals } from "@std/assert";
import { parseGlobalFlags } from "../src/am/am-utils.ts";

Deno.test("an empty value for a flag that names a target is refused", () => {
  // [argv, the flag the message must name]
  const cases: [string[], string][] = [
    [["status", "--app="], "--app"],
    [["--app=", "status"], "--app"],
    [["start", "--entry="], "--entry"],
    [["dispatch", "--app=", "c:m"], "--app"],
  ];
  for (const [argv, flag] of cases) {
    const { flags } = parseGlobalFlags([...argv]);
    assert(
      flags.error,
      `${argv.join(" ")}: an empty ${flag} must be refused, not inferred`,
    );
    assert(
      flags.error!.includes(flag),
      `${argv.join(" ")}: the message must name ${flag} — got "${flags.error}"`,
    );
    // Doctrine: every error names the fix, so the refusal shows the spelling.
    assert(
      flags.error!.includes(`${flag}=`),
      `${argv.join(" ")}: the message must show the fix — got "${flags.error}"`,
    );
  }
});

Deno.test("the same flag twice with two different values is refused", () => {
  // [argv, the flag the message names, the two values it has to show]
  const cases: [string[], string, [string, string]][] = [
    [["data", "--app=one", "--app=two"], "--app", ["one", "two"]],
    [["data", "--home=/a", "--home=/b"], "--home", ["/a", "/b"]],
    [["status", "--port=1", "--port=2"], "--port", ["1", "2"]],
    [["logs", "--lines=10", "--lines=20"], "--lines", ["10", "20"]],
    [["surface", "--client-index=0", "--client-index=1"], "--client-index", [
      "0",
      "1",
    ]],
    [["start", "--timeout=1000", "--timeout=2000"], "--timeout", [
      "1000",
      "2000",
    ]],
    // The `--k v` spelling expands to `--k=v`, so it is the same flag twice.
    [["data", "--app", "one", "--app", "two"], "--app", ["one", "two"]],
    // …and mixing the two spellings must not hide it either.
    [["data", "--app=one", "--app", "two"], "--app", ["one", "two"]],
  ];
  for (const [argv, flag, values] of cases) {
    const { flags } = parseGlobalFlags([...argv]);
    assert(
      flags.error,
      `${argv.join(" ")}: two values for ${flag} must be refused`,
    );
    assert(
      flags.error!.includes(flag),
      `${argv.join(" ")}: the message must name ${flag} — got "${flags.error}"`,
    );
    // Both values, so the reader can see which one their script produced.
    assertEquals(values.length, 2, "each row names both values");
    for (const v of values) {
      assert(
        flags.error!.includes(`"${v}"`),
        `${
          argv.join(" ")
        }: the message must show "${v}" — got "${flags.error}"`,
      );
    }
  }
});

Deno.test("the short and deprecated spellings of the client index count as the flag", () => {
  // The client index has four spellings, and the refusal used to see only the
  // two that arrive as `--client-index=N`. `-i2` (attached) and `--client=2`
  // (deprecated) carried a second, different value straight past it, so
  //
  //     am trigger "Save" click -i2 --client-index=3
  //
  // drove client 3, and the same line with its two flags SWAPPED drove client
  // 2 — the silent last-one-wins this refusal exists to end, in the command
  // where the value decides which live client is acted on.
  for (
    const argv of [
      ["trigger", "p", "click", "-i2", "--client-index=3"],
      ["trigger", "p", "click", "--client-index=3", "-i2"],
      ["surface", "--client=2", "-i", "3"],
    ]
  ) {
    const { flags } = parseGlobalFlags([...argv]);
    assert(
      flags.error,
      `${argv.join(" ")}: two client indexes must be refused`,
    );
    for (const v of ["2", "3"]) {
      assert(
        flags.error!.includes(`"${v}"`),
        `${
          argv.join(" ")
        }: the message must show "${v}" — got "${flags.error}"`,
      );
    }
  }
  // The SAME index in two spellings is one answer, and still runs.
  const same = parseGlobalFlags(["trigger", "p", "click", "-i2", "-i", "2"]);
  assert(!same.flags.error, String(same.flags.error));
  assertEquals(same.flags.client, 2);
  // `--client=<kind>` is the app runtime's flag, not an index — untouched.
  const kind = parseGlobalFlags(["ui", "--client=browser", "-i2"]);
  assert(!kind.flags.error, String(kind.flags.error));
  assertEquals(kind.flags.clientKind, "browser");
  assertEquals(kind.flags.client, 2);
});

Deno.test("the strictness cuts contradictions, not use", () => {
  // The SAME value twice is not a contradiction — a wrapper script that adds
  // `--app=x` to a line that already had it still works.
  const same = parseGlobalFlags(["data", "--app=x", "--app=x"]);
  assert(!same.flags.error, String(same.flags.error));
  assertEquals(same.flags.app, "x");

  // One of each is the ordinary case.
  const ok = parseGlobalFlags(["logs", "--app=x", "--lines=20", "--follow"]);
  assert(!ok.flags.error, String(ok.flags.error));
  assertEquals(ok.flags.app, "x");
  assertEquals(ok.flags.lines, 20);

  // A repeated BOOLEAN says the same thing twice and means it once.
  const bools = parseGlobalFlags(["status", "--json", "--json", "--all"]);
  assert(!bools.flags.error, String(bools.flags.error));
  assertEquals(bools.flags.json, true);

  // After `--`, an argument that looks like a flag is an ARGUMENT — repeating
  // it is the caller's business, not am's.
  const past = parseGlobalFlags([
    "dispatch",
    "t:add",
    "--",
    "--app=a",
    "--app=b",
  ]);
  assert(!past.flags.error, String(past.flags.error));

  // An empty value for a flag where empty is a meaning, not a mistake.
  const filter = parseGlobalFlags(["logs", "--filter="]);
  assert(!filter.flags.error, String(filter.flags.error));
});

Deno.test("the refusal reaches the caller as a refusal (process-level)", async () => {
  const AM = new URL("../src/am.ts", import.meta.url).pathname;
  const CONFIG = new URL("../deno.json", import.meta.url).pathname;
  const run = async (...args: string[]) => {
    const o = await new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--config", CONFIG, AM, ...args],
      env: {
        ...Deno.env.toObject(),
        AIO_AM_NO_DELEGATE: "1",
        NO_COLOR: "1",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const dec = new TextDecoder();
    return {
      code: o.code,
      out: dec.decode(o.stdout),
      err: dec.decode(o.stderr),
    };
  };
  for (
    const args of [
      ["data", "--app=one", "--app=two", "--json"],
      ["data", "--app=", "--json"],
    ]
  ) {
    const r = await run(...args);
    assertEquals(r.code, 1, `am ${args.join(" ")}: ${r.out}${r.err}`);
    const doc = JSON.parse(r.out);
    assert(
      typeof doc.error === "string" && doc.error.includes("--app"),
      `am ${
        args.join(" ")
      }: --json must answer {error} naming --app — ${r.out}`,
    );
    // Never the answer for a guessed target.
    assert(
      doc.appId === undefined,
      `am ${args.join(" ")}: no result may be produced — ${r.out}`,
    );
  }
});

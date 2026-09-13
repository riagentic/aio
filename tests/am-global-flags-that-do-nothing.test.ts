// A global flag handed to a verb that never reads it did nothing, silently.
//
// `parseGlobalFlags` consumes every global flag after any verb, so the
// unknown-flag gate passes them all — and the verb did its default thing:
// `am actions --lines=1` printed the whole history, `am timeline --filter=zzzz`
// filtered nothing, `am timeline --follow` returned at once, `am status --all`
// answered for one app, `am sql --lines=1` ran unlimited. Each looks like a
// flag that works. Measured by a hunter running `am` as a user.
//
// Decided per flag: `--lines` on `actions` is IMPLEMENTED (the same "newest N"
// it means on timeline/logs/errors); the rest are WARNED about on stderr where
// they do nothing, naming the verbs that read them. Warned, not refused: they
// were accepted by every earlier release, and the CLI surface is frozen.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  GLOBAL_FLAGS,
  misplacedFlagError,
  PASSTHROUGH,
  SCOPED_GLOBAL_FLAGS,
  VERB_FLAGS,
} from "../src/am/am-flags.ts";
import { lastHistoryEntries } from "../src/am/am-cmd-state.ts";

Deno.test("am: the measured no-op flags are warned about, naming who reads them", () => {
  for (
    const [verb, flag, reader] of [
      ["timeline", "--filter=zzzz", "am logs"],
      ["timeline", "--follow", "am logs"],
      ["sql", "--lines=1", "am timeline"],
      ["status", "--all", "am stop"],
    ] as const
  ) {
    const e = misplacedFlagError(verb, [flag]);
    assert(e, `am ${verb} ${flag} was accepted and ignored`);
    assertStringIncludes(e, "ignored");
    assertStringIncludes(e, reader);
  }
});

Deno.test("am: a scoped flag is still accepted where it is read", () => {
  let n = 0;
  for (const [flag, verbs] of Object.entries(SCOPED_GLOBAL_FLAGS)) {
    assert(GLOBAL_FLAGS.includes(flag), `${flag} is not a global flag`);
    for (const v of verbs) {
      n++;
      assert(v in VERB_FLAGS, `${v} is not a gated verb`);
      assertEquals(misplacedFlagError(v, [`${flag}=1`]), null, `${v} ${flag}`);
    }
  }
  assert(n >= 13, "every scoped flag has a reader");
  assertEquals(misplacedFlagError("actions", ["--lines=1"]), null);
  assertEquals(misplacedFlagError("stop", ["--all"]), null);
  // Cross-cutting flags stay everywhere.
  for (const f of ["--json", "--app=x", "--port=1", "--quiet", "--wait=2"]) {
    assertEquals(misplacedFlagError("status", [f]), null, f);
  }
  // A forwarding verb is never judged; after `--` nothing is a flag.
  const forwarding = Object.keys(PASSTHROUGH);
  assert(forwarding.length >= 1);
  for (const v of forwarding) {
    assertEquals(misplacedFlagError(v, ["--lines=1", "--all"]), null, v);
  }
  assertEquals(misplacedFlagError("state", ["--", "--all"]), null);
  // The short spellings are the same flags.
  assert(misplacedFlagError("timeline", ["-f"]));
  assertEquals(misplacedFlagError("logs", ["-f"]), null);
});

Deno.test("am actions --lines=N: the newest N entries, and it says of how many", () => {
  const history = {
    entries: [0, 1, 2, 3, 4].map((id) => ({ id, type: `t${id}` })),
    index: 4,
    paused: false,
  };
  const r = lastHistoryEntries(history, 2) as typeof history & {
    shown: number;
    total: number;
  };
  assertEquals(r.entries.map((e) => e.id), [3, 4]);
  assertEquals(r.shown, 2);
  assertEquals(r.total, 5);
  assertEquals(
    r.index,
    4,
    "index is the app's own, a position in the FULL list",
  );
  assertEquals((lastHistoryEntries(history, 50) as { shown: number }).shown, 5);
});

Deno.test("am timeline --follow, end to end: warned on stderr, the verb still runs", async () => {
  const cwd = await Deno.makeTempDir({ prefix: "am-scoped-flag-" });
  try {
    const out = await new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "-A",
        "--config",
        new URL("../deno.json", import.meta.url).pathname,
        new URL("../src/am.ts", import.meta.url).pathname,
        "timeline",
        "--follow",
        "--json",
      ],
      cwd,
      env: {
        ...Deno.env.toObject(),
        AIO_APPS_DIR: cwd,
        AIO_AM_NO_DELEGATE: "1",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    // stdout stays one parseable JSON document (the verb's own answer — here
    // "no app", since nothing runs), and the warning is on stderr.
    JSON.parse(new TextDecoder().decode(out.stdout));
    assertStringIncludes(
      new TextDecoder().decode(out.stderr),
      "--follow does nothing for timeline",
    );
  } finally {
    await Deno.remove(cwd, { recursive: true });
  }
});

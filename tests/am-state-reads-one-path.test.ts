// `am state` read the FIRST positional and threw the rest away.
//
//     am state counter count     →  {"count": 5}   exit 0
//
// The dot is easy to forget and the answer looks like an answer: a whole
// object where a number was asked for, with nothing on either stream saying a
// word was dropped. `am state` is the primary scripting surface — the value it
// prints goes straight into a shell variable or an agent's next step — so a
// silently narrowed question is the worst shape this command has.
//
// The same swallow hid a real typo: `am state counter.count --wtch` reached
// the verb as a positional (only KNOWN flags are gated), was not a path, and
// the command answered for `counter.count` as if the flag had worked.
//
// One path per call. Two is a question am cannot answer, and the refusal shows
// the dotted spelling, which is what was meant every time we have seen it.
import { assert, assertEquals } from "@std/assert";
import {
  _braceHint,
  _extraPathError,
  _pathOfArgs,
} from "../src/am/am-cmd-state.ts";

Deno.test("am state: one path is read, several are refused", () => {
  // [args as the handler sees them, the refusal it must make]
  const refused: [string[], string][] = [
    [["counter", "count"], "counter.count"],
    [["todo", "items", "0"], "todo.items.0"],
    [["counter.count", "extra"], "counter.count.extra"],
    // The flag may sit on either side of the path — it is still one path.
    [["--watch", "a", "b"], "a.b"],
    [["a", "--watch", "b"], "a.b"],
  ];
  for (const [args, dotted] of refused) {
    const e = _extraPathError(args);
    assert(e, `${args.join(" ")}: two paths must be refused`);
    assert(
      e!.includes(dotted),
      `${
        args.join(" ")
      }: the message must show the fix "${dotted}" — got "${e}"`,
    );
    // Every one of the words the caller typed, so they can see what was read.
    const typed = args.filter((a) => !a.startsWith("-"));
    assert(typed.length >= 2, `${args.join(" ")}: the row must hold 2+ paths`);
    for (const a of typed) {
      assert(
        e!.includes(a),
        `${args.join(" ")}: must show "${a}" — got "${e}"`,
      );
    }
  }
});

Deno.test("am state: a field pick the SHELL expanded is told to quote itself", () => {
  // `am state fleet[0].{name,active}` is documented path syntax, and bash
  // expands the braces before am is started — so it arrived as two arguments
  // and the pick silently became its first field. The fix here is quoting,
  // not a dot, and the message has to say the right one.
  const e = _extraPathError(["fleet[0].name", "fleet[0].active"]);
  assert(e, "two expanded picks must be refused");
  assert(
    e!.includes("'fleet[0].{name,active}'"),
    `the message must show the quoted pick — got "${e}"`,
  );
  assert(!e!.includes("is dotted"), `the wrong hint — got "${e}"`);

  assertEquals(_braceHint(["a.b", "a.c"]), "a.{b,c}");
  assertEquals(_braceHint(["x[*].pair", "x[*].status"]), "x[*].{pair,status}");
  // The reconstruction round-trips: quoting what it prints gives back exactly
  // the arguments that arrived, whatever they were.
  assertEquals(_braceHint(["a.b", "a.b.c"]), "a.{b,b.c}");
  assertEquals(_braceHint(["counter", "count"]), null, "a forgotten dot");
  assertEquals(_braceHint(["a.b", "q.r"]), null, "no shared prefix");
});

Deno.test("am state: a ROOT field pick the shell expanded is named too", () => {
  // `am state {counter,page}` is documented path syntax — "pick from root" —
  // and bash expands it to exactly the two arguments a forgotten dot makes.
  // Nothing on the command line can tell the two apart, so the refusal that
  // names only ONE of them is wrong half the time: it sent a caller who wrote
  // the documented form to `am state counter.page`, a path that does not
  // resolve, for a second wrong answer in a row.
  const e = _extraPathError(["counter", "page"]);
  assert(e, "two paths must be refused");
  assert(
    e!.includes("am state counter.page"),
    `the forgotten dot is still named — got "${e}"`,
  );
  assert(
    e!.includes("'{counter,page}'"),
    `the quoted ROOT pick must be named too — got "${e}"`,
  );
  // A pick with a shared `prefix.` is NOT ambiguous: the brace form is the
  // only reading, and the message stays the single, certain one.
  const one = _extraPathError(["fleet[0].name", "fleet[0].active"]);
  assert(!one!.includes("is dotted"), `still one hint there — got "${one}"`);
});

Deno.test("am state: the ordinary calls are untouched", () => {
  for (
    const args of [
      [],
      ["counter.count"],
      ["--watch"],
      ["--watch", "counter.count"],
      ["counter.count", "--watch"],
      // A single path that CONTAINS spaces is one argument, not two.
      ["my key"],
    ]
  ) {
    assertEquals(
      _extraPathError(args),
      null,
      `${args.join(" ")}: must be accepted`,
    );
  }
  // The path is still found on either side of the flag.
  assertEquals(_pathOfArgs(["--watch", "counter.count"]), "counter.count");
  assertEquals(_pathOfArgs(["counter.count", "--watch"]), "counter.count");
  assertEquals(_pathOfArgs([]), undefined);
});

Deno.test("am state: the refusal is made before an app is even looked for", async () => {
  // It is a question about the COMMAND LINE, so it must not depend on there
  // being an app to ask — and a script must read it as a refusal, on stdout,
  // with a non-zero exit like every other one.
  const AM = new URL("../src/am.ts", import.meta.url).pathname;
  const CONFIG = new URL("../deno.json", import.meta.url).pathname;
  const o = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--config",
      CONFIG,
      AM,
      "state",
      "counter",
      "count",
      "--json",
    ],
    env: {
      ...Deno.env.toObject(),
      AIO_AM_NO_DELEGATE: "1",
      NO_COLOR: "1",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const dec = new TextDecoder();
  const out = dec.decode(o.stdout);
  assertEquals(o.code, 1, out + dec.decode(o.stderr));
  const doc = JSON.parse(out);
  assert(
    typeof doc.error === "string" && doc.error.includes("counter.count"),
    `--json must answer {error} showing the dotted path — got ${out}`,
  );
});

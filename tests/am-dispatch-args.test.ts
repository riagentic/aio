// `am dispatch` had no spelling for a method taking ONE STRING.
//
// A field report: `conn.setHost(host: string)`. Every DOCUMENTED form re-wrapped
// the value — `--body='{"args":["192.168.1.9"]}'` after a positional type became
// the method's single OBJECT argument, and `host=192.168.1.9` likewise. The app
// persisted `[object Object]` into an address field and it survived restarts.
// The only working spelling was the full envelope with no positional type,
// which `am help` did not show — help that implies a form which does not work
// is the bug, not the user's reading of it.
//
// `--args='["192.168.1.9"]'` is that spelling. These tests pin it end-to-end
// against a real app over the real trojan, and pin every pre-existing form
// unchanged beside it (compat is not a claim, it is a row in this table).
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetInstanceVerify } from "../src/am/am-http.ts";
import {
  cmdDispatch,
  DISPATCH_USAGE,
  parseArgsFlag,
} from "../src/am/am-cmd-state.ts";
import { parseGlobalFlags } from "../src/am/am-utils.ts";
import { cmdHelp } from "../src/am/am-cmd-meta.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";

const APP = "am-dispatch-args-app";
const CELL = "am-dispatch-args-conn";

type Recorded = { kind: string; json: string };

// ONE definition — re-calling cell() with the same name per test would print
// the duplicate-name warning, and a test that manufactures warnings teaches
// people to skim them.
const conn = cell(CELL, {
  state: { last: { kind: "none", json: "" } as Recorded },
  methods: {
    setHost(s: { last: Recorded }, host: unknown) {
      s.last = { kind: typeof host, json: JSON.stringify(host) ?? "" };
    },
  },
});

/** Boot a real app whose method RECORDS the argument it was handed — the only
 *  honest way to ask "what does the method actually receive". */
async function withApp(
  fn: (
    dispatch: (args: string[], flags: Partial<GlobalFlags>) => Promise<void>,
    received: () => Recorded,
  ) => Promise<void>,
): Promise<void> {
  _resetInstanceVerify();
  await using srv = await testServer<Record<string, { last: Recorded }>>({
    cells: [conn],
    appId: APP,
  });
  const realLog = console.log;
  console.log = () => {};
  try {
    await fn(
      (args, flags) =>
        cmdDispatch(args, {
          app: APP,
          port: srv.port,
          json: true,
          ...flags,
        } as GlobalFlags),
      () => srv.state()[CELL]!.last,
    );
  } finally {
    console.log = realLog;
  }
}

Deno.test({
  name: "am dispatch --args: a one-string method receives a STRING",
  async fn() {
    await withApp(async (dispatch, received) => {
      await dispatch([`${CELL}:setHost`], {
        jsonArgs: '["192.168.1.9"]',
      });
      assertEquals(
        received(),
        { kind: "string", json: '"192.168.1.9"' },
        "the method got the string, not { args: [...] } and not { host: … }",
      );
    });
  },
});

Deno.test({
  name:
    "am dispatch --args: JSON types survive, and every argument is positional",
  async fn() {
    await withApp(async (dispatch, received) => {
      // A number stays a number (the shell would have made it a string).
      await dispatch([`${CELL}:setHost`], { jsonArgs: "[8000]" });
      assertEquals(received(), { kind: "number", json: "8000" });
      // A value containing '=' — which the key=value form would have hijacked
      // into a named payload — arrives verbatim.
      await dispatch([`${CELL}:setHost`], {
        jsonArgs: '["https://h/?a=b"]',
      });
      assertEquals(received(), { kind: "string", json: '"https://h/?a=b"' });
      // An object argument is still expressible — wrapped, explicitly.
      await dispatch([`${CELL}:setHost`], { jsonArgs: '[{"host":"h"}]' });
      assertEquals(received(), { kind: "object", json: '{"host":"h"}' });
    });
  },
});

Deno.test({
  name: "am dispatch: every pre-existing form behaves exactly as before",
  async fn() {
    await withApp(async (dispatch, received) => {
      // 1. Bare positional value → positional arg (worked before, still does).
      await dispatch([`${CELL}:setHost`, "10.0.0.1"], {});
      assertEquals(received(), { kind: "string", json: '"10.0.0.1"' });

      // 2. key=value after a cell method → the method's ONE object argument.
      //    This is the shape the field report hit; it is deliberate and
      //    unchanged (a method taking named options wants exactly this).
      await dispatch([`${CELL}:setHost`, "host=10.0.0.2"], {});
      assertEquals(received(), { kind: "object", json: '{"host":"10.0.0.2"}' });

      // 3. --body AFTER a positional type = that action's PAYLOAD, re-wrapped
      //    for a cell method. Unchanged — `--args` is the fix, not a silent
      //    reinterpretation of --body.
      await dispatch([`${CELL}:setHost`], {
        jsonBody: '{"args":["10.0.0.3"]}',
      });
      assertEquals(
        received(),
        { kind: "object", json: '{"args":["10.0.0.3"]}' },
        "--body after a type is still the payload, wrapped as one argument",
      );

      // 4. The full envelope (no positional type) — the only spelling that
      //    worked before, and it still does.
      await dispatch([], {
        jsonBody: JSON.stringify({
          type: `${CELL}:setHost`,
          payload: { args: ["10.0.0.4"] },
        }),
      });
      assertEquals(received(), { kind: "string", json: '"10.0.0.4"' });

      // 5. A JSON positional value keeps its type (pre-existing behaviour).
      await dispatch([`${CELL}:setHost`, "true"], {});
      assertEquals(received(), { kind: "boolean", json: "true" });
    });
  },
});

Deno.test("am dispatch: --args is loud about the two shapes people reach for first", () => {
  assertEquals(parseArgsFlag('["192.168.1.9"]'), {
    ok: true,
    args: ["192.168.1.9"],
  });
  assertEquals(parseArgsFlag("[]"), { ok: true, args: [] });

  // A bare scalar: the natural first guess, and silently accepting it would
  // rebuild the very bug this flag exists to kill.
  const scalar = parseArgsFlag('"192.168.1.9"');
  assert(!scalar.ok, "a bare string is not an argument LIST");
  assert(scalar.ok === false && scalar.error.includes("ARRAY"), scalar.error);

  // An object: rejected WITH the fix, not just the complaint.
  const obj = parseArgsFlag('{"host":"h"}');
  assert(!obj.ok);
  assert(
    obj.ok === false && obj.error.includes(`--args='[{"host":"…"}]'`),
    obj.error,
  );

  // Not JSON at all.
  const bad = parseArgsFlag("192.168.1.9");
  assert(!bad.ok);
  assert(bad.ok === false && bad.error.includes("not JSON"), bad.error);
});

Deno.test("am flags: --args accepts --k=v and --k v, and never leaks into the args", () => {
  const eq = parseGlobalFlags(["dispatch", "c:m", `--args=["x"]`]);
  assertEquals(eq.flags.jsonArgs, '["x"]');
  assertEquals(eq.args, ["c:m"]);

  const sp = parseGlobalFlags(["dispatch", "c:m", "--args", '["x"]']);
  assertEquals(sp.flags.jsonArgs, '["x"]', "the space form is not swallowed");
  assertEquals(sp.args, ["c:m"]);

  // --body is untouched by the new flag.
  const body = parseGlobalFlags(["dispatch", "c:m", `--body={"a":1}`]);
  assertEquals(body.flags.jsonBody, '{"a":1}');
  assertEquals(body.flags.jsonArgs, undefined);
});

Deno.test("am help documents the forms that actually work", () => {
  const lines: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => lines.push(a.map(String).join(" "));
  try {
    cmdHelp([], {} as GlobalFlags, []);
  } finally {
    console.log = realLog;
  }
  const help = lines.join("\n");
  // The positional and --args forms — the two that deliver real positional
  // arguments — must both be visible, plus the envelope form.
  assert(help.includes("--args="), "am help shows --args");
  assert(
    /dispatch <cell:method>/.test(help),
    "am help shows the cell:method form",
  );
  assert(
    help.includes(`--body='{"type":...,"payload":...}'`),
    "am help shows the full envelope form (the only pre-fix working spelling)",
  );
  // …and the usage error prints the same working set.
  assert(DISPATCH_USAGE.includes(`--args='["192.168.1.9"]'`), DISPATCH_USAGE);
  assert(
    DISPATCH_USAGE.includes(`"payload":{"args":["192.168.1.9"]}`),
    DISPATCH_USAGE,
  );
});

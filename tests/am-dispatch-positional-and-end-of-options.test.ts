// Two ways `am dispatch` rewrote an argument it was handed verbatim.
//
//  1. A positional containing `=` flipped the whole call to the named-payload
//     form: `am dispatch todo:add "https://example.com/?q=1"` sent
//     `{"https://example.com/?q": 1}` to the method instead of the URL.
//  2. `--` did not end am's options: `am dispatch todo:add -- --force`
//     consumed `--force` as am's own flag and dispatched no argument at all.
//
// Both measured by a hunter running `am` as a user; (1) is pinned here
// against a real app over the real trojan, the way am-dispatch-args does.
import { assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetInstanceVerify } from "../src/am/am-http.ts";
import { cmdDispatch, isNamedArg } from "../src/am/am-cmd-state.ts";
import { argsForHandler, parseGlobalFlags } from "../src/am/am-utils.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";

const APP = "am-dispatch-eoo-app";
const CELL = "am-dispatch-eoo-conn";

const conn = cell(CELL, {
  state: { last: "" },
  methods: {
    set(s: { last: string }, v: unknown) {
      s.last = JSON.stringify(v) ?? "undefined";
    },
  },
});

Deno.test({
  name: "am dispatch: a positional holding '=' arrives as that string",
  async fn() {
    _resetInstanceVerify();
    await using srv = await testServer<Record<string, { last: string }>>({
      cells: [conn],
      appId: APP,
    });
    const realLog = console.log;
    console.log = () => {};
    try {
      for (
        const v of ["https://example.com/?q=1", "2 + 2 = 4", '{"f":"a=b"}']
      ) {
        await cmdDispatch([`${CELL}:set`, v], {
          app: APP,
          port: srv.port,
          json: true,
        } as GlobalFlags);
        const want = v.startsWith("{") ? v : JSON.stringify(v);
        assertEquals(srv.state()[CELL]!.last, want, `${v} was rewritten`);
      }
      // The named form is untouched.
      await cmdDispatch([`${CELL}:set`, "host=h"], {
        app: APP,
        port: srv.port,
        json: true,
      } as GlobalFlags);
      assertEquals(srv.state()[CELL]!.last, '{"host":"h"}');
    } finally {
      console.log = realLog;
    }
  },
});

Deno.test("isNamedArg: the key must be a property name", () => {
  for (const named of ["host=h", "_x=1", "$y=2", "a1=b"]) {
    assertEquals(isNamedArg(named), true, named);
  }
  for (const positional of ["https://h/?q=1", "a b=c", "=x", "1a=b", "x"]) {
    assertEquals(isNamedArg(positional), false, positional);
  }
});

Deno.test("parseGlobalFlags: `--` ends am's options", () => {
  const p = parseGlobalFlags(["dispatch", "todo:add", "--", "--force"]);
  assertEquals(p.flags.force, undefined, "--force after -- was consumed");
  assertEquals(p.command, "dispatch");
  // The marker survives parsing so the flag gate knows where options end…
  assertEquals(p.args, ["todo:add", "--", "--force"]);
  // …and the verb reads its arguments without it.
  assertEquals(argsForHandler(p.args, false), ["todo:add", "--force"]);
  // A forwarding verb keeps it: it belongs to the program it forwards to.
  assertEquals(argsForHandler(["--", "--x"], true), ["--", "--x"]);
  // Before the marker, flags are still flags — value flags included.
  const q = parseGlobalFlags(["logs", "--lines", "5", "--", "--json"]);
  assertEquals(q.flags.lines, 5);
  assertEquals(q.flags.json, undefined);
  assertEquals(q.args, ["--", "--json"]);
});

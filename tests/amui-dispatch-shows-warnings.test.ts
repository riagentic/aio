// amui's ▶ (run method) reports a clean "dispatched" for a call the app
// answered with a WARNING.
//
// The trojan `dispatch` reply carries `short` when the call RAN with required
// arguments missing (server-trojan.ts: "it warns into the SERVER LOG, and this
// route answers {"ok":true} to the operator who made it. An agent driving a
// live app never reads that log") — and its own comment names amui as one of
// the callers that "believe" this JSON. `am dispatch` prints the `⚠` line;
// amui's dispatch() looks only at `r.ok` and says "dispatched <type>", so the
// one surface a human clicks never learns the method ran with `undefined`.
import { assert, assertEquals } from "@std/assert";
import { testCell } from "../src/testing/cell-test.ts";
import { manager } from "../amui/src/manager.ts";
import type { DiscoveredProject } from "../amui/src/manager.ts";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetInstanceVerify } from "../src/am/am-http.ts";

const APP = "amui-r9-short-app";
const CELL = "amuir9short";

type Row = { a: string; b: string };
const box = cell(CELL, {
  state: { rows: [] as Row[] },
  methods: {
    addTwo(s: { rows: Row[] }, a: string, b: string) {
      s.rows.push({ a, b });
    },
  },
});

testCell(
  manager,
  "amui dispatch surfaces the app's 'short call' warning instead of a clean ok",
  async (t) => {
    _resetInstanceVerify();
    await using srv = await testServer<Record<string, { rows: Row[] }>>({
      cells: [box],
      appId: APP,
    });
    const row: DiscoveredProject = {
      id: `/r9/short#${APP}#`,
      path: "/r9/short",
      name: "short",
      meta: {
        name: "short",
        version: null,
        target: null,
        tasks: {},
        isAio: true,
        entry: null,
      },
      running: { appId: APP, pid: Deno.pid, port: srv.port, status: "started" },
      git: false,
    };
    t.init({ projects: [row] });
    // The Cells tab's box holds "an array of arguments"; one of two given.
    await t.send.dispatch(row.id, `${CELL}:addTwo`, `["one"]`);
    // Precondition: it RAN (the app took the call, b is undefined).
    assertEquals(srv.state()[CELL]!.rows.length, 1);
    const msg = t.getState().dispatchMsg ?? "";
    assert(
      msg !== `dispatched ${CELL}:addTwo`,
      `amui reported a clean success for a call the app flagged as short: "${msg}"`,
    );
    assert(/argument/i.test(msg), `the warning never reached the UI: "${msg}"`);
  },
);

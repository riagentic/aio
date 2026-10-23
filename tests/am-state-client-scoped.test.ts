// `am state <view>` on a `scope: "client"` cell answered "not found
// (available: …)" — true of the server store, and useless: the cell exists, it
// just lives in each browser tab. `am dispatch` already said so; `am state`
// now says the same, from the same server-side list.
import "./store-sandbox.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetInstanceVerify } from "../src/am/am-http.ts";
import { cmdState } from "../src/am/am-cmd-state.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";

const APP = "am-state-client-app";
const SERVER = "am-state-client-srv";
const VIEW = "am-state-client-view";

const store = cell(SERVER, { state: { n: 0 }, methods: {} });
const view = cell(VIEW, {
  scope: "client",
  state: { tab: "a" },
  methods: {},
});

async function run(
  args: string[],
  port: number,
): Promise<{ exited: number | null; out: string }> {
  const realExit = Deno.exit;
  const realLog = console.log;
  const realErr = console.error;
  let out = "";
  console.log = console.error = (...a: unknown[]) => {
    out += a.join(" ") + "\n";
  };
  const EXIT = Symbol("exit");
  let code: number | null = null;
  (Deno as { exit: (c?: number) => never }).exit = (c?: number) => {
    code = c ?? 0;
    throw EXIT;
  };
  try {
    await cmdState(args, { app: APP, port, json: true } as GlobalFlags);
  } catch (e) {
    if (e !== EXIT) throw e;
  } finally {
    Deno.exit = realExit;
    console.log = realLog;
    console.error = realErr;
  }
  return { exited: code, out };
}

Deno.test("am state: a client-scoped cell is said to be client-scoped, not 'not found'", async () => {
  _resetInstanceVerify();
  await using srv = await testServer({ cells: [store, view], appId: APP });
  const r = await run([`${VIEW}.tab`], srv.port);
  assertEquals(r.exited, 1, r.out);
  assertStringIncludes(r.out, `cell \\"${VIEW}\\" is client-scoped`);
  assertStringIncludes(r.out, "am surface");
  // A plain miss keeps its hint.
  const miss = await run(["nope"], srv.port);
  assertEquals(miss.exited, 1, miss.out);
  assertStringIncludes(miss.out, `(available: ${SERVER})`);
});

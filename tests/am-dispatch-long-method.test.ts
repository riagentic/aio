// network §2: `am dispatch` on a `long:` method gave up at 8 s with "the app
// … accepted the connection but never answered the control request" while
// the method was running fine — a reply comes when the method RETURNS, so
// silence there is not a hang. The give-up now says the call may still be
// running and how to watch it, and `--wait=N` (seconds) waits that long.
import "./store-sandbox.ts";
import { assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetInstanceVerify } from "../src/am/am-http.ts";
import { cmdDispatch } from "../src/am/am-cmd-state.ts";
import type { GlobalFlags } from "../src/am/am-types.ts";

const APP = "am-dispatch-long-app";
const CELL = "am-dispatch-long";

let release: () => void = () => {};
const store = cell(CELL, {
  state: { done: 0 },
  long: ["slow"],
  methods: {
    async slow(s: { done: number }) {
      await new Promise<void>((r) => (release = r));
      s.done++;
    },
  },
});

async function run(
  args: string[],
  flags: Partial<GlobalFlags>,
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
    await cmdDispatch(args, {
      app: APP,
      port,
      json: true,
      ...flags,
    } as GlobalFlags);
  } catch (e) {
    if (e !== EXIT) throw e;
  } finally {
    Deno.exit = realExit;
    console.log = realLog;
    console.error = realErr;
  }
  return { exited: code, out };
}

Deno.test({
  name: "am dispatch: a long method past --wait is said to be still running",
  async fn() {
    _resetInstanceVerify();
    await using srv = await testServer<Record<string, { done: number }>>({
      cells: [store],
      appId: APP,
    });
    const t0 = Date.now();
    const r = await run([`${CELL}:slow`], { wait: 1 }, srv.port);
    assertEquals(r.exited, 1, r.out);
    assertEquals(Date.now() - t0 < 6000, true, "--wait=1 bounds the wait");
    assertStringIncludes(r.out, "may still be running");
    assertStringIncludes(r.out, "--wait=");
    release();
    // …and it was: the call commits once the method returns.
    for (let i = 0; i < 100 && srv.state()[CELL]!.done === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assertEquals(srv.state()[CELL]!.done, 1);

    // A wait long enough gets the method's own answer.
    setTimeout(() => release(), 300);
    const ok = await run([`${CELL}:slow`], { wait: 5 }, srv.port);
    assertEquals(ok.exited, null, ok.out);
    assertEquals(srv.state()[CELL]!.done, 2);
  },
});

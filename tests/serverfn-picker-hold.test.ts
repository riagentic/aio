// jot §9: a picker inside a serverFn lost the pick at 30 s.
//
// A cell method's ceiling pauses while a native dialog is open
// (`pauseCallDeadlines`, pick-path-deadline.test.ts); a serverFn's caller
// waits on ITS OWN 30 s timer, in the client, which that pause never reached
// — so a person who took 31 s in the Save dialog got "timed out after 30s"
// and the path they chose was thrown away. The server now tells the caller
// (`sfnh`) to hold its clock for the dialog and to restart it, full, after.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import {
  _resetServerFns,
  invokeServerFn,
  serverFns,
} from "../src/server/server-fns.ts";
import { setConnected } from "../src/state/state-signals.ts";
import {
  _registerSfnTransport,
  _resetSfnClient,
  handleSfnHold,
  handleSfnResult,
  serverFn as clientServerFn,
} from "../src/browser/server-fns-client.ts";
import {
  type DialogHost,
  runWithDialogCaller,
} from "../src/server/dialog-host.ts";
import { pickSave } from "../src/server/pick-path.ts";
import type { DialogReply } from "../src/server/dialog-host.ts";

/** A window whose dialog the test closes by hand. */
function slowWindow() {
  let answer!: (r: DialogReply) => void;
  const host: DialogHost = {
    label: "the test window",
    open: () => new Promise<DialogReply>((r) => answer = r),
  };
  return { host, close: (r: DialogReply) => answer(r) };
}

/** A transport whose server side is the REAL route, called as a call from
 *  `host`'s connection — as uds.ts runs it — and whose `sfnh` frames reach
 *  the real client handler. */
function wire(host: DialogHost, frames: string[]) {
  setConnected(true);
  _registerSfnTransport((raw) => {
    const { d } = JSON.parse(raw) as {
      d: { cid: string; ns: string; name: string; args: unknown[] };
    };
    runWithDialogCaller(
      host,
      () =>
        invokeServerFn(d.ns, d.name, d.args, undefined, false, (hold) => {
          frames.push(`sfnh ${hold}`);
          handleSfnHold({ cid: d.cid, hold });
        }),
    ).then((r) => handleSfnResult({ cid: d.cid, ...r }));
    return true;
  });
}

type Api = {
  saveAs: () => Promise<string | null>;
  saveThenHang: () => Promise<string | null>;
};

Deno.test("a serverFn's caller waits as long as its picker is open, and gets the pick", async () => {
  using time = new FakeTime();
  _resetSfnClient();
  _resetServerFns();
  const win = slowWindow();
  serverFns("t-hold", {
    saveAs: () => pickSave({ defaultPath: "draft.md" }),
  });
  const frames: string[] = [];
  wire(win.host, frames);
  let settled = false;
  const call = clientServerFn<Api>("t-hold").saveAs().finally(() =>
    settled = true
  );
  await time.tickAsync(0);
  assertEquals(frames, ["sfnh true"], "the dialog opened: the clock is held");
  await time.tickAsync(120_000); // two minutes in the Save dialog
  assert(!settled, "still waiting on the person — not timed out");
  win.close({ canceled: false, paths: ["/home/u/draft.md"] });
  assertEquals(await call, "/home/u/draft.md");
  assertEquals(frames, ["sfnh true", "sfnh false"]);
  _resetSfnClient();
  _resetServerFns();
});

Deno.test("the hold ends with the dialog — a serverFn that hangs AFTER it still times out", async () => {
  using time = new FakeTime();
  _resetSfnClient();
  _resetServerFns();
  const win = slowWindow();
  serverFns("t-hold2", {
    saveThenHang: async () => {
      await pickSave();
      return await new Promise<string>(() => {}); // never settles
    },
  });
  wire(win.host, []);
  const call = clientServerFn<Api>("t-hold2").saveThenHang();
  const rejected = assertRejects(() => call, Error, "timed out after 30s");
  await time.tickAsync(60_000);
  win.close({ canceled: true, paths: [] });
  await time.tickAsync(29_000);
  let done = false;
  rejected.finally(() => done = true);
  await time.tickAsync(0);
  assert(!done, "a FRESH full window starts when the dialog closes");
  await time.tickAsync(1_001);
  await rejected;
  _resetSfnClient();
  _resetServerFns();
});

Deno.test("sfnh for a call that already settled is ignored", () => {
  _resetSfnClient();
  // An unknown cid or a missing payload is dropped: no throw, nothing held.
  assertEquals(handleSfnHold({ cid: "sfn-nope", hold: true }), undefined);
  assertEquals(handleSfnHold({ cid: "sfn-nope", hold: false }), undefined);
  assertEquals(handleSfnHold(undefined), undefined);
});

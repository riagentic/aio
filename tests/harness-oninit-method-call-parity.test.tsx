// A cell method called straight from `onInit` answers the same everywhere.
//
// The server runs every cell's `__init` (and so every `onInit`) BEFORE it binds
// the callable method surface, so `proj.bump()` inside an `onInit` throws. The
// standalone runtime behind bootCells/testUI bound the methods first and ran
// `initAll` after — the same call dispatched and wrote state. An app whose
// boot relied on it was green under both harnesses and threw on `aio.run`.
//
// The documented doors from an `onInit` are `app.dispatch(...)` and `onStart`
// (docs/state/lifecycle.md); both keep working and are pinned here too.
//
// The server's refusal is captured first and the harnesses must produce the
// SAME text, so the test never hard-codes wording another change may improve.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { bootCells } from "../src/testing/cell-test.ts";
import { testServer } from "../src/testing/server-test.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { h } from "../src/air/vdom.ts";

const seen: string[] = [];
type S = { direct: string; viaDispatch: number };
const proj = cell("oiProj", {
  state: { direct: "", viaDispatch: 0 },
  onInit(app) {
    // The documented door — must keep working on every runtime.
    app.dispatch({ type: "oiProj:mark", payload: { args: [] } });
    try {
      const p = (proj as unknown as { bump: () => unknown }).bump();
      seen.push(`returned ${typeof p}`);
    } catch (e) {
      seen.push(`threw ${(e as Error).message}`);
    }
  },
  methods: {
    bump(s: S) {
      s.direct = "bumped";
    },
    mark(s: S) {
      s.viaDispatch++;
    },
  },
});
const P = proj as unknown as S & { bump: () => unknown };

let serverAnswer = "";

Deno.test("onInit parity: the real server refuses a direct method call from onInit", async () => {
  seen.length = 0;
  await using srv = await testServer({ cells: [proj] });
  const slice = (srv.state() as { oiProj: S }).oiProj;
  assertEquals(seen.length, 1);
  assert(seen[0]!.startsWith("threw "), `server: ${seen[0]}`);
  serverAnswer = seen[0]!;
  assertEquals(slice.direct, "", "the refused call wrote nothing");
  assertEquals(slice.viaDispatch, 1, "app.dispatch from onInit still works");
});

Deno.test("onInit parity: bootCells refuses it with the server's words", async () => {
  assert(serverAnswer, "runs after the server case");
  seen.length = 0;
  await using h = await bootCells([proj]);
  await h.settle();
  assertEquals(seen, [serverAnswer]);
  assertEquals(P.direct, "");
  assertEquals(P.viaDispatch, 1);
  // …and once booted, the method is the real one.
  await P.bump();
  assertEquals(P.direct, "bumped");
});

Deno.test("onInit parity: testUI refuses it with the server's words", async () => {
  assert(serverAnswer, "runs after the server case");
  seen.length = 0;
  await using ui = await testUI(() => h("div", null, "x"), { cells: [proj] });
  assertEquals(seen, [serverAnswer]);
  assertEquals(P.viaDispatch, 1);
  await P.bump();
  await ui.settle();
  assertEquals(P.direct, "bumped");
});

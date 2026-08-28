// `aio.run` applies `cellDefaults` and `localFirst` BEFORE it refuses an
// unsafe composition, because both change what a cell hides and whether it
// syncs. The in-process harnesses refused over the raw definitions: an app
// whose only contradiction came from its app-level defaults booted green under
// `testUI`/`bootCells` and was refused the moment it really started — a test
// environment more permissive than production, the one thing a test
// environment must never be.
import { assertRejects, assertThrows } from "@std/assert";
import { cell } from "../mod.ts";
import { _refuseUnsafeCells } from "../src/testing/boot-refusals.ts";
import { bootCells } from "../src/testing/cell-test.ts";

// A cell that syncs and hides nothing on its own — fine. Hidden BY DEFAULTS
// it is the "sync AND filtered" contradiction the server refuses.
const shared = cell("shared", {
  state: { doc: "", secret: "" },
  sync: true,
  methods: {
    async touch(s) {
      s.doc = "x";
    },
  },
});

Deno.test("harness refusal: cellDefaults are applied before the refusal, like boot", () => {
  _refuseUnsafeCells([shared]); // on its own: allowed
  assertThrows(
    () =>
      _refuseUnsafeCells([shared], {
        cellDefaults: { visible: { exclude: ["secret"] } },
      }),
    Error,
    "refusing to start",
  );
});

Deno.test("bootCells refuses what aio.run({ cellDefaults }) refuses", async () => {
  await assertRejects(
    () =>
      bootCells([shared], {
        cellDefaults: { visible: { exclude: ["secret"] } },
      }),
    Error,
    "refusing to start",
  );
});

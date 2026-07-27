// llama.md #8: a cell def binds to exactly one app (perfect-aio D2) — but that
// claim outlived the app, so two `testServer()` blocks in ONE file failed with
// "[cell] already bound", even with `await using`. The second test had to move
// into its own file for no reason a reader of that file could see.
//
// A closed app owns nothing. Its claim ends with it.
import { assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";

const slice = (s: unknown) =>
  (s as Record<string, { n: number }>)["rebind-builds"]!;

const builds = cell("rebind-builds", {
  state: { n: 0 },
  methods: {
    bump(s: { n: number }) {
      s.n++;
    },
  },
});

Deno.test("two testServer blocks in one file can use the same cell", async () => {
  {
    await using srv = await testServer({ cells: [builds] });
    await builds.bump();
    assertEquals(
      slice(srv.state()).n,
      1,
    );
  }
  // Second boot of the SAME cell def — this used to throw "already bound".
  {
    await using srv = await testServer({ cells: [builds] });
    await builds.bump();
    assertEquals(
      slice(srv.state()).n,
      1,
      "and it re-binds to a FRESH app, with the cell's declared initial state",
    );
  }
});

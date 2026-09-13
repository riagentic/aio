// A `worker: true` cell the app refuses to boot is refused by every harness.
//
// The thread boundary cannot honour selectors, `sync`, `listensTo`, a machine
// or client scope, and the worker pool refuses each at boot. But the pool was
// the only place that asked, and the harnesses never build one: `bootCells`,
// `testServer` (libraryMode hands the pool nothing to host) and `testUI` booted
// all of these GREEN — eight "NO THROW"s and a passing testUI — for an app
// that would not start. And `scope: "client"` was refused nowhere at all: the
// client cells are dropped before the pool sees the list.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { cell } from "../mod.ts";
import { bootCells, testServer, testUI } from "../src/testing/cell-test.ts";
import { _refuseUnsafeCells } from "../src/testing/boot-refusals.ts";
import { aio } from "../src/server/aio.ts";
import { freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";
import { h } from "../src/air/vdom.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const peer = cell("wrpeer", {
  state: { v: 1 },
  methods: {
    ping(s: Any) {
      s.v++;
    },
  },
});

const bad: Record<string, () => Any> = {
  selectors: () =>
    cell("wrsel", {
      state: { a: 1 },
      worker: true,
      selectors: { x: () => 1 },
      methods: {
        m(s: Any) {
          s.a++;
        },
      },
    } as Any),
  "sync: true": () =>
    cell("wrsyn", {
      state: { a: 1 },
      worker: true,
      sync: true,
      methods: {
        m(s: Any) {
          s.a++;
        },
      },
    } as Any),
  "client-scoped": () =>
    cell("wrcli", {
      state: { a: 1 },
      worker: true,
      scope: "client",
      methods: {
        m(s: Any) {
          s.a++;
        },
      },
    } as Any),
  listensTo: () =>
    cell("wrlis", {
      state: { a: 1 },
      worker: true,
      listensTo: { m: peer.ping },
      methods: {
        m(s: Any) {
          s.a++;
        },
      },
    } as Any),
};

const refusal = /has worker: true but/;

for (const [why, make] of Object.entries(bad)) {
  Deno.test(`worker cell with ${why}: bootCells refuses it`, async () => {
    const c = make();
    await assertRejects(
      async () => {
        await using _h = await bootCells([peer, c]);
      },
      Error,
      "has worker: true but",
    );
  });

  Deno.test(`worker cell with ${why}: testServer refuses it`, async () => {
    const c = make();
    await assertRejects(
      async () => {
        await using _s = await testServer({ cells: [peer, c] } as Any);
      },
      Error,
      "has worker: true but",
    );
  });

  Deno.test(`worker cell with ${why}: testUI and testCell's gate refuse it`, async () => {
    const c = make();
    await assertRejects(
      async () => {
        await using _ui = await testUI(() => h("div", {}, "x"), {
          cells: [peer, c],
        });
      },
      Error,
      "has worker: true but",
    );
    // testCell runs this exact gate first thing inside its Deno.test.
    let msg = "";
    try {
      _refuseUnsafeCells([c]);
    } catch (e) {
      msg = (e as Error).message;
    }
    assert(refusal.test(msg), `testCell's gate: ${msg}`);
  });
}

Deno.test("a libraryMode aio.run() refuses a worker cell it runs in-isolate", async () => {
  // The app path under the harness: no worker entry, so nothing is hosted —
  // and that used to mean nothing was checked either.
  const baseDir = await tempDir("aio-wr-");
  try {
    await assertRejects(
      async () => {
        const app = await aio.run({
          cells: [bad.selectors!()],
          libraryMode: true,
          persist: false,
          client: "server-only",
          port: freePort(),
          baseDir,
        } as Any);
        await app.close();
      },
      Error,
      "has worker: true but declares selectors",
    );
  } finally {
    await dropTempDir(baseDir);
  }
});

Deno.test("an ordinary worker cell still boots in every harness", async () => {
  const ok = cell("wrok", {
    state: { a: 1 },
    worker: true,
    methods: {
      async m(s: Any) {
        s.a++;
      },
    },
  } as Any) as Any;
  {
    await using _h = await bootCells([ok]);
    await ok.m();
    assertEquals(ok.a, 2);
  }
  {
    await using _s = await testServer({ cells: [ok] });
    await ok.m();
    assertEquals(ok.a, 2);
  }
});

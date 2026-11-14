// A cell's getter or selector read inside ANOTHER cell's reducer in the same
// dispatch drain answers what the store holds — on the server (getters read
// the store) and in the standalone runtime alike (Android APK, --web PWA, and
// the bootCells/testCell/testUI harnesses). Standalone refreshed its per-cell
// signals only when the drain ended, so the peer read `[0, 0]` where the
// server read `[5, 7]`: wrong state on a device, and a harness more lenient
// than production.
// deno-lint-ignore-file no-explicit-any
type Any = any;
import { assertEquals } from "@std/assert";
import { bootCells } from "../src/testing/cell-test.ts";
import { testServer } from "../src/testing/server-test.ts";
import { cell } from "../src/state/cell-create.ts";

function make(tag: string) {
  const a: any = cell(`xa_${tag}`, {
    state: { n: 0 },
    methods: {
      go(s: any) {
        s.n = 5;
        b.peek();
      }, // sync: write, then call peer
      async goAsync(s: any) {
        s.n = 7;
        await b.peek();
      }, // async first frame
    },
  });
  const b: any = cell(`xb_${tag}`, {
    state: { got: [] as number[] },
    methods: {
      peek(s: any) {
        s.got.push(a.n);
      },
    }, // peer reads a.n
  });
  return { a, b };
}

Deno.test("server runtime: peer reducer sees the caller's committed write", async () => {
  const { a, b } = make("srv");
  await using srv = await testServer({ cells: [a, b] });
  await a.go();
  await a.goAsync();
  await new Promise((r) => setTimeout(r, 50));
  assertEquals((srv.state() as any).xb_srv.got, [5, 7]);
});

Deno.test("standalone runtime (bootCells): peer reducer sees the caller's committed write", async () => {
  const { a, b } = make("sa");
  const h = await bootCells([a, b]);
  try {
    await a.go();
    await a.goAsync();
    await h.settle();
    assertEquals(b.got, [5, 7]);
  } finally {
    h.dispose();
  }
});
Deno.test("standalone: selector read in peer reducer, same drain", async () => {
  const a: any = cell(`sela`, {
    state: { n: 0 },
    selectors: { dbl: (s: any) => s.n * 2 },
    methods: {
      go(s: any) {
        s.n = 5;
        b.peek();
      },
    },
  });
  const b: any = cell(`selb`, {
    state: { got: [] as number[] },
    methods: {
      peek(s: any) {
        s.got.push(a.dbl());
      },
    },
  });
  const h = await bootCells([a, b]);
  try {
    await a.go();
    await h.settle();
    assertEquals(b.got, [10]);
  } finally {
    h.dispose();
  }
});

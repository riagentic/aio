// For tests/worker-differential-fuzz.test.ts: one `worker: true` cell exercising many
// state shapes. Imported by the test for the def; re-imported by a real worker.
import { aio, cell, isCellWorker } from "aio";

type S = {
  n: number;
  list: number[];
  obj: Record<string, unknown>;
  str: string;
  busy: boolean;
  u?: unknown;
  nested: { a: { b: number[] } };
};

export const wdiff = cell("wdiff", {
  worker: true,
  state: {
    n: 0,
    list: [1, 2, 3],
    obj: { a: 1 },
    str: "x",
    busy: false,
    nested: { a: { b: [] } },
  } as S,
  validate: (s: S) => s.n < 1000 ? true : "n too big",
  methods: {
    inc(s: S, k: number) {
      s.n += k;
      return s.n;
    },
    push(s: S, x: number) {
      s.list.push(x);
      return s.list.length;
    },
    setKey(s: S, k: string, v: unknown) {
      s.obj[k] = v;
    },
    del(s: S, k: string) {
      delete s.obj[k];
    },
    truncate(s: S, n: number) {
      s.list.length = Math.min(n, s.list.length);
    },
    splice(s: S, i: number) {
      s.list.splice(i, 1);
    },
    unshift(s: S, x: number) {
      s.list.unshift(x);
    },
    reverse(s: S) {
      s.list.reverse();
    },
    sort(s: S) {
      s.list.sort((a, b) => a - b);
    },
    setUndef(s: S) {
      s.u = undefined;
    },
    delUndef(s: S) {
      delete s.u;
    },
    append(s: S, t: string) {
      s.str += t;
    },
    prepend(s: S, t: string) {
      s.str = t + s.str;
    },
    nestPush(s: S, x: number) {
      s.nested.a.b.push(x);
    },
    nestReplace(s: S) {
      s.nested = { a: { b: [...s.nested.a.b, 9] } };
    },
    retObj(s: S) {
      return s.obj;
    },
    retList(s: S) {
      return s.list;
    },
    big(s: S) {
      s.n = 5000; // refused by validate
      return s.n;
    },
    boom(_s: S) {
      throw Object.assign(new Error("sync boom"), { code: "E_BOOM" });
    },
    noop(_s: S) {},
    async asyncInc(s: S, k: number) {
      s.busy = true;
      await Promise.resolve();
      s.n += k;
      s.busy = false;
      return s.n;
    },
    async asyncBoom(s: S) {
      s.busy = true;
      await Promise.resolve();
      s.busy = false;
      throw Object.assign(new Error("async boom"), { code: "E_ABOOM" });
    },
    async stream(s: S, count: number) {
      for (let i = 0; i < count; i++) {
        s.list.push(i);
        s.str += "y";
        await new Promise((r) => setTimeout(r, 1));
      }
      return s.list.length;
    },
    crash(_s: S) {
      // An uncaught throw on the worker's own loop: the thread dies.
      setTimeout(() => {
        throw new Error("worker loop died");
      }, 0);
    },
    async asyncBig(s: S) {
      await Promise.resolve();
      s.n = 7000;
      return 1;
    },
  },
  // deno-lint-ignore no-explicit-any
} as any);

if (isCellWorker()) {
  await aio.run({
    appId: "r6-worker-diff-probe",
    cells: [wdiff],
    client: "server-only",
    persist: false,
    libraryMode: true,
  });
}

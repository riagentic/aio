// A standalone app (Android APK native store, or a browser's localStorage)
// whose boot restore FAILED must never write over what it failed to restore.
//
// The bug (todo.md "a failed native read at boot can still overwrite good
// state"): a native read that threw returned null, and with no localStorage
// copy to adopt the page never asked `has()` — so it booted from the INITIAL
// state and its first dispatch wrote that over the real file. A corrupt JSON
// blob was only `console.warn`'d, and the first dispatch replaced it too. And
// the `has()` branch printed "Nothing has been overwritten; restart the app"
// while the next dispatch did exactly that.
//
// The rule now (`_restoreOrQuarantine` in src/standalone-air.ts): stored but
// unreadable → nothing is written this run; stored, read, but unusable → the
// raw text is set aside byte-for-byte (and read back) before any write; nothing
// stored → a first run writes as normal. Both failures are console.error.
import { assert, assertEquals } from "@std/assert";
import { _reset, initStandalone } from "../src/standalone-air.ts";

type S = { count: number };
type A = { type: string };
const reduce = (s: S, a: A) => ({
  state: a.type === "INC" ? { count: s.count + 1 } : s,
  effects: [] as never[],
});

const KEY = "aio:t";
/** Bytes a restore cannot use — and the one copy of this user's state. */
const GOOD = '{"count":4000}';
const CORRUPT = '{"count":40'; // a torn blob (older build, disk error)

function fakeNative(opts: {
  getThrows?: boolean;
  getNull?: boolean;
  refuse?: (k: string) => boolean;
} = {}) {
  const files = new Map<string, string>();
  return {
    files,
    bridge: {
      get: (k: string) => {
        if (k === KEY && opts.getThrows) throw new Error("EIO");
        if (k === KEY && opts.getNull) return null; // Kotlin caught + logged
        return files.get(k) ?? null;
      },
      has: (k: string) => files.has(k),
      set: (k: string, v: string) => {
        if (opts.refuse?.(k)) return false;
        files.set(k, v);
        return true;
      },
      describe: () => "/data/user/0/app.aio.x/files/aio-store",
    },
  };
}

function fakeLocalStorage() {
  const m = new Map<string, string>();
  return {
    m,
    ls: {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    },
  };
}

function setGlobal(name: string, value: unknown): unknown {
  const prev = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, {
    value,
    writable: true,
    configurable: true,
  });
  return prev;
}

/** Boot with `native`/`ls` installed, dispatch `n` changes, close; return
 *  every console.error line and the booted count. */
async function run(
  g: { native?: unknown; ls?: unknown },
  n: number,
): Promise<{ errors: string[]; booted: number; final: number }> {
  const prevN = Object.getOwnPropertyDescriptor(globalThis, "AioNativeStore");
  const prevL = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  setGlobal("AioNativeStore", g.native);
  setGlobal("localStorage", g.ls);
  const errors: string[] = [];
  const realError = console.error;
  const realInfo = console.info;
  console.error = (...a: unknown[]) => void errors.push(a.join(" "));
  console.info = () => {};
  try {
    _reset();
    const app = initStandalone<S, A, never>({ count: 0 }, {
      reduce,
      execute: () => {},
      persistKey: KEY,
      persistDebounceMs: 1,
    });
    const booted = app.getState().count;
    for (let i = 0; i < n; i++) app.dispatch({ type: "INC" });
    await app.close();
    return { errors, booted, final: app.getState().count };
  } finally {
    console.error = realError;
    console.info = realInfo;
    _reset();
    for (
      const [name, prev] of [["AioNativeStore", prevN], [
        "localStorage",
        prevL,
      ]] as const
    ) {
      if (prev) Object.defineProperty(globalThis, name, prev);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  }
}

Deno.test("restore: a native read error with no localStorage copy never overwrites the file", async () => {
  for (const mode of ["getNull", "getThrows"] as const) {
    const n = fakeNative({ [mode]: true });
    n.files.set(KEY, GOOD);
    const r = await run({ native: n.bridge }, 25);
    assertEquals(
      n.files.get(KEY),
      GOOD,
      `${mode}: the unreadable state was overwritten by the initial state ` +
        `after 25 dispatches — silent data loss`,
    );
    assertEquals([...n.files.keys()], [KEY], `${mode}: a stray write happened`);
    assertEquals(r.final, 25, "the app itself must keep running");
    assert(
      r.errors.some((e) => e.includes("has NOT been touched")),
      `${mode}: the refusal was not said: ${JSON.stringify(r.errors)}`,
    );
    assert(
      r.errors.some((e) => e.includes("REFUSED")),
      `${mode}: the first refused write was not said`,
    );
  }
});

Deno.test("restore: a read error with a localStorage copy adopts nothing and writes nothing", async () => {
  const n = fakeNative({ getNull: true });
  n.files.set(KEY, GOOD);
  const l = fakeLocalStorage();
  l.m.set(KEY, '{"count":7}');
  const r = await run({ native: n.bridge, ls: l.ls }, 5);
  assertEquals(n.files.get(KEY), GOOD);
  assertEquals(r.booted, 0, "the stale pre-upgrade copy was handed over");
});

Deno.test("restore: corrupt native JSON is set aside byte-for-byte, loudly, before any write", async () => {
  const n = fakeNative();
  n.files.set(KEY, CORRUPT);
  const r = await run({ native: n.bridge }, 3);
  const aside = [...n.files.keys()].filter((k) =>
    k.startsWith(`${KEY}.corrupt-`)
  );
  assertEquals(aside.length, 1, `no copy set aside: ${[...n.files.keys()]}`);
  assertEquals(n.files.get(aside[0]!), CORRUPT, "the copy is not byte-exact");
  assertEquals(JSON.parse(n.files.get(KEY)!).count, 3, "writes resume after");
  assert(
    r.errors.some((e) =>
      e.includes("preserved byte-for-byte") && e.includes(aside[0]!)
    ),
    `the set-aside was not said with its key: ${JSON.stringify(r.errors)}`,
  );
});

Deno.test("restore: corrupt localStorage JSON is set aside in localStorage", async () => {
  const l = fakeLocalStorage();
  l.m.set(KEY, CORRUPT);
  const r = await run({ ls: l.ls }, 2);
  const aside = [...l.m.keys()].filter((k) => k.startsWith(`${KEY}.corrupt-`));
  assertEquals(aside.length, 1);
  assertEquals(l.m.get(aside[0]!), CORRUPT);
  assertEquals(JSON.parse(l.m.get(KEY)!).count, 2);
  assert(r.errors.some((e) => e.includes("could not be restored")));
});

Deno.test("restore: a corrupt value that cannot be set aside is never overwritten", async () => {
  const n = fakeNative({ refuse: (k) => k.includes(".corrupt-") });
  n.files.set(KEY, CORRUPT);
  const r = await run({ native: n.bridge }, 10);
  assertEquals(n.files.get(KEY), CORRUPT, "overwrote the only copy");
  assert(r.errors.some((e) => e.includes("has NOT been touched")));
});

Deno.test("restore: nothing stored is a first run — it writes as normal, silently", async () => {
  const n = fakeNative();
  const r = await run({ native: n.bridge }, 1);
  assertEquals(
    JSON.parse(n.files.get(KEY) ?? "null")?.count,
    1,
    "a first run did not save its first change",
  );
  assertEquals(r.errors, [], "a first run is not an error");
  const l = fakeLocalStorage();
  const r2 = await run({ ls: l.ls }, 1);
  assertEquals(JSON.parse(l.m.get(KEY) ?? "null")?.count, 1);
  assertEquals(r2.errors, []);
});

// A cell's `persist` filter, on the runtime that packages into an APK.
//
// THE BUG, measured before the fix (this file, `PERSISTED: {...}`):
//
//   cell("session", { state: { token: "" }, persist: "none", … })
//
//   deno task dev   → the slice is dropped; a restart comes back empty.
//   the same app.ts
//   as a standalone
//   APK / testUI    → `{"session":{"token":"SECRET-TOKEN"}}` on disk, and
//                     restored on the next launch.
//
// `src/standalone-air.ts` stringified the WHOLE composed state on every
// change (`getDBState = (s) => s`), because the rule that answers "what does
// this app write" lived in `src/server/aio-composition.ts` and nothing else
// could reach it. Two consequences, both of which this file pins:
//
//  1. dev != prod. The one thing CLAUDE.md forbids outright: an app that
//     marked a session token, a draft or a decoded frame as not-to-be-kept
//     had it written to the phone's `filesDir` — and fsync'd there on EVERY
//     dispatch since v1.0.7-beta removed the debounce for a durable store.
//  2. the durable store's own advice was inert. `initStandalone`'s ">32ms
//     save" warning tells the developer to mark state with `persist`, and
//     `persist` did nothing on the one runtime that prints that warning.
//
// The rule now lives in `src/state/cell-persist-filter.ts` and BOTH runtimes
// import it — one decider, never a second copy to drift.
import { assert, assertEquals } from "@std/assert";
import { _reset, aio, cell } from "../src/standalone-air.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";

const storage = new Map<string, string>();
Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  },
  configurable: true,
  writable: true,
});

/** One boot of a standalone app, torn down completely. */
async function withApp<T>(
  appId: string,
  cells: unknown[],
  fn: (app: { getState(): unknown; close(): Promise<void> }) => Promise<T> | T,
): Promise<T> {
  _reset();
  // deno-lint-ignore no-explicit-any
  const app = await aio.run({ appId, cells: cells as any });
  try {
    return await fn(app);
  } finally {
    await app.close();
    _resetAioRuntime();
    _reset();
  }
}

Deno.test('standalone persist: a `persist: "none"` cell is never written', async () => {
  storage.clear();
  const session = cell("spfsession", {
    state: { token: "" },
    persist: "none",
    methods: {
      signIn(s: { token: string }) {
        s.token = "SECRET-TOKEN";
      },
    },
  });
  const kept = cell("spfkept", {
    state: { n: 0 },
    methods: {
      bump(s: { n: number }) {
        s.n += 1;
      },
    },
  });
  await withApp("spf1", [session, kept], async () => {
    await (session as unknown as { signIn(): Promise<void> }).signIn();
    await (kept as unknown as { bump(): Promise<void> }).bump();
  });
  const raw = storage.get("aio:spf1") ?? "";
  assert(
    !raw.includes("SECRET-TOKEN"),
    `a cell marked \`persist: "none"\` was written to the standalone store — ` +
      `on Android that is an fsync of it to filesDir on every change: ${raw}`,
  );
  // …and the cell that said nothing is still persisted, so this is a filter
  // and not persistence quietly switching itself off.
  assertEquals(JSON.parse(raw).spfkept.n, 1);
});

Deno.test('standalone persist: a `persist: "none"` cell is never RESTORED either', async () => {
  // The other direction, and the one a write-side-only fix would leave open:
  // a blob an OLDER build wrote (or a downgrade wrote) still holds the slice.
  // Restoring it hands the cell the state it explicitly refused to keep, and
  // an app that never changes again keeps it for good.
  storage.clear();
  storage.set(
    "aio:spf2",
    JSON.stringify({ spfsession2: { token: "FROM-AN-OLDER-BUILD" } }),
  );
  const session = cell("spfsession2", {
    state: { token: "" },
    persist: "none",
    methods: { noop(_s: { token: string }) {} },
  });
  const token = await withApp("spf2", [session], (app) => {
    const s = app.getState() as { spfsession2: { token: string } };
    return s.spfsession2.token;
  });
  assertEquals(
    token,
    "",
    'a `persist: "none"` cell was refilled from the store',
  );
});

Deno.test("standalone persist: `exclude` drops the fields, keeps the rest", async () => {
  storage.clear();
  const c = cell("spfdoc", {
    state: { title: "", scratch: "" },
    persist: { exclude: ["scratch"] },
    methods: {
      edit(s: { title: string; scratch: string }) {
        s.title = "kept";
        s.scratch = "DROPPED";
      },
    },
  });
  await withApp("spf3", [c], async () => {
    await (c as unknown as { edit(): Promise<void> }).edit();
  });
  const written = JSON.parse(storage.get("aio:spf3") ?? "{}");
  assertEquals(written.spfdoc, { title: "kept" });
});

Deno.test("standalone persist: `onPersist` shapes what reaches the store", async () => {
  // The server runs the shaper on the way out (aio-composition.ts used to own
  // the getter); an app that strips a secret there had it written in full
  // inside its own APK. docs/persistence/auto-persist.md §"Shaping what goes
  // out" is the promise this keeps on the fourth target.
  storage.clear();
  const c = cell("spfacct", {
    state: { user: "", secret: "" },
    persist: "all",
    onPersist: (s: { user: string; secret: string }) => ({ user: s.user }),
    methods: {
      login(s: { user: string; secret: string }) {
        s.user = "ada";
        s.secret = "hunter2";
      },
    },
  });
  await withApp("spf4", [c], async () => {
    await (c as unknown as { login(): Promise<void> }).login();
  });
  const raw = storage.get("aio:spf4") ?? "";
  assert(!raw.includes("hunter2"), `onPersist was skipped: ${raw}`);
  assertEquals(JSON.parse(raw).spfacct, { user: "ada" });
});

Deno.test("standalone persist: an app with no filters still writes everything", async () => {
  // The default has to be untouched: every app that never says `persist`
  // keeps the behaviour it shipped with.
  storage.clear();
  const c = cell("spfplain", {
    state: { a: 1, b: 2 },
    methods: {
      set(s: { a: number; b: number }) {
        s.a = 9;
        s.b = 8;
      },
    },
  });
  await withApp("spf5", [c], async () => {
    await (c as unknown as { set(): Promise<void> }).set();
  });
  assertEquals(JSON.parse(storage.get("aio:spf5") ?? "{}").spfplain, {
    a: 9,
    b: 8,
  });
});

Deno.test("standalone persist: a throwing `onPersist` is LOUD, not a note", async () => {
  // The new way this path can be reached, introduced by honouring the filters
  // here at all: `onPersist` never ran on this runtime before, so it could
  // never throw here. A shaper with a bug now persists NOTHING — every
  // change, for as long as the app runs. The server answers that with a
  // PERSIST_ERROR; a page has console.error, and it has to use it.
  storage.clear();
  const c = cell("spfthrow", {
    state: { n: 0 },
    onPersist: (_s: { n: number }) => {
      throw new Error("shaper bug");
    },
    methods: {
      bump(s: { n: number }) {
        s.n += 1;
      },
    },
  });
  const said: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => void said.push(a.map(String).join(" "));
  try {
    await withApp("spf6", [c], async () => {
      await (c as unknown as { bump(): Promise<void> }).bump();
    });
  } finally {
    console.error = realError;
  }
  assert(
    said.some((m) => m.includes("NOT SAVED")),
    `a persist that wrote nothing said nothing at error level: ` +
      JSON.stringify(said),
  );
  assertEquals(storage.get("aio:spf6"), undefined);
});

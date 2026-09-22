// The Android standalone APK's DURABLE store, and the one decider that picks it.
//
// The bug this file exists for, measured on an API 35 emulator with
// examples/counter packaged as a standalone APK: state was persisted through
// the WebView's `localStorage`, which commits to disk on its own lazy
// schedule. A SIGKILL 122 ms after a committed change (`adb shell am
// force-stop`, what a swipe-away / OOM kill / crash is) brought the app back
// WITHOUT that change — restored count 0 after two taps. At 933 ms the same
// change survived, which is why every earlier test, all of which waited,
// called it fine. Silent data loss.
//
// The fix is a native file store (`AioNativeStore`, a `@JavascriptInterface`
// in android-template's MainActivity.kt) written temp → fsync → atomic
// rename, so a change is on disk before the write call returns. This file
// pins the page's half: that the durable store is CHOSEN when present, that
// choosing it removes the debounce window rather than shortening it, and that
// the two sides still agree on the global's name. The APK half — an actual
// kill on an actual emulator — is the "survives a kill within ~1s of the
// change" step in tests/android-emulator-e2e.test.ts (`deno task
// test:android`), because a green assertion about a Kotlin string is not
// evidence that an APK persists.
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { fromFileUrl } from "@std/path";
import {
  _pickPersistStore,
  _reset,
  initStandalone,
} from "../src/standalone-air.ts";
import { ANDROID_TEMPLATE } from "../src/build/android-template.ts";

// ── the decider ─────────────────────────────────────────────────────

/** A stand-in for the Kotlin bridge: same three methods, same contract. */
function fakeNative(opts: { accept?: boolean } = {}) {
  const files = new Map<string, string>();
  return {
    files,
    bridge: {
      get: (k: string) => files.get(k) ?? null,
      set: (k: string, v: string) => {
        if (opts.accept === false) return false;
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
      setItem: (k: string, v: string) => {
        m.set(k, v);
      },
    },
  };
}

Deno.test("native store: chosen over localStorage when the APK injected it", () => {
  const n = fakeNative();
  const l = fakeLocalStorage();
  const store = _pickPersistStore({
    AioNativeStore: n.bridge,
    localStorage: l.ls,
  });
  assertEquals(store.kind, "native");
  assertEquals(store.durable, true);
  // The boot line names the store AND where it writes — a developer who
  // cannot tell which store a run picked cannot tell what a crash costs.
  assertStringIncludes(store.describe, "native file store");
  assertStringIncludes(
    store.describe,
    "/data/user/0/app.aio.x/files/aio-store",
  );

  store.write("aio:app", '{"n":1}');
  assertEquals(n.files.get("aio:app"), '{"n":1}');
  assertEquals(store.read("aio:app"), '{"n":1}');
  // …and nothing leaked into the lazy store: two stores holding two answers
  // is the failure this decider exists to make impossible.
  assertEquals(l.m.size, 0);
});

Deno.test("native store: a browser preview of the same bundle falls back to localStorage", () => {
  const l = fakeLocalStorage();
  const store = _pickPersistStore({ localStorage: l.ls });
  assertEquals(store.kind, "localStorage");
  assertEquals(store.durable, false);
  // The fallback must SAY it is lossy, not pass itself off as the fix.
  assertStringIncludes(store.describe, "can lose it");
  store.write("k", "v");
  assertEquals(l.m.get("k"), "v");
  assertEquals(store.read("k"), "v");
  assertEquals(store.read("missing"), null);
});

Deno.test("native store: a half-injected bridge is not mistaken for one", () => {
  const l = fakeLocalStorage();
  // An overlay that kept the name and dropped `set` would otherwise give a
  // store whose every write throws — quieter and worse than the fallback.
  const store = _pickPersistStore({
    AioNativeStore: { get: () => null },
    localStorage: l.ls,
  });
  assertEquals(store.kind, "localStorage");
});

Deno.test("native store: no store at all is named, not pretended", () => {
  const store = _pickPersistStore({});
  assertEquals(store.kind, "none");
  assertEquals(store.durable, false);
  assertEquals(store.read("k"), null);
  assertThrows(() => store.write("k", "v"), Error, "no storage");
});

Deno.test("native store: a refused write throws — it never looks like a save", () => {
  const n = fakeNative({ accept: false });
  const store = _pickPersistStore({ AioNativeStore: n.bridge });
  assertThrows(() => store.write("aio:app", "{}"), Error, "refused the write");
});

Deno.test("native store: describe() throwing does not take the boot down", () => {
  const n = fakeNative();
  const store = _pickPersistStore({
    AioNativeStore: {
      ...n.bridge,
      describe: () => {
        throw new Error("no filesDir");
      },
    },
  });
  assertEquals(store.kind, "native");
  assertStringIncludes(store.describe, "native file store");
});

// ── the window: a durable store has none ────────────────────────────

type S = { count: number };
type A = { type: string };
const reduce = (s: S, a: A) => ({
  state: a.type === "INC" ? { count: s.count + 1 } : s,
  effects: [] as never[],
});

function install(value: unknown): void {
  Object.defineProperty(globalThis, "AioNativeStore", {
    value,
    writable: true,
    configurable: true,
  });
}

Deno.test("native store: the change is written BEFORE dispatch returns", () => {
  const n = fakeNative();
  install(n.bridge);
  try {
    _reset();
    const app = initStandalone<S, A, never>({ count: 0 }, {
      reduce,
      execute: () => {},
      persistKey: "aio:t",
      // A debounce this long would be a guaranteed loss if it applied: the
      // point is that a durable store does not use it at all.
      persistDebounceMs: 60_000,
    });
    app.dispatch({ type: "INC" });
    // No await, no timer, no flush: the emulator's SIGKILL lands here.
    assertEquals(
      JSON.parse(n.files.get("aio:t") ?? "{}").count,
      1,
      "the durable store still had a debounce window — a kill here loses the change",
    );
  } finally {
    install(undefined);
    _reset();
  }
});

Deno.test("native store: a restart reads the change back", () => {
  const n = fakeNative();
  install(n.bridge);
  try {
    _reset();
    const app = initStandalone<S, A, never>({ count: 0 }, {
      reduce,
      execute: () => {},
      persistKey: "aio:t",
    });
    app.dispatch({ type: "INC" });
    app.dispatch({ type: "INC" });
    _reset();
    const again = initStandalone<S, A, never>({ count: 0 }, {
      reduce,
      execute: () => {},
      persistKey: "aio:t",
    });
    assertEquals(again.getState().count, 2);
  } finally {
    install(undefined);
    _reset();
  }
});

// ── the background flush goes where the events are ──────────────────
//
// These two run before anything else installs the hook: it is installed once
// per process on purpose, so the no-DOM case has to be observed first.

/** Record every addEventListener call on `target` for the duration of `fn`. */
function spyListeners(
  target: { addEventListener?: (t: string, f: () => void) => void },
  fn: () => void,
): string[] {
  const seen: string[] = [];
  const original = target.addEventListener;
  target.addEventListener = (t: string, f: () => void) => {
    seen.push(t);
    original?.call(target, t, f);
  };
  try {
    fn();
  } finally {
    if (original) target.addEventListener = original;
    else delete target.addEventListener;
  }
  return seen;
}

Deno.test("background flush: nothing is registered on a global with no DOM", () => {
  // Deno HAS globalThis.addEventListener, so feature-sniffing that one method
  // attached "visibilitychange" and "pagehide" to a server/CLI/test process,
  // where neither can ever fire: a flush that looks installed and saves
  // nothing — the same silent loss this file exists to remove. testUI's own
  // tripwire caught it; this keeps it caught.
  const g = globalThis as unknown as {
    addEventListener?: (t: string, f: () => void) => void;
    document?: unknown;
    localStorage?: unknown;
  };
  assertEquals(g.document, undefined, "this test needs a DOM-less global");
  const l = fakeLocalStorage();
  Object.defineProperty(globalThis, "localStorage", {
    value: l.ls,
    writable: true,
    configurable: true,
  });
  try {
    const seen = spyListeners(g, () => {
      _reset();
      initStandalone<S, A, never>({ count: 0 }, {
        reduce,
        execute: () => {},
        persistKey: "aio:nodom",
      });
    });
    assertEquals(
      seen.filter((t) => t === "visibilitychange" || t === "pagehide"),
      [],
      "a page-lifecycle listener was attached to the Deno global, where it " +
        "can never fire — the flush would silently never run",
    );
  } finally {
    _reset();
    // deno-lint-ignore no-explicit-any
    delete (globalThis as any).localStorage;
  }
});

Deno.test("background flush: visibilitychange goes on the document", () => {
  const l = fakeLocalStorage();
  const doc = {
    visibilityState: "visible",
    listeners: [] as string[],
    addEventListener(t: string, _f: () => void) {
      this.listeners.push(t);
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: l.ls,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(globalThis, "document", {
    value: doc,
    writable: true,
    configurable: true,
  });
  try {
    _reset();
    initStandalone<S, A, never>({ count: 0 }, {
      reduce,
      execute: () => {},
      persistKey: "aio:dom",
    });
    assertEquals(doc.listeners, ["visibilitychange"]);
  } finally {
    _reset();
    // deno-lint-ignore no-explicit-any
    delete (globalThis as any).document;
    // deno-lint-ignore no-explicit-any
    delete (globalThis as any).localStorage;
  }
});

// ── the two sides cannot drift ──────────────────────────────────────

const KOTLIN = ANDROID_TEMPLATE["app/src/main/java/aio/app/MainActivity.kt"] ??
  "";

Deno.test("native store: the page and the APK name the same global", () => {
  const src = Deno.readTextFileSync(
    fromFileUrl(new URL("../src/standalone-air.ts", import.meta.url)),
  );
  const page = src.match(/NATIVE_STORE_GLOBAL = "([^"]+)"/)?.[1];
  const kotlin = KOTLIN.match(/STORE_GLOBAL = "([^"]+)"/)?.[1];
  assert(page, "src/standalone-air.ts no longer names NATIVE_STORE_GLOBAL");
  assert(kotlin, "MainActivity.kt no longer names STORE_GLOBAL");
  assertEquals(
    page,
    kotlin,
    "the page looks for a different global than the APK injects — the APK " +
      "would fall back to localStorage and lose changes to a fast kill again",
  );
});

Deno.test("native store: the bridge is a standalone-only surface", () => {
  // addJavascriptInterface hands the store to EVERY page the WebView loads,
  // so it may exist only in the APK shape that can never leave its own
  // bundle. A client or dev APK opens a server's pages — it gets no bridge.
  const add = KOTLIN.split("\n").find((l) =>
    l.includes("addJavascriptInterface(AioNativeStore")
  );
  assert(add, "MainActivity.kt no longer installs the native store");
  assertStringIncludes(
    KOTLIN,
    "if (!TALKS_TO_SERVER) {\n                addJavascriptInterface(AioNativeStore",
    "the native store bridge is no longer guarded by !TALKS_TO_SERVER — a " +
      "client/dev APK would hand a file-writing bridge to a remote page",
  );
  // …and the guard is enforced at navigation time, not only at construction.
  assertStringIncludes(KOTLIN, "removeJavascriptInterface(STORE_GLOBAL)");
});

Deno.test("native store: the write is durable, not merely buffered", () => {
  // Each of these three is load-bearing: without fsync the bytes sit in a
  // page cache a SIGKILL+reboot loses; without the rename a crash mid-write
  // leaves a torn JSON file, which is worse than a lost change.
  assertStringIncludes(KOTLIN, "out.fd.sync()");
  assertStringIncludes(KOTLIN, "tmp.renameTo(target)");
  assertStringIncludes(KOTLIN, "@JavascriptInterface");
});

Deno.test("native store: an app UPGRADED from a localStorage build keeps its state", () => {
  // The bug the fix itself would have introduced, and the one this file had
  // no case for. Every standalone APK before this one persisted through
  // `localStorage`; Android keeps an app's data across an upgrade, so after
  // the user installs the new build their state is still on the device — in
  // the store the new code no longer reads. Without adoption the app comes up
  // EMPTY on the first launch after an upgrade, with the data sitting intact
  // and invisible one API away. That is the exact silent data loss this whole
  // change exists to end.
  const n = fakeNative();
  const l = fakeLocalStorage();
  l.ls.setItem("aio:app", '{"count":7}'); // what the OLD build left behind
  const store = _pickPersistStore({
    AioNativeStore: n.bridge,
    localStorage: l.ls,
  });

  assertEquals(
    store.read("aio:app"),
    '{"count":7}',
    "the upgraded app booted empty — the previous build's state was on the " +
      "device and was not adopted",
  );
  // …and it is now IN the durable store, so the next boot is a plain native
  // read and the very next change is crash-safe.
  assertEquals(n.files.get("aio:app"), '{"count":7}');
});

Deno.test("native store: adoption never invents a value, and never hides a failed copy", () => {
  // Two ways adoption could be worse than not adopting.
  const fresh = _pickPersistStore({
    AioNativeStore: fakeNative().bridge,
    localStorage: fakeLocalStorage().ls,
  });
  assertEquals(
    fresh.read("aio:app"),
    null,
    "a genuinely new install must read as empty, not as some other key",
  );

  // A native store that refuses the copy must still hand back the data —
  // running on the lossy copy beats losing it — and must say so loudly.
  const n = fakeNative();
  n.bridge.set = () => false;
  const l = fakeLocalStorage();
  l.ls.setItem("aio:app", '{"count":7}');
  const store = _pickPersistStore({
    AioNativeStore: n.bridge,
    localStorage: l.ls,
  });
  const said: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => void said.push(a.join(" "));
  try {
    assertEquals(store.read("aio:app"), '{"count":7}');
  } finally {
    console.error = realError;
  }
  assert(
    said.some((m) => m.includes("could NOT")),
    `a failed adoption said nothing: ${JSON.stringify(said)}`,
  );
});

Deno.test("native store: adoption never overwrites a value that IS on disk", () => {
  // The worst outcome the adoption path can produce, and the one a single
  // nullable `get` cannot rule out.
  //
  // MainActivity.kt catches a read error and returns null — the SAME answer
  // as "nothing written yet". The page then adopts what `localStorage` still
  // holds (it is never cleared, so the pre-upgrade snapshot is there
  // forever) and writes it in. On a read error that replaces the app's real,
  // intact state with a snapshot from before the upgrade, and logs it as a
  // successful adoption: silent data loss introduced BY the fix for silent
  // data loss. `has()` is a stat, not a read, so it separates the two.
  const n = fakeNative();
  n.files.set("aio:app", '{"count":4000}'); // the real state, on disk
  const bridge = {
    ...n.bridge,
    get: () => null, // the read threw; Kotlin logged it and returned null
    has: (k: string) => n.files.has(k),
  };
  const l = fakeLocalStorage();
  l.ls.setItem("aio:app", '{"count":7}'); // the pre-upgrade copy, still there

  const said: string[] = [];
  const realError = console.error;
  console.error = (...a: unknown[]) => void said.push(a.join(" "));
  let got: string | null;
  try {
    got = _pickPersistStore({ AioNativeStore: bridge, localStorage: l.ls })
      .read("aio:app");
  } finally {
    console.error = realError;
  }

  assertEquals(
    n.files.get("aio:app"),
    '{"count":4000}',
    "adoption wrote the pre-upgrade localStorage copy OVER the state that " +
      "was on disk — 4000 counts replaced by 7, and nothing said so",
  );
  assertEquals(got, null, "the stale copy was handed to the app as its state");
  assert(
    said.some((m) => m.includes("REFUSING to adopt")),
    `the refusal was silent: ${JSON.stringify(said)}`,
  );
});

Deno.test("native store: a bridge with no has() still adopts (an app's own overlay)", () => {
  // The guard above must not turn an upgraded app's boot into an empty one
  // when `<app>/android/` overlays a MainActivity from before `has` existed.
  const n = fakeNative();
  const l = fakeLocalStorage();
  l.ls.setItem("aio:app", '{"count":7}');
  const store = _pickPersistStore({
    AioNativeStore: n.bridge, // no `has`
    localStorage: l.ls,
  });
  assertEquals(store.read("aio:app"), '{"count":7}');
  assertEquals(n.files.get("aio:app"), '{"count":7}');
});

Deno.test("native store: the APK half of has() exists and does not read the file", () => {
  // A green assertion about a Kotlin string is not evidence that an APK
  // persists — but the page's guard is inert unless the method is there at
  // all, and `isFile` (a stat) is what makes it able to answer when the read
  // could not.
  assertStringIncludes(KOTLIN, "fun has(key: String): Boolean");
  assertStringIncludes(KOTLIN, "fileFor(key).isFile");
});

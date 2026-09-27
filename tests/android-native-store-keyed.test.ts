// A standalone APK's store answers the app's OWN page only.
//
// `addJavascriptInterface` injects `AioNativeStore` into every frame of the
// WebView — a third-party `<iframe>` the app embeds included — and
// `onPageStarted` (which removes it from a foreign page) sees the main frame
// only. Up to 1.0.12 that frame could call `get`/`set` and read or overwrite
// the app's saved state. The template's store now takes a per-launch key first
// on every method and throws without it; the key reaches the page through a
// document-start script whose only origin rule is the app's own asset origin.
//
// This file pins the page's half (the keyed bridge is used with the key, a
// missing key never falls back to localStorage or writes anything, the iframe
// warning is kept for an unkeyed bridge only) and the Kotlin text the gate
// depends on. The APK half — a foreign frame on a real emulator that can
// neither read nor write — is the nativeFetch step of
// tests/android-emulator-e2e.test.ts (`deno task test:android`).
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

const KOTLIN = ANDROID_TEMPLATE["app/src/main/java/aio/app/MainActivity.kt"]!;
const KEY = "ab".repeat(32);

/** A stand-in for the template's bridge: every method refuses a wrong key. */
function fakeKeyed() {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const admit = (k: string) => {
    if (k !== KEY) throw new Error("AioNativeStore: wrong key");
  };
  return {
    files,
    calls,
    bridge: {
      read: (
        k: string,
        n: string,
      ) => (admit(k), calls.push("read"), files.get(n) ?? null),
      write: (
        k: string,
        n: string,
        v: string,
      ) => (admit(k), calls.push("write"), files.set(n, v), true),
      exists: (
        k: string,
        n: string,
      ) => (admit(k), calls.push("exists"), files.has(n)),
      where: (
        k: string,
      ) => (admit(k), "/data/user/0/app.aio.x/files/aio-store"),
    },
  };
}

function fakeLocalStorage(seed: Record<string, string> = {}) {
  const m = new Map(Object.entries(seed));
  return {
    m,
    ls: {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
    },
  };
}

Deno.test("keyed native store: used with the page's key — durable, and not exposed to frames", () => {
  const n = fakeKeyed();
  const store = _pickPersistStore({
    AioNativeStore: n.bridge,
    __aioNativeStoreKey: KEY,
    localStorage: fakeLocalStorage().ls,
  });
  assertEquals(store.kind, "native");
  assertEquals(store.durable, true);
  assertEquals(store.exposedToFrames, false);
  assertStringIncludes(store.describe, "/files/aio-store");
  store.write("aio:t", '{"count":2}');
  assertEquals(n.files.get("aio:t"), '{"count":2}');
  assertEquals(store.restore("aio:t"), { raw: '{"count":2}' });
  // A value that is there and cannot be read is still told apart.
  n.bridge.read = (k: string) => (k === KEY ? null : null);
  assert("unreadable" in store.restore("aio:t"));
});

Deno.test("keyed native store: no key on the page — nothing read, nothing written, no localStorage fallback", () => {
  const n = fakeKeyed();
  n.files.set("aio:t", '{"count":5}');
  const l = fakeLocalStorage({ "aio:t": '{"count":1}' });
  const store = _pickPersistStore({
    AioNativeStore: n.bridge,
    localStorage: l.ls,
  });
  assertEquals(store.kind, "native");
  assertEquals(store.durable, false);
  assertStringIncludes(store.describe, "LOCKED");
  const r = store.restore("aio:t");
  assert("unreadable" in r, JSON.stringify(r));
  assertStringIncludes(r.unreadable, "__aioNativeStoreKey");
  assertStringIncludes(r.unreadable, "DOCUMENT_START_SCRIPT");
  assertThrows(() => store.write("aio:t", "{}"), Error, "not handed its key");
  assertEquals(n.calls, [], "a locked store still called the bridge");
  assertEquals(l.m.get("aio:t"), '{"count":1}');
});

Deno.test("keyed native store: a boot without the key runs, and overwrites nothing", () => {
  const n = fakeKeyed();
  n.files.set("aio:t", '{"count":5}');
  const g = globalThis as Record<string, unknown>;
  g.AioNativeStore = n.bridge;
  const realError = console.error;
  const said: string[] = [];
  console.error = (...a: unknown[]) => void said.push(a.join(" "));
  try {
    _reset();
    const app = initStandalone<{ count: number }, { type: string }, never>(
      { count: 0 },
      {
        reduce: (s, a) => ({
          state: a.type === "INC" ? { count: s.count + 1 } : s,
          effects: [],
        }),
        execute: () => {},
        persistKey: "aio:t",
      },
    );
    app.dispatch({ type: "INC" });
    assertEquals(n.files.get("aio:t"), '{"count":5}');
    assert(
      said.some((l) => l.includes("__aioNativeStoreKey")),
      JSON.stringify(said),
    );
  } finally {
    console.error = realError;
    delete g.AioNativeStore;
    _reset();
  }
});

Deno.test("keyed native store: a restart through the keyed bridge reads the change back", () => {
  const n = fakeKeyed();
  const g = globalThis as Record<string, unknown>;
  g.AioNativeStore = n.bridge;
  g.__aioNativeStoreKey = KEY;
  const boot = () =>
    initStandalone<{ count: number }, { type: string }, never>({ count: 0 }, {
      reduce: (s, a) => ({
        state: a.type === "INC" ? { count: s.count + 1 } : s,
        effects: [],
      }),
      execute: () => {},
      persistKey: "aio:t",
    });
  try {
    _reset();
    const app = boot();
    app.dispatch({ type: "INC" });
    app.dispatch({ type: "INC" });
    // Written before dispatch returned — no debounce window.
    assertEquals(JSON.parse(n.files.get("aio:t")!).count, 2);
    _reset();
    assertEquals(boot().getState().count, 2);
  } finally {
    delete g.AioNativeStore;
    delete g.__aioNativeStoreKey;
    _reset();
  }
});

Deno.test("keyed native store: an unkeyed bridge (an activity copied from 1.0.12) still works, and is marked exposed", () => {
  const files = new Map<string, string>();
  const store = _pickPersistStore({
    AioNativeStore: {
      get: (k: string) => files.get(k) ?? null,
      set: (k: string, v: string) => (files.set(k, v), true),
      describe: () => "/x",
    },
  });
  assertEquals(store.kind, "native");
  assertEquals(store.durable, true);
  assertEquals(store.exposedToFrames, true);
  store.write("aio:t", "1");
  assertEquals(files.get("aio:t"), "1");
});

// ── the APK half, as text ───────────────────────────────────────────

/** The source of `class AioNativeStore`, up to the next top-level item. */
const STORE_CLASS = KOTLIN.slice(
  KOTLIN.indexOf("private class AioNativeStore("),
  KOTLIN.indexOf("\n}\n", KOTLIN.indexOf("private class AioNativeStore(")),
);

Deno.test("keyed native store: every bridge method admits the key before anything else", () => {
  assert(STORE_CLASS.length > 100, "MainActivity.kt has no AioNativeStore");
  const methods = [
    ...STORE_CLASS.matchAll(
      /@JavascriptInterface\s+fun (\w+)\(k: String[^)]*\)[^{]*\{\n\s*(.+)/g,
    ),
  ];
  const all = STORE_CLASS.match(/@JavascriptInterface/g)?.length ?? 0;
  assertEquals(
    methods.length,
    all,
    "a @JavascriptInterface method does not take the key first — a foreign " +
      "frame can call it",
  );
  assertEquals(methods.map((m) => m[1]).sort(), [
    "exists",
    "read",
    "where",
    "write",
  ]);
  for (const m of methods) {
    assertEquals(m[2], "admit(k)", `${m[1]} does not admit the key first`);
  }
  // Constant-time, from a CSPRNG, and a refusal is loud.
  assertStringIncludes(STORE_CLASS, "MessageDigest.isEqual(");
  assertStringIncludes(STORE_CLASS, "SecureRandom().nextBytes(");
  assertStringIncludes(STORE_CLASS, "throw SecurityException(");
  // The 1.0.12 file layout — an upgrade reads the state it wrote.
  assertStringIncludes(
    STORE_CLASS,
    'File(dir, safe + "." + Integer.toHexString(key.hashCode()) + ".json")',
  );
  assertStringIncludes(KOTLIN, 'AioNativeStore(File(filesDir, "aio-store"))');
});

Deno.test("keyed native store: the key reaches the app's own origin only", () => {
  const at = KOTLIN.indexOf("WebViewCompat.addDocumentStartJavaScript(");
  assert(at >= 0, "the key is no longer handed out by a document-start script");
  const call = KOTLIN.slice(at, KOTLIN.indexOf("\n                }", at));
  assertStringIncludes(call, "STORE_KEY_GLOBAL");
  assertStringIncludes(call, "store.key");
  assertStringIncludes(call, 'setOf("https://" + ASSET_HOST)');
  // …inside the standalone-only block, next to the bridge itself.
  const guard = KOTLIN.indexOf("if (!TALKS_TO_SERVER) {");
  assert(guard >= 0 && guard < at);
  assert(
    KOTLIN.indexOf("addJavascriptInterface(store, STORE_GLOBAL)", guard) < at,
  );
});

Deno.test("keyed native store: the page and the APK name the same key global", () => {
  const src = Deno.readTextFileSync(
    fromFileUrl(new URL("../src/browser/native-fetch.ts", import.meta.url)),
  );
  const page = src.match(/NATIVE_STORE_KEY_GLOBAL = "([^"]+)"/)?.[1];
  const kotlin = KOTLIN.match(/STORE_KEY_GLOBAL = "([^"]+)"/)?.[1];
  assert(page && kotlin);
  assertEquals(page, kotlin);
});

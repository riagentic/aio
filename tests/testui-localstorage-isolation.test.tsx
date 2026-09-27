// testUI gives every hermetic mount its own `localStorage` — and gives the
// host's back exactly.
//
// Two ways it did not:
//  1. out-of-order dispose (mount A, mount B, dispose A, dispose B) put A's
//     dead store back as the global `localStorage`, each mount restoring the
//     descriptor it had found;
//  2. a module that took `const ls = localStorage` at import time held the
//     HOST store (Deno's, on disk), so its writes leaked into every later
//     mount — and past the run.
import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { spy, stub } from "@std/testing/mock";
import { testUI } from "../src/testing/ui-test.ts";

// Taken at import, before any mount — the way an app module does it.
const ls = (globalThis as { localStorage: Storage }).localStorage;
// Per run: a leak (the bug) must not fail the NEXT run of the fixed code.
const KEY = `iso-k-${crypto.randomUUID()}`;

function App() {
  return (
    <div>
      <span class="seen">{ls.getItem(KEY) ?? "none"}</span>
      <div class="button" onClick={() => ls.setItem(KEY, "written")}>
        Write
      </div>
    </div>
  );
}

const g = globalThis as { localStorage?: Storage };

Deno.test("testUI: out-of-order dispose restores the host localStorage exactly", async () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const hostKey = `iso-host-${crypto.randomUUID()}`;
  g.localStorage?.setItem(hostKey, "host");
  try {
    const a = await testUI(App);
    const b = await testUI(App);
    g.localStorage!.setItem("iso-b", "b");
    await a.dispose();
    assertEquals(g.localStorage!.getItem("iso-b"), "b", "B keeps its store");
    await b.dispose();
    assertEquals(
      Object.getOwnPropertyDescriptor(globalThis, "localStorage"),
      before,
      "the host's own localStorage is back",
    );
    if (before) {
      assertEquals(g.localStorage!.getItem(hostKey), "host");
      assertEquals(g.localStorage!.getItem("iso-b"), null, "no mount's data");
    }
  } finally {
    g.localStorage?.removeItem(hostKey);
  }
});

Deno.test("testUI: a localStorage captured at import is isolated per mount", async () => {
  try {
    {
      await using ui = await testUI(App);
      ui.WriteButton.click();
      await ui.settle();
      assertEquals(ls.getItem(KEY), "written", "the mount sees its write");
    }
    {
      await using ui = await testUI(App);
      await ui.settle();
      assertEquals(ls.getItem(KEY), null, "the next mount starts fresh");
      assertEquals(ui.document.querySelector(".seen")?.textContent, "none");
    }
    assertEquals(ls.getItem(KEY), null, "and the host never saw it");
  } finally {
    ls.removeItem(KEY);
  }
});

Deno.test("testUI: enumerating localStorage shows only the mount's keys", async () => {
  // Deno's store is shared by every test file and `--parallel` process: a
  // test that lists its keys must not see theirs.
  const foreign = `iso-foreign-${crypto.randomUUID()}`;
  ls.setItem(foreign, "another test's data");
  try {
    await using _ui = await testUI(App);
    const store = g.localStorage!;
    store.setItem("mine", "1");
    (store as unknown as Record<string, string>).named = "2";
    const forIn: string[] = [];
    for (const k in store) forIn.push(k);
    assertEquals(Object.keys(store).sort(), ["mine", "named"]);
    assertEquals(forIn.sort(), ["mine", "named"]);
    assertEquals(JSON.parse(JSON.stringify(store)), { mine: "1", named: "2" });
    assertEquals(store.length, 2);
    assertEquals([store.key(0), store.key(1)].sort(), ["mine", "named"]);
    // A reference captured before the mount counts and indexes the same.
    assertEquals(ls.length, 2);
    assertEquals([ls.key(0), ls.key(1)].sort(), ["mine", "named"]);
    assertEquals(store.getItem(foreign), null);
  } finally {
    ls.removeItem(foreign);
  }
  assertEquals(ls.getItem("mine"), null, "the host never saw the mount's");
});

Deno.test("testUI: stubbing a method on the localStorage instance is refused", async () => {
  // In a browser `stub(localStorage, "setItem", quotaError)` stores an ITEM
  // named "setItem" and keeps the method, so a quota test runs the happy
  // path. testUI used to be just as silent; it refuses, naming the fix.
  const full = () => {
    throw new DOMException("full", "QuotaExceededError");
  };
  await using _ui = await testUI(App);
  for (const target of [g.localStorage!, ls]) {
    for (const n of ["setItem", "getItem", "removeItem"] as const) {
      assertThrows(
        () => stub(target, n, full),
        TypeError,
        `stub Storage.prototype.${n} instead`,
      );
    }
    assertThrows(
      () => ((target as unknown as Record<string, unknown>).setItem = full),
      TypeError,
      "Storage.prototype.setItem",
    );
  }
  // Nothing half-applied: the methods and the store are untouched.
  g.localStorage!.setItem("q", "1");
  assertEquals(ls.getItem("q"), "1");
  assertEquals(Object.keys(g.localStorage!), ["q"]);
});

Deno.test("testUI: a stub on Storage.prototype takes effect inside a mount", async () => {
  const full = () => {
    throw new DOMException("full", "QuotaExceededError");
  };
  {
    await using ui = await testUI(App);
    {
      using _s = stub(Storage.prototype, "setItem", full);
      assertThrows(() => g.localStorage!.setItem("q", "1"), DOMException);
      assertThrows(() => ls.setItem("q", "1"), DOMException);
      ui.WriteButton.click();
      await assertRejects(() => ui.settle(), Error, "threw");
    }
    {
      // A spy calls through to the mount's store, from either reference.
      using get = spy(Storage.prototype, "getItem");
      g.localStorage!.setItem("q", "1");
      assertEquals(g.localStorage!.getItem("q"), "1");
      assertEquals(ls.getItem("q"), "1");
      assertEquals(get.calls.length, 2);
    }
    assertEquals(Object.keys(g.localStorage!), ["q"]);
  }
  assertEquals(ls.getItem("q"), null, "the host never saw the mount's");
});

// Taken at import, before any stub.
const nativeSetItem = Storage.prototype.setItem;

Deno.test("testUI: a Storage.prototype stub made before the mount takes effect inside it", async () => {
  // The pattern the docs recommend: stub first, then mount. The mount used
  // to save the stub as "the method", then answer from its own store — the
  // quota test ran the happy path in silence.
  const full = () => {
    throw new DOMException("full", "QuotaExceededError");
  };
  {
    using _s = stub(Storage.prototype, "setItem", full);
    await using ui = await testUI(App);
    assertThrows(() => g.localStorage!.setItem("q", "1"), DOMException);
    assertThrows(() => ls.setItem("q", "1"), DOMException);
    ui.WriteButton.click();
    await assertRejects(() => ui.settle(), Error, "threw");
  }
  assertEquals(Storage.prototype.setItem, nativeSetItem);
  assertEquals(ls.getItem("q"), null, "the host never saw the mount's");
});

Deno.test("testUI: a spy made before the mount cannot reach the host store", async () => {
  // It calls through to the native method, which only knows the host's
  // store: refused with the fix, never a silent write past the mount.
  using _s = spy(Storage.prototype, "setItem");
  await using _ui = await testUI(App);
  for (const target of [g.localStorage!, ls]) {
    assertThrows(() => target.setItem(KEY, "1"), TypeError, "after testUI()");
  }
  assertEquals(ls.getItem(KEY), null);
});

Deno.test("testUI: restoring a pre-mount stub mid-mount returns to the mount's store", async () => {
  const s = stub(Storage.prototype, "setItem", () => {
    throw new DOMException("full", "QuotaExceededError");
  });
  try {
    {
      await using _ui = await testUI(App);
      s.restore();
      ls.setItem(KEY, "captured");
      g.localStorage!.setItem("q", "1");
      assertEquals(g.localStorage!.getItem(KEY), "captured");
      assertEquals(Object.keys(g.localStorage!).sort(), [KEY, "q"].sort());
    }
    assertEquals(ls.getItem(KEY), null, "the host never saw the mount's");
    assertEquals(
      Storage.prototype.setItem,
      nativeSetItem,
      "dispose never puts the restored stub back",
    );
    {
      await using _ui = await testUI(App);
      g.localStorage!.setItem("q", "2");
      assertEquals(ls.getItem("q"), "2");
    }
  } finally {
    if (!s.restored) s.restore();
    ls.removeItem(KEY);
  }
});

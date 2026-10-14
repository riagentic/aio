// `testUI` mounts the component BEFORE the test body runs, so a `fetch` stub
// the body installs is too late for a request `onMount` makes: it has already
// gone to the real network. A field report's blocklist refresh did exactly
// that from a unit test and failed 2 of 6 runs, with the download's speed.
// `testUI(App, { fetch })` is the network from the first mount on, and a
// `settle()` that gives up says which request it is waiting on.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { onMount } from "../src/air/renderer-lifecycle.ts";
import { fetchWaitNote, testUI } from "../src/testing/ui-test.ts";

const list = cell("fetchopt-list", {
  state: { names: [] as string[], loads: 0 },
  methods: {
    async refresh(s: { names: string[]; loads: number }) {
      const r = await fetch("https://blocklist.invalid/names.json");
      s.names = await r.json();
      s.loads++;
    },
  },
});

function Gate() {
  onMount(() => {
    list.refresh();
  });
  return <ul t="names">{list.names.map((n) => <li>{n}</li>)}</ul>;
}

Deno.test("testUI fetch option: answers the request the MOUNT makes, and is gone after the test", async () => {
  const before = globalThis.fetch;
  const asked: string[] = [];
  {
    await using ui = await testUI(Gate, {
      fetch: (input) => {
        asked.push(String(input));
        return Response.json(["evil.example"]);
      },
    });
    await ui.settle();
    assertEquals(asked, ["https://blocklist.invalid/names.json"]);
    assertEquals(list.names, ["evil.example"]);
    assertStringIncludes(ui.html(), "evil.example");
  }
  assert(globalThis.fetch === before, "the test's network is restored");
});

Deno.test("testUI fetch option: a thrown answer rejects the fetch, as a network failure does", async () => {
  // The mount's own refresh fails with it, and the harness reports a failed
  // call nobody awaited — at the mount, where it happened.
  const before = globalThis.fetch;
  const e = await testUI(Gate, {
    fetch: () => {
      throw new TypeError("offline");
    },
  }).then(() => null, (e: Error) => e);
  assert(e, "the mount reports the failed refresh");
  assertStringIncludes(e.message, "fetchopt-list.refresh() failed");
  assertStringIncludes(e.message, "offline");
  assert(globalThis.fetch === before, "a mount that failed left no stub");
});

Deno.test("testUI: settle() that gives up names the fetch it waits on — the option's, or the one installed at the mount", async () => {
  // With the option: the stub has not answered.
  {
    let answer!: (r: Response) => void;
    await using ui = await testUI(Gate, {
      settleIterations: 3,
      fetch: () => new Promise<Response>((r) => answer = r),
    });
    const e = await ui.settle().then(() => null, (e: Error) => e);
    assert(e, "settle() gave up");
    assertStringIncludes(e.message, "fetchopt-list");
    assertStringIncludes(
      e.message,
      "waiting on fetch(https://blocklist.invalid/names.json)",
    );
    assertStringIncludes(e.message, "has not answered");
    answer(Response.json([]));
    await ui.settle();
  }
  // Without it: it went to the fetch that was there at the mount.
  {
    const real = globalThis.fetch;
    let answer!: (r: Response) => void;
    globalThis.fetch =
      (() => new Promise<Response>((r) => answer = r)) as typeof fetch;
    try {
      await using ui = await testUI(Gate, { settleIterations: 3 });
      const e = await ui.settle().then(() => null, (e: Error) => e);
      assert(e, "settle() gave up");
      assertStringIncludes(
        e.message,
        "waiting on fetch(https://blocklist.invalid/names.json)",
      );
      assertStringIncludes(e.message, "testUI was given no `fetch:`");
      assertStringIncludes(e.message, "testUI(App, { fetch:");
      answer(Response.json([]));
      await ui.settle();
    } finally {
      globalThis.fetch = real;
    }
  }
});

Deno.test("testUI: the waiting-fetch note is empty with nothing waiting, and short with many", () => {
  assertEquals(fetchWaitNote([]), "");
  const many = fetchWaitNote(
    ["a", "b", "c", "d", "a"].map((u) => ({
      url: `https://x.invalid/${u}`,
      stubbed: true,
    })),
  );
  assertStringIncludes(many, "fetch(https://x.invalid/c) and 1 more");
  assert(!many.includes("/d)"), many);
});

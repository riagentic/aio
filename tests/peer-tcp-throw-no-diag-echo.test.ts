// A callee method that throws reaches a TCP peer caller ONCE — as that call's
// rejection. The server's error diagnostic for the same throw used to be
// logged again by the caller (`ERROR cli server diagnostic: …`), which a UDS
// caller never printed: the same throw, two transports, two logs.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { testApps } from "../src/testing/apps-test.ts";
import { peer } from "../src/server/peer.ts";
import { interceptConsole } from "./console-capture.ts";

Deno.test("peer over TCP: a callee throw is the call's rejection, not also a caller log line", async () => {
  const svc = cell("throwsvc", {
    state: { n: 0 },
    methods: {
      boom(_s: { n: number }) {
        throw new Error("callee says no");
      },
      ok(s: { n: number }) {
        s.n++;
        return s.n;
      },
    },
  });
  await using world = await testApps({ svc: { cells: [svc] } });
  const lines: string[] = [];
  const restore = interceptConsole(lines);
  try {
    using p = (await peer(world.get("svc").url))!;
    assert(p);
    await assertRejects(
      () => p.call("throwsvc", "boom"),
      Error,
      "callee says no",
    );
    // a later call proves any diag frame for the throw has already landed
    await p.call("throwsvc", "ok");
    await new Promise((r) => setTimeout(r, 100));
  } finally {
    restore();
  }
  const echoed = lines.filter((l) => l.includes("server diagnostic"));
  assert(echoed.length === 0, `echoed in the caller:\n${echoed.join("\n")}`);
});

// …while ANOTHER client's throw is still said (the dev overlay's analogue):
// only the caller's own rejection is skipped. Own world: the diag bus dedups
// a type per app for 5 s.
Deno.test("peer over TCP: another client's throw is still said", async () => {
  const svc = cell("throwsvc2", {
    state: { n: 0 },
    methods: {
      boom(_s: { n: number }) {
        throw new Error("callee says no");
      },
      ok(s: { n: number }) {
        s.n++;
        return s.n;
      },
    },
  });
  await using world = await testApps({ svc: { cells: [svc] } });
  const seen: string[] = [];
  const restore2 = interceptConsole(seen);
  try {
    using watcher = (await peer(world.get("svc").url))!;
    using other = (await peer(world.get("svc").url))!;
    await watcher.call("throwsvc2", "ok");
    await assertRejects(() => other.call("throwsvc2", "boom"));
    await watcher.call("throwsvc2", "ok");
    await other.call("throwsvc2", "ok");
  } finally {
    restore2();
  }
  assertEquals(
    seen.filter((l) => l.includes("server diagnostic: callee says no")).length,
    1,
    seen.join("\n"),
  );
});

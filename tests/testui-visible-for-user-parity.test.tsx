// testUI renders what the USER'S SOCKET carries, not the server's whole state.
//
// A real client never holds another user's rows: the broadcast runs
// `visible.forUser` before a frame leaves the server. `testUI` keeps the
// server's state in the same signals the getters read, and applied only the
// structural include/exclude — so an orders list filtered per user rendered
// BOTH users' orders under `{ user: alice }`, and all of them anonymously,
// while the wire sent alice one row and an anonymous socket none. A UI test
// passed while showing other users' data.
//
// Each case asks the real wire first and then asserts the harness agrees, so
// the expected number is never hand-reasoned.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { h } from "../src/air/vdom.ts";
import { setLogger } from "../src/diagnostics/logger-api.ts";
import type { LogSink } from "../src/diagnostics/logger-types.ts";

type Order = { id: string; owner: string };
type S = { items: Order[]; total: number };

const orders = cell("fuOrders", {
  state: {
    items: [{ id: "1", owner: "alice" }, { id: "2", owner: "bob" }] as Order[],
    total: 2,
  },
  visible: {
    forUser: (s: S, user?: { id?: string; role?: string }) =>
      user?.role === "admin"
        ? s
        : { ...s, items: s.items.filter((o) => o.owner === user?.id) },
  },
  methods: {
    add(s: S, o: Order) {
      s.items.push(o);
      s.total++;
    },
  },
});
const O = orders as unknown as { items: Order[]; add: (o: Order) => void };

// A filter that fails closed: the broadcast omits the cell for everyone.
const broken = cell("fuBroken", {
  state: { secret: "every-row" },
  visible: {
    forUser: () => {
      throw new Error("no user record");
    },
  },
  methods: {},
});
const B = broken as unknown as { secret: string };

/** The `orders` slice the server's first state frame carries for `token`. */
async function wireItems(token?: string): Promise<number | "omitted"> {
  // An app with `users` refuses an anonymous socket outright, so the
  // anonymous view is asked of an app without them — which is also the app
  // an unsigned testUI mount stands in for.
  await using srv = await testServer({
    cells: [orders],
    ...(token ? { users: { [token]: { id: "alice", role: "member" } } } : {}),
  });
  const frame = await new Promise<Record<string, unknown>>(
    (resolve, reject) => {
      const ws = new WebSocket(
        `ws://127.0.0.1:${srv.port}/ws${token ? `?token=${token}` : ""}`,
      );
      let got: Record<string, unknown> | undefined;
      const timer = setTimeout(() => ws.close(), 8000);
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data as string);
        if (m.t !== "state" && m.type !== "state") return;
        got = typeof m.d === "string" ? JSON.parse(m.d) : (m.d ?? m.payload);
        ws.close();
      };
      ws.onclose = () => {
        clearTimeout(timer);
        got ? resolve(got) : reject(new Error("no state frame"));
      };
    },
  );
  const slice = frame.fuOrders as { items: Order[] } | undefined;
  return slice ? slice.items.length : "omitted";
}

const App = () =>
  h("div", null, h("span", { class: "label" }, `count:${O.items.length}`));

Deno.test("forUser parity: an anonymous testUI mount sees what an anonymous socket gets", async () => {
  const wire = await wireItems();
  assertEquals(wire, 0, "precondition: the wire filters the anonymous view");
  await using ui = await testUI(App, { cells: [orders] });
  assertStringIncludes(ui.html(), `count:${wire}`);
});

Deno.test("forUser parity: testUI { user } sees exactly that user's rows", async () => {
  const wire = await wireItems("tokA");
  assertEquals(wire, 1, "precondition: alice's socket carries one row");
  await using ui = await testUI(App, {
    cells: [orders],
    user: { id: "alice", role: "member" },
  });
  assertStringIncludes(ui.html(), `count:${wire}`);
  // …and it stays the filtered view across a commit (the view is per state).
  O.add({ id: "3", owner: "bob" });
  O.add({ id: "4", owner: "alice" });
  await ui.settle();
  assertStringIncludes(ui.html(), "count:2");
});

Deno.test("forUser parity: an expectCell failure prints the view the predicate read, not the server's", async () => {
  // The predicate reads alice's filtered view; the failure used to dump the
  // SERVER slice — both users' rows — so `items.length === 2` failed beside a
  // dump showing two items, and printed a row this client can never see.
  await using ui = await testUI(App, {
    cells: [orders],
    user: { id: "alice", role: "member" },
  });
  let msg = "";
  try {
    await ui.expectCell(orders, (c) => c.items.length === 2);
  } catch (e) {
    msg = String(e);
  }
  assertStringIncludes(msg, "expectCell failed for cell 'fuOrders'");
  assertStringIncludes(msg, '"items":[{"id":"1","owner":"alice"}]');
  assertEquals(msg.includes('"owner":"bob"'), false, "no row alice cannot see");
});

Deno.test("forUser parity: a throwing filter fails CLOSED in testUI, as on the wire", async () => {
  const lines: string[] = [];
  setLogger({
    logDir: "",
    pub: (lvl: string, _c: string, msg: string) =>
      void lines.push(`${lvl} ${msg}`),
    perf: () => {},
    flush: () => Promise.resolve(),
  } as unknown as LogSink);
  try {
    await using _ui = await testUI(() => h("div", null, "x"), {
      cells: [broken],
      seed: { fuBroken: { secret: "LIVE-VALUE" } },
    });
    // Omitted means a client holds no slice and reads the DECLARED state —
    // never the server's live value, which is what the harness used to hand
    // back.
    assertEquals(B.secret, "every-row");
    assertStringIncludes(
      lines.join("\n"),
      "[fuBroken] visible.forUser threw — omitting the cell",
    );
  } finally {
    setLogger(null);
  }
});

// An `async` filter that REJECTS. The harness's client view decides through
// the same pure rule as the broadcast, which omitted the cell for the returned
// Promise but dropped the Promise itself unobserved — so the rejection escaped
// as an unhandled rejection (a failed test file here; a crashed process in a
// server without `guardDispatches`). It must fail closed and be logged by
// name, and nothing may escape.
const asyncRejects = cell("fuAsyncRejects", {
  state: { secret: "declared" },
  visible: {
    forUser: (async () => {
      await Promise.resolve();
      throw new Error("no user record");
    }) as never,
  },
  methods: {},
});
const AR = asyncRejects as unknown as { secret: string };

Deno.test("forUser parity: a REJECTING async filter fails CLOSED in testUI, loudly, and never escapes as an unhandled rejection", async () => {
  const lines: string[] = [];
  const escaped: unknown[] = [];
  const onRejection = (e: PromiseRejectionEvent) => {
    escaped.push(e.reason);
    e.preventDefault();
  };
  globalThis.addEventListener("unhandledrejection", onRejection);
  setLogger({
    logDir: "",
    pub: (lvl: string, _c: string, msg: string) =>
      void lines.push(`${lvl} ${msg}`),
    perf: () => {},
    flush: () => Promise.resolve(),
  } as unknown as LogSink);
  try {
    await using ui = await testUI(
      () => h("div", null, h("span", { class: "label" }, `s:${AR.secret}`)),
      { cells: [asyncRejects], seed: { fuAsyncRejects: { secret: "LIVE" } } },
    );
    assertStringIncludes(ui.html(), "s:declared");
    // Two macrotask turns: an unobserved rejection is reported after the
    // microtask queue drains.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    assertEquals(escaped, []);
    assertStringIncludes(
      lines.join("\n"),
      "[fuAsyncRejects] visible.forUser is ASYNC",
    );
    assertStringIncludes(lines.join("\n"), "Make the filter synchronous");
  } finally {
    setLogger(null);
    globalThis.removeEventListener("unhandledrejection", onRejection);
  }
});

// After a LOGIN, the page holds what its socket would carry for the signed-in
// user — under testUI exactly as over a real socket. testUI read cells as the
// `user` option named, so a page signed in through the form (the session
// cookie, `testPageFetch`) still read — and called — as anonymous: it showed
// the anonymous `visible.forUser` view where alice's socket carries hers, and
// a member-only method was refused. A differential: the same login, the
// in-process page against the real server's socket, identical views required.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { SignIn, useUser } from "../src/air.ts";
import { testPageFetch, testServer, testUI } from "../src/cell-test.ts";
import { dec } from "../src/protocol/envelope.ts";

type Order = { id: string; userId: string };
const orders = cell("loginViewOrders", {
  state: {
    items: [
      { id: "a1", userId: "alice" },
      { id: "b1", userId: "bob" },
    ] as Order[],
    placed: 0,
  },
  access: (user) => !!user,
  visible: {
    forUser: (s, user) => ({
      ...s,
      items: s.items.filter((o) => o.userId === user?.id),
    }),
  },
  methods: {
    place(s) {
      s.placed += 1;
    },
  },
});

function App() {
  const user = useUser();
  if (user === undefined) return <p>Loading</p>;
  if (user === null) return <SignIn />;
  return (
    <div>
      <p t="mine">{orders.items.map((o) => o.id).join(",")}</p>
      <button type="button" onClick={() => orders.place()}>Place</button>
    </div>
  );
}

/** The `loginViewOrders` slice the real socket carries for `token`. */
function socketView(url: string, token: string): Promise<unknown> {
  const { promise, resolve, reject } = Promise.withResolvers<unknown>();
  const ws = new WebSocket(`${url.replace("http", "ws")}/ws?token=${token}`);
  const timer = setTimeout(() => reject(new Error("no state frame")), 5000);
  ws.onmessage = (e) => {
    const f = dec(String(e.data)) as {
      t?: string;
      d?: Record<string, unknown>;
    };
    const slice = f?.t === "state" ? f.d?.loginViewOrders : undefined;
    if (slice !== undefined) {
      clearTimeout(timer);
      resolve(slice);
      ws.close();
    }
  };
  return promise.finally(() =>
    ws.readyState === WebSocket.CLOSED
      ? undefined
      : new Promise<void>((r) => ws.addEventListener("close", () => r()))
  );
}

Deno.test("login → the page reads and calls as the signed-in user, as its socket does", async () => {
  await using srv = await testServer({ cells: [orders], auth: true });
  using page = testPageFetch(srv);
  const made = await fetch("/__aio/auth/signup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: "alice", password: "password123" }),
  });
  assertEquals(made.status, 201);
  await made.body?.cancel();
  const token = [...page.cookies].find(([n]) => n.startsWith("aio_session_"))
    ?.[1];
  assert(token, "no session");
  const wire = await socketView(srv.url, token) as { items: Order[] };
  assertEquals(wire.items.map((o) => o.id), ["a1"]);

  await using ui = await testUI(App);
  await ui.waitFor(() => ui.html().includes("a1"), { timeoutMs: 5000 });
  assertEquals(ui.html().includes("b1"), false, "another user's row shown");
  ui.PlaceButton.click();
  await ui.settle();
  // The in-process cell the page called (testUI's own runtime).
  assertEquals(orders.placed, 1, "the member-only call was refused");
});

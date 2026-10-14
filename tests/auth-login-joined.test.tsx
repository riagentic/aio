// A login flow, end to end in one process: the form against the endpoints.
//
// It was tested in two halves that never met. tests/auth-ui-flows.test.ts
// drives `<SignIn/>` against CANNED answers; tests/auth-flows.test.ts sends
// the real endpoints HAND-MADE requests. What one sends and the other reads —
// a field's name, an error's code, the cookie — was joined only in a real
// browser (e2e). `testPageFetch(srv)` is the join: the mounted form's own
// requests reach a real server, the session cookie it answers with is
// carried, and the next mount (the reload) is signed in by it.
import { assert, assertEquals, assertMatch } from "@std/assert";
import { cell } from "../mod.ts";
import { SignIn, signOut, useUser } from "../src/air.ts";
import { testPageFetch, testServer, testUI } from "../src/cell-test.ts";

const shop = cell("joinedShop", {
  state: { orders: 0 },
  access: true,
  visible: "all",
  methods: {
    order(s: { orders: number }) {
      s.orders += 1;
    },
  },
});

function App() {
  const user = useUser();
  if (user === undefined) return <p>Loading</p>;
  if (user === null) return <SignIn />;
  return <p t="who">Signed in as {user.id}</p>;
}

/** Does the server accept `token` on its socket? (`null`: anonymous.) */
function wsAccepts(url: string, token: string | null): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const ws = new WebSocket(
    `${url.replace("http", "ws")}/ws${token ? `?token=${token}` : ""}`,
  );
  ws.onmessage = () => {
    resolve(true);
    ws.close();
  };
  // A refused handshake ends in `close` (after `error`): one answer.
  ws.onclose = () => resolve(false);
  return promise.finally(() =>
    ws.readyState === WebSocket.CLOSED
      ? undefined
      : new Promise<void>((r) => ws.addEventListener("close", () => r()))
  );
}

Deno.test("login, joined: the form signs up, in and out against the real endpoints — cookie carried, each side reading what the other sent", async () => {
  await using srv = await testServer({ cells: [shop], auth: true });
  using page = testPageFetch(srv);
  const session = () =>
    [...page.cookies].find(([name]) => name.startsWith("aio_session_"))?.[1];
  const shows = async (text: string) => {
    await using ui = await testUI(App);
    await ui.waitFor(() => ui.html().includes(text), { timeoutMs: 5000 });
    return ui.html();
  };

  // 1. Anonymous: `/me` is answered by the server, and the form it offers is
  //    the one THIS server's features call for (signup is open).
  {
    await using ui = await testUI(App);
    await ui.waitFor(() => ui.present("SignIn"), { timeoutMs: 5000 });
    assertEquals(session(), undefined);

    // 2. Sign up through the form. The server makes the account and answers
    //    with the session; the form reads it.
    ui.SignIn.NewHereCreateAnAccountButton.click();
    await ui.waitFor(() => ui.html().includes("Create account"), {
      timeoutMs: 5000,
    });
    ui.SignIn.UserIdInput.type("alice");
    ui.SignIn.PasswordInput.type("password123");
    ui.SignIn.CreateAccountButton.click();
    await ui.waitFor(() => ui.html().includes("Signed in as alice"), {
      timeoutMs: 5000,
    });
  }
  const first = session();
  assert(first, `no session cookie was kept: ${[...page.cookies.keys()]}`);
  assertEquals(srv.app.sessions!.get(first)?.id, "alice");
  assert(await wsAccepts(srv.url, first), "the socket refuses the session");

  // 3. The reload: a fresh mount is signed in by the cookie alone.
  page.reload();
  assertMatch(await shows("Signed in as"), /Signed in as alice/);

  // 4. Sign out, as the app's button would. The server ends the session and
  //    clears the cookie; the old token opens nothing.
  await signOut();
  assertEquals(session(), undefined, "the cookie was not cleared");
  assertEquals(srv.app.sessions!.get(first), null);
  assert(!(await wsAccepts(srv.url, first)), "a signed-out session connects");

  // 5. Back at the form. A wrong password is refused in the form's OWN words
  //    for the server's code, and leaves no session…
  page.reload();
  {
    await using ui = await testUI(App);
    await ui.waitFor(() => ui.html().includes("<form"), { timeoutMs: 5000 });
    ui.SignIn.UserIdInput.type("alice");
    ui.SignIn.PasswordInput.type("wrong-wrong-1");
    ui.SignIn.SignInButton.click();
    await ui.waitFor(() => ui.html().includes("Wrong id or password."), {
      timeoutMs: 5000,
    });
    assertEquals(session(), undefined);

    // …and the right one signs in again, with a new session.
    ui.SignIn.PasswordInput.clear();
    ui.SignIn.PasswordInput.type("password123");
    ui.SignIn.SignInButton.click();
    await ui.waitFor(() => ui.html().includes("Signed in as alice"), {
      timeoutMs: 5000,
    });
  }
  const second = session();
  assert(second && second !== first, "no new session after signing in again");
  assertEquals(srv.app.sessions!.get(second)?.id, "alice");
});

Deno.test("testPageFetch: cookies go to their own server only, and the fetch it replaced comes back", async () => {
  const before = globalThis.fetch;
  await using srv = await testServer({ cells: [shop], auth: true });
  // A second origin that echoes the Cookie header it is sent.
  const other = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen() {} },
    (req) => new Response(req.headers.get("cookie") ?? "none"),
  );
  try {
    using page = testPageFetch(srv);
    assert(globalThis.fetch !== before);
    const made = await fetch("/__aio/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: "bob", password: "password123" }),
    });
    assertEquals(made.status, 201);
    await made.body?.cancel();
    assertEquals(page.cookies.size, 1);
    const me = await (await fetch("/__aio/auth/me")).json();
    assertEquals(me.user?.id, "bob", "the cookie was not sent back");
    const seen = await (await fetch(`http://127.0.0.1:${other.addr.port}/`))
      .text();
    assertEquals(seen, "none", "the session cookie left its origin");
  } finally {
    await other.shutdown();
  }
  assertEquals(globalThis.fetch, before);
});

// What made the form undrivable: Deno's `FormData` refuses a DOM element that
// is not its own, and a submit handler reads its form with exactly that.
Deno.test("testUI: a submit handler's new FormData(form) reads the mounted form — and without a form it is the native FormData", async () => {
  const native = globalThis.FormData;
  const read: Record<string, unknown>[] = [];
  const Form = () => (
    <form
      onSubmit={(e: Event) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget as HTMLFormElement);
        read.push(Object.fromEntries(data));
      }}
    >
      <input name="city" aria-label="City" />
      <button type="submit">Send</button>
    </form>
  );
  {
    await using ui = await testUI(Form);
    ui.CityInput.type("Pune");
    ui.SendButton.click();
    await ui.waitFor(() => read.length === 1);
    assertEquals(read, [{ city: "Pune" }]);
    // Still what `fetch` and `Response` speak.
    const plain = new FormData();
    plain.append("a", "1");
    assert(plain instanceof native);
    const echoed = await new Response(plain).formData();
    assertEquals(echoed.get("a"), "1");
    assert(echoed instanceof FormData, "a native FormData is no FormData");
  }
  assertEquals(globalThis.FormData, native, "the global was not handed back");
});

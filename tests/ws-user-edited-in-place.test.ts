// A user record edited IN PLACE reaches the socket that holds it.
//
// A `resolveUser` (or a session store) that keeps its records in a map hands
// back the same object on every re-check. Demote that record — `u.role =
// "user"` — and the socket's `meta.user` IS the edited object: comparing "the
// user it had" with "the user it has now" compared the object with itself, so
// the view was never re-sent and an idle page went on showing what the app
// had just decided this identity may not see. The key taken at connect is what
// tells them apart.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";

type S = { n: number; secret: string };
type U = { id: string; role: string };

Deno.test("ws: a user demoted by editing its record in place is re-sent its view, with the app idle", async () => {
  _resetAuthFails();
  const vault = cell("inplace_vault", {
    state: { n: 0, secret: "" },
    visible: {
      forUser: (s: S, u: unknown) =>
        (u as U | undefined)?.role === "admin" ? s : { n: s.n, secret: "" },
    },
    access: true,
    methods: {
      bump(s: S) {
        s.n++;
        s.secret = "PRIVATE-" + s.n;
      },
    },
  });
  const records = new Map<string, U>([["key-1", {
    id: "key-1",
    role: "admin",
  }]]);
  await using srv = await testServer({
    cells: [vault],
    resolveUser: (tok: string) => records.get(tok) ?? null,
  });
  const frames: string[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?token=key-1`);
  const closed = new Promise<void>((r) => ws.onclose = () => r());
  ws.onmessage = (e) => frames.push(String(e.data));
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  try {
    await vault.bump();
    const seen = Date.now() + 3_000;
    while (!frames.some((f) => f.includes("PRIVATE-1")) && Date.now() < seen) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert(
      frames.some((f) => f.includes("PRIVATE-1")),
      "an admin sees the secret",
    );

    // The same object, edited. Nothing else happens: no dispatch, no frame in.
    records.get("key-1")!.role = "user";
    const mark = frames.length;
    // One sweep period (5s) plus slack.
    const deadline = Date.now() + 9_000;
    while (frames.length === mark && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    const after = frames.slice(mark);
    assert(after.length > 0, "the demoted socket must be sent its view again");
    assertEquals(
      after.some((f) => f.includes("PRIVATE-")),
      false,
      "…and that view no longer holds the admin-only slice",
    );
  } finally {
    ws.close();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      closed,
      new Promise((r) => timer = setTimeout(r, 1000)),
    ]);
    clearTimeout(timer);
    _resetAuthFails();
  }
});

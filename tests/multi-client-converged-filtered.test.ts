// `converged()` compares each client with what the server SENDS that client,
// not with the server's raw state.
//
// A client holds the filtered view: a cell with `visible: { exclude: [...] }`
// never carries the excluded field to any client. `converged()` compared that
// filtered slice to the RAW server slice, so for such a cell the two could
// never be equal — the harness threw "clients did not converge" for an app
// that had converged perfectly, and the only way to make the test pass was to
// drop the visibility rule under test.
import { assertEquals, assertRejects } from "@std/assert";
import { cell } from "../mod.ts";
import { testMultiClient } from "../src/testing/multi-client-test.ts";

type S = {
  count: number;
  secret: string;
  profile: { name: string; token: string };
};

const vault = cell("mc-vault", {
  state: {
    count: 0,
    secret: "s3cret",
    profile: { name: "a", token: "t" },
  } as S,
  visible: { exclude: ["secret", "profile.token"] },
  methods: {
    bump(s: S) {
      s.count++;
      s.secret = `s${s.count}`;
      s.profile.token = `t${s.count}`;
    },
  },
});

Deno.test("converged(): a cell with field-level visible.exclude converges", async () => {
  await using m = await testMultiClient({ cells: [vault] }, 2);
  await m.converged();
  await m.clients[0]!.dispatch({
    type: "mc-vault:bump",
    payload: { args: [] },
  });
  await m.converged();
  assertEquals(m.clients.length, 2);
  for (const c of m.clients) {
    const mine = c.state<Partial<S>>("mc-vault");
    assertEquals(mine.count, 1, `client ${c.index}`);
    assertEquals("secret" in mine, false, `client ${c.index} got the secret`);
  }
});

Deno.test("converged(): a client that differs in a VISIBLE field still fails", async () => {
  await using m = await testMultiClient({ cells: [vault] }, 1);
  await m.converged();
  const c = m.clients[0]!;
  const real = c.fullState.bind(c);
  // A client stuck on an old `count`, everything else as sent.
  (c as { fullState: () => Record<string, unknown> }).fullState = () => {
    const s = real();
    return { ...s, "mc-vault": { ...(s["mc-vault"] as object), count: 99 } };
  };
  await assertRejects(
    () => m.converged({ timeoutMs: 400 }),
    Error,
    "did not converge",
  );
});

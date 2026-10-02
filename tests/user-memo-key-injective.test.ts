// `userMemoKey` — the key a per-user view, a `ttl` result and a live socket's
// "did this user change?" are all decided on — must be INJECTIVE on what it
// keys, and a record it cannot key must never read as "unchanged".
//
// 1.0.15 narrowed the key to "JSON-faithful" and left three holes:
//
//   • a `bigint` field (an ORM row's `int8` id, `node:sqlite` past Number
//     range) had NO key: `forUser` ran for every client on every broadcast,
//     `ttl`/`"first"` stopped caching;
//   • `_adoptUser` compared only id+role when a key was missing, so revoking
//     `scopes` on such a record (or on one holding a `Set`) left the open
//     socket on the old view, with no frame sent;
//   • JSON has one spelling for several values, and every tag the replacer
//     emitted was a value another record could hold — `undefined` vs
//     `{__aioUndefined:true}`, a `Date` vs its ISO string, `Date(NaN)` vs
//     `null`, a class whose `toJSON` leaves `role` out.
import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { cell } from "../mod.ts";
import { testServer } from "../src/testing/server-test.ts";
import { _resetAuthFails } from "../src/server/server-auth.ts";
import { userMemoKey } from "../src/server/auth-context.ts";
import { createMemoizedUIState } from "../src/server/aio-run-helpers.ts";
import type { AioUser } from "../src/server/aio-types.ts";

const key = (u: unknown) => userMemoKey(u as AioUser);

Deno.test("userMemoKey: a bigint field is keyed, by its value", () => {
  const k = key({ id: 1, org: 1n });
  assert(k !== null, "a record with a bigint field has no key");
  assertEquals(k, key({ org: 1n, id: 1 }), "same record, same key");
  assertNotEquals(k, key({ id: 1, org: 2n }));
  // …and nothing a record can hold spells a bigint.
  for (
    const lookalike of [1, "1", "1n", { __aioBigInt: "1" }, ["1n"], [1n]]
  ) {
    assertNotEquals(k, key({ id: 1, org: lookalike }), String(lookalike));
  }
  // The memo it feeds memoizes again.
  let calls = 0;
  const memo = createMemoizedUIState((s: { n: number }, _u?: AioUser) => {
    calls++;
    return s;
  });
  const st = { n: 1 };
  memo(st, { id: "u", org: 1n } as unknown as AioUser);
  memo(st, { id: "u", org: 1n } as unknown as AioUser);
  assertEquals(calls, 1, "a bigint-bearing user must hit the cache");
});

Deno.test("userMemoKey: no two records a view can tell apart share a key", () => {
  class HidesRole {
    constructor(public id: number, public role: string) {}
    toJSON() {
      return { id: this.id };
    }
  }
  const nonEnum = (role: string) =>
    Object.defineProperty({ id: 1 }, "role", { value: role });
  const holed = (a: unknown[], length: number, x: number) =>
    Object.assign(a, { length, x });
  const pairs: [string, unknown, unknown][] = [
    ["undefined vs its old tag", { x: undefined }, {
      x: { __aioUndefined: true },
    }],
    ["undefined vs absent", { id: 1, x: undefined }, { id: 1 }],
    ["undefined vs the string u", { x: undefined }, { x: "u" }],
    ["Date vs its ISO string", { d: new Date(0) }, {
      d: new Date(0).toISOString(),
    }],
    ["Date vs its ms", { d: new Date(5) }, { d: 5 }],
    ["Date(NaN) vs null", { d: new Date(NaN) }, { d: null }],
    ["Date(NaN) vs NaN", { d: new Date(NaN) }, { d: NaN }],
    ["NaN vs null", { n: NaN }, { n: null }],
    ["-0 vs 0", { n: -0 }, { n: 0 }],
    ["null vs the string null", { n: null }, { n: "null" }],
    ["a non-enumerable field", nonEnum("admin"), nonEnum("viewer")],
    ["nested object vs flat key", { a: { b: 1 } }, { 'a":{"b': 1 }],
    ["array vs object", { a: [1] }, { a: { 0: 1 } }],
    ["undefined vs null", { x: undefined }, { x: null }],
    ["null-prototype vs plain", Object.assign(Object.create(null), { id: 1 }), {
      id: 1,
    }],
    // A hole plus a named property has as many own keys as a dense array.
    ["empty array vs hole + named", { s: [] }, { s: holed([], 1, 1) }],
    ["hole + named, two values", { s: holed([1, , 3], 3, 1) }, {
      s: holed([1, , 3], 3, 2),
    }],
    ["no-user vs the string", undefined, "no-user"],
    ["{} vs no user", {}, undefined],
  ];
  for (const [name, a, b] of pairs) {
    const ka = key(a), kb = key(b);
    assert(ka === null || kb === null || ka !== kb, `${name}: ${ka}`);
  }
  // A `toJSON` is what a class chose to PRINT, not everything a view reads:
  // no key at all (1.0.15 keyed both of these `{"id":1}`).
  assertEquals(key(new HidesRole(1, "admin")), null);
  assertEquals(key({ u: new HidesRole(1, "admin") }), null);
  // Still unkeyable, each for its own reason.
  const cyc: Record<string, unknown> = { id: 1 };
  cyc.self = cyc;
  for (
    const u of [
      { can: () => 1 },
      { s: Symbol("x") },
      { [Symbol("x")]: 1 },
      { m: new Map() },
      { s: new Set() },
      { a: [, 1] },
      { a: holed([1, , 3], 3, 1) },
      { a: Object.assign([1], { x: 1 }) },
      cyc,
      new Proxy({ id: 1 }, {}),
      {
        get x(): number {
          throw new Error("boom");
        },
      },
    ]
  ) {
    assertEquals(key(u), null);
  }
  // …and the keyed domain stays keyed: a Date, a shared (non-cyclic) value.
  const shared = { t: 1 };
  assert(key({ id: 1, when: new Date(0), a: shared, b: shared }) !== null);
  assertEquals(
    key({ id: 1, when: new Date(0) }),
    key({ when: new Date(0), id: 1 }),
  );
});

// ── the live socket ───────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.test("ws sweep: revoking scopes on a record with a bigint / a Set re-sends the view (same id, same role)", async () => {
  _resetAuthFails();
  type S = { n: number; secret: string };
  type U = { scopes?: string[] | Set<string> };
  const has = (u: U | undefined) =>
    Array.isArray(u?.scopes)
      ? u.scopes.includes("vault")
      : !!u?.scopes?.has("vault");
  const vault = cell("scope_revoke", {
    state: { n: 0, secret: "TOPSECRET-9" },
    access: true,
    visible: {
      forUser: (s: S, u?: AioUser) =>
        has(u as U | undefined) ? s : { n: s.n, secret: "" },
    },
    methods: {},
  });
  let revoked = false;
  await using srv = await testServer({
    cells: [vault],
    // A fresh record per call, as a database lookup returns one. id and role
    // never change — only what the record is allowed to see.
    resolveUser: (tok: string) =>
      tok === "key-big"
        ? ({
          id: "u1",
          role: "user",
          org: 7n,
          scopes: revoked ? [] : ["vault"],
        } as unknown as AioUser)
        : tok === "key-set"
        ? ({
          id: "u2",
          role: "user",
          scopes: new Set(revoked ? [] : ["vault"]),
        } as unknown as AioUser)
        : null,
  });
  const open = async (tok: string) => {
    const frames: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws?token=${tok}`);
    ws.onmessage = (e) => frames.push(String(e.data));
    const closed = new Promise<void>((r) => ws.onclose = () => r());
    await new Promise((r, j) => {
      ws.onopen = r;
      ws.onerror = j;
    });
    return { ws, frames, closed };
  };
  const socks = [await open("key-big"), await open("key-set")];
  try {
    await sleep(300);
    for (const s of socks) {
      assert(s.frames.some((f) => f.includes("TOPSECRET-9")), "scoped view");
    }
    revoked = true;
    const marks = socks.map((s) => s.frames.length);
    const resent = (i: number) =>
      socks[i]!.frames.slice(marks[i]).find((f) =>
        f.includes('"t":"state"') && f.includes("scope_revoke")
      );
    const deadline = Date.now() + 8_000;
    while (!(resent(0) && resent(1)) && Date.now() < deadline) await sleep(100);
    for (const [i, what] of ["bigint", "Set"].entries()) {
      const frame = resent(i);
      assert(
        frame,
        `a ${what}-bearing record lost its scope and the socket kept the old view`,
      );
      assert(!frame.includes("TOPSECRET-9"), frame);
    }
  } finally {
    for (const s of socks) s.ws.close();
    await Promise.all(socks.map((s) => s.closed));
    _resetAuthFails();
  }
});

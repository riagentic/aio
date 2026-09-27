// `ttl` and `concurrency: "first"` share ONE answer between calls — and a
// method may answer from `serverUser()`. Keyed by method + arguments only, a
// ttl'd `mine()` computed for Alice was handed to Bob for the whole ttl, and
// Bob's `scan()` adopted Alice's running one. The caller is part of the key.
import { assertEquals } from "@std/assert";
import { cell, serverRequest, serverUser } from "../mod.ts";
import {
  makeServerRequest,
  runWithRequest,
} from "../src/server/auth-context.ts";
import { testCell } from "../src/cell-test.ts";
import { resetMethodPolicy } from "../src/state/method-policy.ts";

// deno-lint-ignore no-explicit-any
type D = any;

let runs = 0;
let gate: Promise<void> = Promise.resolve();
const c = cell("policypercaller", {
  state: { n: 0 },
  ttl: { mine: 60_000 },
  concurrency: { scan: "first" },
  methods: {
    async mine(_s: D) {
      runs++;
      await Promise.resolve();
      return `orders-of-${serverUser()?.id}`;
    },
    async scan(_s: D) {
      await gate;
      return `scan-of-${serverUser()?.id}`;
    },
  },
} as D);

testCell(c, "ttl answers per caller, still caches per caller", async (t: D) => {
  resetMethodPolicy();
  runs = 0;
  assertEquals(
    await t.as({ id: "alice" }, () => t.send.mine()),
    "orders-of-alice",
  );
  assertEquals(
    await t.as({ id: "bob" }, () => t.send.mine()),
    "orders-of-bob",
    "Bob was answered from Alice's ttl entry",
  );
  assertEquals(
    await t.as({ id: "alice" }, () => t.send.mine()),
    "orders-of-alice",
  );
  assertEquals(await t.send.mine(), "orders-of-undefined");
  assertEquals(runs, 3, "the same caller's repeat call is still a ttl hit");
});

testCell(
  c,
  '"first" never adopts another caller\'s running call',
  async (t: D) => {
    resetMethodPolicy();
    let go!: () => void;
    gate = new Promise((r) => go = r);
    const a = t.as({ id: "alice" }, () => t.send.scan());
    const b = t.as({ id: "bob" }, () => t.send.scan());
    go();
    assertEquals(await a, "scan-of-alice");
    assertEquals(await b, "scan-of-bob", "Bob adopted Alice's running scan");
  },
);

// Per caller only when the run READ the caller. Keying every call per caller
// broke the other half of both policies: a ttl as a shared upstream shield
// ran once per user, and `"first"` as a global single-flight ran once per user.
let shieldRuns = 0;
let flightRuns = 0;
let lateRuns = 0;
let flightGate: Promise<void> = Promise.resolve();
const shared = cell("policysharedcaller", {
  state: { n: 0 },
  ttl: { rates: 60_000, late: 60_000 },
  concurrency: { refresh: "first" },
  methods: {
    async rates(_s: D) {
      shieldRuns++;
      await Promise.resolve();
      return { usd: 1 };
    },
    async refresh(_s: D) {
      flightRuns++;
      await flightGate;
      return "fresh";
    },
    // Reads the caller only after an await, from a timer callback.
    async late(_s: D) {
      lateRuns++;
      await new Promise((r) => setTimeout(r, 1));
      return await new Promise((r) =>
        setTimeout(() => r(`late-of-${serverUser()?.id}`), 1)
      );
    },
  },
} as D);

testCell(
  shared,
  "a ttl whose run never reads the caller is shared",
  async (t: D) => {
    resetMethodPolicy();
    shieldRuns = 0;
    await t.as({ id: "alice" }, () => t.send.rates());
    assertEquals(await t.as({ id: "bob" }, () => t.send.rates()), { usd: 1 });
    assertEquals(await t.send.rates(), { usd: 1 });
    assertEquals(shieldRuns, 1, "the shield ran once per caller");
  },
);

testCell(
  shared,
  '"first" whose run never reads the caller is one flight for everyone',
  async (t: D) => {
    resetMethodPolicy();
    flightRuns = 0;
    let go!: () => void;
    flightGate = new Promise((r) => go = r);
    const a = t.as({ id: "alice" }, () => t.send.refresh());
    const b = t.as({ id: "bob" }, () => t.send.refresh());
    go();
    assertEquals([await a, await b], ["fresh", "fresh"]);
    assertEquals(flightRuns, 1, "the single-flight ran once per caller");
  },
);

testCell(
  shared,
  "a caller read after an await still keys the result per caller",
  async (t: D) => {
    resetMethodPolicy();
    lateRuns = 0;
    const late = (id: string) => t.as({ id }, () => t.send.late());
    assertEquals(await late("alice"), "late-of-alice");
    assertEquals(await late("bob"), "late-of-bob");
    assertEquals(await late("alice"), "late-of-alice");
    assertEquals(lateRuns, 2);
  },
);

testCell(
  c,
  '"first": once a run read the caller, callers are keyed apart at once',
  async (t: D) => {
    resetMethodPolicy();
    await t.as({ id: "alice" }, () => t.send.scan()); // learns: reads the caller
    let go!: () => void;
    gate = new Promise((r) => go = r);
    const a1 = t.as({ id: "alice" }, () => t.send.scan());
    const a2 = t.as({ id: "alice" }, () => t.send.scan());
    const b = t.as({ id: "bob" }, () => t.send.scan());
    go();
    assertEquals(
      [await a1, await a2, await b],
      ["scan-of-alice", "scan-of-alice", "scan-of-bob"],
    );
  },
);

// The same leak through `serverRequest()`: a ttl'd method answering from a
// cookie or a header handed one caller's answer to the next. Keyed on exactly
// the facts the run read, by value — not the whole request, which differs on
// every call (and would turn the ttl into a no-op).
let themeRuns = 0;
let langRuns = 0;
let langGate: Promise<void> = Promise.resolve();
const byReq = cell("policyrequestcaller", {
  state: { n: 0 },
  ttl: { theme: 60_000, from: 60_000, jar: 60_000 },
  concurrency: { lang: "first" },
  methods: {
    async theme(_s: D) {
      themeRuns++;
      await Promise.resolve();
      return `theme-${serverRequest()?.cookies.theme}`;
    },
    async lang(_s: D) {
      langRuns++;
      await langGate;
      return `lang-${serverRequest()?.headers.get("Accept-Language")}`;
    },
    async from(_s: D) {
      await Promise.resolve();
      return `from-${serverRequest()?.ip}`;
    },
    async jar(_s: D) {
      await Promise.resolve();
      return Object.keys(serverRequest()?.cookies ?? {}).join(",");
    },
  },
} as D);

const req = (headers: Record<string, string>, ip = "10.0.0.1") =>
  makeServerRequest(new Request("http://x/", { headers }), ip, "http");
const via = <T>(r: ReturnType<typeof req>, fn: () => T): T =>
  runWithRequest(r, fn);

testCell(
  byReq,
  "a ttl that reads a cookie is keyed on that cookie, and only on it",
  async (t: D) => {
    resetMethodPolicy();
    themeRuns = 0;
    const dark = req({ cookie: "theme=dark; sid=1" });
    const light = req({ cookie: "theme=light; sid=2" });
    const dark2 = req({ cookie: "theme=dark; sid=3", "x-trace": "9" });
    assertEquals(await via(dark, () => t.send.theme()), "theme-dark");
    assertEquals(
      await via(light, () => t.send.theme()),
      "theme-light",
      "the light caller was answered from the dark caller's ttl entry",
    );
    assertEquals(await via(dark2, () => t.send.theme()), "theme-dark");
    assertEquals(await t.send.theme(), "theme-undefined");
    assertEquals(themeRuns, 3, "a fact the run never read split the cache");
  },
);

testCell(byReq, "an ip read and a whole-jar read key too", async (t: D) => {
  resetMethodPolicy();
  const at = (ip: string) => via(req({}, ip), () => t.send.from());
  assertEquals(await at("1.1.1.1"), "from-1.1.1.1");
  assertEquals(await at("2.2.2.2"), "from-2.2.2.2");
  const jar = (cookie: string) => via(req({ cookie }), () => t.send.jar());
  assertEquals(await jar("a=1"), "a");
  assertEquals(await jar("b=1"), "b");
});

testCell(
  byReq,
  '"first" never adopts a run that read another caller\'s header',
  async (t: D) => {
    resetMethodPolicy();
    let go!: () => void;
    langGate = new Promise((r) => go = r);
    const en = req({ "accept-language": "en" });
    const de = req({ "accept-language": "de" });
    const a = via(en, () => t.send.lang());
    const b = via(de, () => t.send.lang());
    go();
    assertEquals([await a, await b], ["lang-en", "lang-de"]);
    // Learned: keyed on that header from the start — one flight per language.
    langRuns = 0;
    langGate = new Promise((r) => go = r);
    const en2 = req({ "accept-language": "en", cookie: "x=1" });
    const c1 = via(en, () => t.send.lang());
    const c2 = via(en2, () => t.send.lang());
    const d = via(de, () => t.send.lang());
    go();
    assertEquals(
      [await c1, await c2, await d],
      ["lang-en", "lang-en", "lang-de"],
    );
    assertEquals(langRuns, 2, "one flight per language, not per request");
  },
);

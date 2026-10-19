// The reload carry (tests/air-reload-carries-unsent-calls.test.ts) hands a
// dying page's unsent calls to the next page through sessionStorage. What it
// stores and what the next page accepts are guarded here, one page at a time:
// every "page" is a fresh import of the transport module (same tab, same
// sessionStorage), and none of them opens a socket.
import { assert, assertEquals } from "@std/assert";

const KEY = "aio:reload-carry";
const DROPPED_KEY = "aio:reload-carry-dropped";
const ORIGIN = "http://127.0.0.1:9";
const g = globalThis as Record<string, unknown>;
g.location = {
  protocol: "http:",
  host: "127.0.0.1:9",
  search: "",
  origin: ORIGIN,
  reload: () => {},
};
// No appId here on purpose: an Electron shell has none at import either —
// the carry's app and user come from the server's hello on the connection.
g.__aioConfig = { wire: { omitTrailingUndefined: true } };
const APP = `carry-app@${ORIGIN}`;

const { client } = await import("../src/browser/browser-protocol.ts");
const { rememberPeerHello } = await import(
  "../src/protocol/protocol-version.ts"
);

let page = 0;
/** A new page in this tab: the transport module as the bundle loads it. */
async function newPage(): Promise<void> {
  await import(`../src/browser/browser-air-transport.ts?page=${++page}`);
}

/** console.error/warn lines written while `fn` runs. */
async function said(fn: () => Promise<void> | void): Promise<string[]> {
  const out: string[] = [];
  const { error, warn } = console;
  console.error = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  try {
    await fn();
  } finally {
    Object.assign(console, { error, warn });
  }
  return out;
}

const pagehide = (persisted = false) => {
  const ev = new Event("pagehide");
  Object.defineProperty(ev, "persisted", { value: persisted });
  globalThis.dispatchEvent(ev);
};
const stored = () => JSON.parse(sessionStorage.getItem(KEY) ?? "null");

Deno.test("a corrupt or stale carry is refused loudly at load — never a crash, never sent", async () => {
  const fresh = { app: APP, at: Date.now() };
  const cases: [string, string][] = [
    ["{}", "unreadable"],
    ["[null]", "unreadable"],
    ["not json", "unreadable"],
    [
      JSON.stringify({ ...fresh, calls: [null, { a: { type: 1 } }] }),
      "malformed",
    ],
    [
      JSON.stringify({
        app: APP,
        at: Date.now() - 120_000,
        calls: [{ a: { type: "c:m" } }],
      }),
      "older than",
    ],
  ];
  for (const [raw, why] of cases) {
    sessionStorage.clear();
    sessionStorage.setItem(KEY, raw);
    const lines = await said(newPage);
    assert(
      lines.some((l) => l.includes("DROPPED") && l.includes(why)),
      `${raw}: expected a loud refusal naming "${why}", got ${
        JSON.stringify(lines)
      }`,
    );
    assertEquals(sessionStorage.getItem(KEY), null, "consumed either way");
  }
});

Deno.test("a carry the previous page could not store is reported by the next page", async () => {
  sessionStorage.clear();
  await newPage();
  (g.__aioReloadWhenDrained as () => void)(); // nothing owed: reloads at once
  client.send({ type: "c:m", payload: { args: [1] } });
  client.send({ type: "c:n", payload: { args: [2] } });
  // On the prototype: a Storage takes an assigned property as an ITEM.
  const set = Storage.prototype.setItem;
  Storage.prototype.setItem = function (this: Storage, k: string, v: string) {
    if (k === KEY) throw new DOMException("quota", "QuotaExceededError");
    set.call(this, k, v);
  };
  try {
    pagehide();
  } finally {
    Storage.prototype.setItem = set;
  }
  assertEquals(sessionStorage.getItem(KEY), null);
  assert(sessionStorage.getItem(DROPPED_KEY), "a small loss marker survives");
  const lines = await said(newPage);
  assert(
    lines.some((l) =>
      l.includes("DROPPED") && l.includes("2") && l.includes("c:m")
    ),
    `next page names the loss: ${JSON.stringify(lines)}`,
  );
  assertEquals(sessionStorage.getItem(DROPPED_KEY), null);
});

Deno.test("the carry holds the wire shape and who made the calls — no cid; bfcache carries nothing", async () => {
  sessionStorage.clear();
  await newPage();
  (g.__aioReloadWhenDrained as () => void)();
  client.send({
    type: "c:m",
    payload: { args: [1, undefined] },
    cid: "old-caller",
  } as { type: string });
  // A bfcache entry keeps the page's memory — nothing is carried, and the
  // queue is still there when it comes back.
  pagehide(true);
  assertEquals(sessionStorage.getItem(KEY), null, "bfcache: not carried");
  // Who and which app: what the server's hello said on this page's
  // connection — no useUser() needed (an auth app that never called it).
  rememberPeerHello({ v: 3, min: 3, appId: "carry-app", user: "alice" });
  pagehide();
  const c = stored();
  assertEquals(c.app, APP);
  assertEquals(c.user, "alice", "the next page sends them only as alice");
  assertEquals(typeof c.at, "number");
  assertEquals(c.calls.length, 1);
  assertEquals(c.calls[0].a.type, "c:m");
  assertEquals(c.calls[0].a.cid, undefined, "the old caller is gone");
  assertEquals(
    c.calls[0].a.payload.args,
    [1],
    "wire.omitTrailingUndefined applied as the old page would have sent it",
  );
  sessionStorage.clear();
});

Deno.test("a reload cancelled long ago does not turn a later tab close into a carry", async () => {
  sessionStorage.clear();
  await newPage();
  const realNow = Date.now;
  (g.__aioReloadWhenDrained as () => void)();
  client.send({ type: "c:m", payload: { args: [1] } });
  Date.now = () => realNow() + 120_000; // the user stayed after cancelling
  try {
    pagehide();
  } finally {
    Date.now = realNow;
  }
  assertEquals(sessionStorage.getItem(KEY), null);
});

Deno.test("a stub storage (the build's graph evaluator) is no carry and no false alarm", async () => {
  const real = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage")!;
  // graph-eval's stub: every read is another stub object, never a string.
  const stub = { getItem: () => ({}), removeItem: () => {} };
  Object.defineProperty(globalThis, "sessionStorage", {
    configurable: true,
    get: () => stub,
  });
  try {
    const lines = await said(newPage);
    assertEquals(lines.filter((l) => l.includes("DROPPED")), []);
  } finally {
    Object.defineProperty(globalThis, "sessionStorage", real);
  }
});

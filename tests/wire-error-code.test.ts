// A failed call must say WHY in a way a program can read.
//
// The ack frame carried one field for a failure — `error`, a sentence — and
// `docs/basics/semver-policy.md` says in as many words that message wording is
// NOT public API. So an app that had to tell "the gate refused me" (sign the
// user in) from "the server took it and changed nothing" (a stale client;
// refetch) from "my own method threw" (a bug) had exactly one instrument: a
// regex over text the framework had promised itself the right to reword. The
// moment beta shipped, that wording would have become the API by accident.
//
// The wire now carries a second field, `code`, exactly the way `ProtoHello.app`
// was added: optional, ignorable, absent from older peers. These tests pin the
// ROUND TRIP — server classifies → wire → the caller's rejection — and every
// assertion here is deliberately made WITHOUT looking at the message text,
// because that is the whole property. (audit a16/1, a16/10)
import { assert, assertEquals } from "@std/assert";
import {
  dec,
  enc,
  errorCode,
  errorFields,
  wireError,
} from "../src/protocol/envelope.ts";
import { freePort } from "../src/testing/server-test.ts";
import { createAioError } from "../src/diagnostics/error.ts";

type Ack = {
  cid: string;
  ok: boolean;
  error?: string;
  code?: string;
  value?: unknown;
};

const settle = () => new Promise((r) => setTimeout(r, 300));

// ── The two helpers, in isolation ───────────────────────────────────────────

Deno.test("wire error: errorFields sends the message, never String(err)", () => {
  // `String(new Error("kaboom"))` is "Error: kaboom", and the client wraps the
  // text in an Error again — so the prefix accumulated one per hop.
  assertEquals(errorFields(new Error("kaboom")), { error: "kaboom" });
  assertEquals(errorFields("plain"), { error: "plain" });
});

Deno.test("wire error: errorFields carries an AioError's code", () => {
  const f = errorFields(createAioError("ACCESS_DENIED", "nope", {}));
  assertEquals(f, { error: "nope", code: "ACCESS_DENIED" });
  // …and an app's own throw has none to carry.
  assertEquals(errorFields(new Error("nope")).code, undefined);
});

Deno.test("wire error: wireError → errorCode is the round trip", () => {
  const e = wireError({ error: "nope", code: "ACCESS_DENIED" }, "fallback");
  assertEquals(e.message, "nope");
  assertEquals(errorCode(e), "ACCESS_DENIED");
  // No code on the wire → no code on the rejection. Never invented.
  assertEquals(errorCode(wireError({ error: "boom" }, "fallback")), undefined);
  assertEquals(errorCode(new Error("boom")), undefined);
  assertEquals(errorCode(undefined), undefined);
  // A code a NEWER server names and this build has never heard of is passed
  // through verbatim — erasing it would be worse than not knowing it.
  assertEquals(
    errorCode(wireError({ error: "x", code: "FROM_THE_FUTURE" }, "f")),
    "FROM_THE_FUTURE",
  );
  // An AioError thrown locally reads through the SAME function.
  assertEquals(
    errorCode(createAioError("ACTION_REFUSED", "x", {})),
    "ACTION_REFUSED",
  );
});

// ── The round trip, over a real socket ──────────────────────────────────────

let _ns = 0;

async function rig() {
  const { aio, cell, serverFns } = await import("../mod.ts");
  const vault = cell("vault", {
    state: { n: 0 },
    visible: "all",
    // Anonymous clients are refused: this is the "public read, server-only
    // write" shape the framework encourages, so a denial is an EVERYDAY answer
    // an app must branch on — not an exceptional one.
    access: "admin",
    methods: {
      bump(s: { n: number }) {
        s.n += 1;
      },
    },
  });
  const open = cell("open", {
    state: { n: 0 },
    visible: "all",
    methods: {
      bump(s: { n: number }) {
        s.n += 1;
      },
      boom(_s: { n: number }) {
        // The app's OWN failure. It must be distinguishable from both of the
        // framework's refusals, and it must carry no code — inventing one
        // would put an app bug in the same bucket as a policy decision.
        throw new Error("kaboom");
      },
    },
  });
  // A fresh namespace per rig — `serverFns` refuses a duplicate registration
  // (namespaces are unique per process, and the tests share one).
  const ns = `secrets${++_ns}`;
  serverFns(ns, { peek: () => "s3cret" }, { access: "admin" });
  const port = freePort();
  const app = await aio.run({
    cells: [vault, open],
    appId: "test-wire-error-code",
    client: "server-only",
    persist: false,
    libraryMode: true,
    port,
    baseDir: await Deno.makeTempDir(),
  });
  const acks: Ack[] = [];
  const sfnrs: Ack[] = [];
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const s = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const t = setTimeout(() => reject(new Error("ws timeout")), 5000);
    s.onmessage = (e) => {
      const f = dec(String(e.data)) as { t?: string; d?: unknown } | null;
      if (f?.t === "ack") acks.push(f.d as Ack);
      if (f?.t === "sfnr") sfnrs.push(f.d as Ack);
      clearTimeout(t);
      resolve(s);
    };
    s.onerror = () => {
      clearTimeout(t);
      reject(new Error("ws error"));
    };
  });
  return {
    ws,
    ns,
    ackFor: (cid: string) => acks.find((a) => a.cid === cid),
    sfnrFor: (cid: string) => sfnrs.find((a) => a.cid === cid),
    close: async () => {
      ws.close();
      await app.close();
    },
  };
}

Deno.test("wire error: a denial, a refusal and an app throw are three ANSWERS", async () => {
  const r = await rig();
  try {
    // CONTROL — an allowed call really is acked ok.
    r.ws.send(enc("action", { type: "open:bump", payload: {}, cid: "c-ok" }));
    // 1. The access gate refuses an anonymous caller.
    r.ws.send(
      enc("action", { type: "vault:bump", payload: {}, cid: "c-deny" }),
    );
    // 2. The server takes the action and applies nothing (a method the cell
    //    does not have — the stale-client-after-a-rename case).
    r.ws.send(enc("action", { type: "open:gone", payload: {}, cid: "c-ref" }));
    // 3. The app's own method throws.
    r.ws.send(enc("action", { type: "open:boom", payload: {}, cid: "c-app" }));
    await settle();

    const ok = r.ackFor("c-ok");
    const deny = r.ackFor("c-deny");
    const refused = r.ackFor("c-ref");
    const app = r.ackFor("c-app");
    assert(ok && deny && refused && app, "every call must be answered");

    assertEquals(ok.ok, true);
    assertEquals(ok.code, undefined);

    // THE PROPERTY. Three distinct machine-readable answers, and not one of
    // these assertions looks at a message.
    assertEquals(deny.ok, false);
    assertEquals(deny.code, "ACCESS_DENIED");
    assertEquals(refused.ok, false);
    assertEquals(refused.code, "ACTION_REFUSED");
    assertEquals(app.ok, false);
    // The app's own throw is classified too — as what it IS, a reducer that
    // threw. What matters is that it is NEITHER refusal: a bug in the app must
    // never arrive wearing the framework's policy codes, or a `catch` that
    // retries a denial would retry a crash forever.
    assertEquals(app.code, "REDUCE_ERROR");
    assertEquals(
      new Set([deny.code, refused.code, app.code]).size,
      3,
      "the three failures must be distinguishable by code alone",
    );

    // And the text arrives ONCE, as the METHOD's own words. `String(err)` on
    // the server prepended "Error: " and the client wrapped the result in an
    // Error again, so the prefix accumulated per hop.
    //
    // The framework's context sentence — `Cell 'open' method 'boom' threw:` —
    // is gone from the message as of alpha76: an app shows `e.message` to a
    // user (`examples/contacts` does exactly that on a validation refusal), so
    // the framework talking about itself ended up in the UI. The context is
    // now data on the error (`err.cell`, `err.method`) and prose in the log.
    assertEquals(app.error, "kaboom");
    assert(!app.error!.includes("Error: "), "no accumulated Error: prefix");
  } finally {
    await r.close();
  }
});

Deno.test("wire error: a serverFn denial answers with the SAME code", async () => {
  const r = await rig();
  try {
    r.ws.send(
      enc("sfn", { cid: "s-deny", ns: r.ns, name: "peek", args: [] }),
    );
    await settle();
    const deny = r.sfnrFor("s-deny");
    assert(deny, "the sfn call must be answered");
    assertEquals(deny.ok, false);
    // The two reply channels a call can come back on must answer "why did this
    // fail?" the same way, or an app ends up carrying two error vocabularies.
    assertEquals(deny.code, "ACCESS_DENIED");
  } finally {
    await r.close();
  }
});

Deno.test("wire error: the CALLER's rejection carries the code", async () => {
  // The frames above prove the server's half. This is the app's half: what a
  // `catch` actually receives, read the way an app would read it.
  const r = await rig();
  try {
    r.ws.send(enc("action", { type: "vault:bump", payload: {}, cid: "c-x" }));
    await settle();
    const frame = r.ackFor("c-x")!;
    const rejection = wireError(frame, "the server refused the action");
    assertEquals(errorCode(rejection), "ACCESS_DENIED");
    assert(
      errorCode(rejection) !== errorCode(new Error(rejection.message)),
      "reconstructing the error from its TEXT alone must lose the code — " +
        "that is exactly the instrument this replaces",
    );
  } finally {
    await r.close();
  }
});

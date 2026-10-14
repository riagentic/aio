// `testUI` puts a rejection, a `serverFn` call and `useAio().send` across the
// wire only when asked — `wire: { strict: true }`, or `AIO_TEST_WIRE=strict`
// for a whole run.
//
// All three are what a real client gets, and the harness not doing them is how
// a UI test goes green over a call the app answers differently
// (tests/wire-harness-differential.test.tsx compares the two over a socket).
// But a test written against 1.0.19 saw the old harness: the server's own
// error object, the function itself, a `send` that never ran. Making the wire
// the default turns such a test red on an upgrade, and the only repair is a
// hand edit — so the default is what 1.0.19 did, to the letter (the first
// test below runs unchanged, minus the lines about what is said, against a
// `git archive v1.0.19-beta` tree: same results), and the run is TOLD, once
// per kind, what a client would have seen.
//
// New apps get the wire: `am create` writes `AIO_TEST_WIRE=strict` into the
// `test` task (tests/am-onboard.test.ts), and aio's own suite sets it
// (tests/preload-ffi.ts, scripts/test-shards.ts).
import {
  assert,
  assertEquals,
  assertRejects,
  assertStrictEquals,
} from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { serverFn, serverFns } from "../src/server/server-fns.ts";
import { useAio } from "../src/browser-air.ts";

class HttpError extends Error {
  status = 422;
}
const thrown = new HttpError("unprocessable");

const optin = cell("wire-optin", {
  state: { log: [] as string[] },
  methods: {
    take(s: { log: string[] }, v: string) {
      s.log.push(v);
    },
    async save() {
      await Promise.resolve();
      throw thrown;
    },
  },
});

let lastArg: unknown;
const apiDef = serverFns("wire-optin-api", {
  keep: (v: unknown) => {
    lastArg = v;
    return "kept";
  },
  fail: () => {
    throw thrown;
  },
});
serverFns("wire-optin-admin", { secret: () => "s3" }, { access: "admin" });
const api = serverFn<typeof apiDef>("wire-optin-api");
const admin = serverFn<{ secret: () => string }>("wire-optin-admin");

function Sender() {
  const { send } = useAio();
  return (
    <div>
      <button
        class="button"
        onClick={() =>
          send({ type: "wire-optin:take", payload: { args: ["milk"] } })}
      >
        Known
      </button>
      <button class="button" onClick={() => send({ type: "wire-optin:nope" })}>
        Unknown
      </button>
    </div>
  );
}

/** Run `fn` with `AIO_TEST_WIRE` set to `v` (`undefined`: unset). */
async function withEnv(v: string | undefined, fn: () => Promise<void>) {
  const had = Deno.env.get("AIO_TEST_WIRE");
  if (v === undefined) Deno.env.delete("AIO_TEST_WIRE");
  else Deno.env.set("AIO_TEST_WIRE", v);
  try {
    await fn();
  } finally {
    if (had === undefined) Deno.env.delete("AIO_TEST_WIRE");
    else Deno.env.set("AIO_TEST_WIRE", had);
  }
}

/** What `fn` wrote to stderr that is the harness's wire note — and that it
 *  went nowhere near `console`, which a test may be counting. */
async function wireNotes(fn: () => Promise<void>): Promise<string[]> {
  const stderr = Deno.stderr as { writeSync(p: Uint8Array): number };
  const real = stderr.writeSync;
  const consoles = { warn: console.warn, error: console.error };
  const said: string[] = [];
  stderr.writeSync = (p) => {
    const text = new TextDecoder().decode(p);
    if (!text.includes("wire: { strict: true }")) return real.call(stderr, p);
    said.push(text.trimEnd());
    return p.length;
  };
  console.warn = console.error = (...a: unknown[]) => {
    const line = a.map(String).join(" ");
    assert(!line.includes("wire: { strict: true }"), `on console: ${line}`);
  };
  try {
    await fn();
  } finally {
    stderr.writeSync = real;
    Object.assign(console, consoles);
  }
  return said;
}

/** What 1.0.19's harness did with the three, asserted. */
async function theHarnessOf1_0_19() {
  const ui = await testUI(Sender, { cells: [optin] });
  try {
    // (a) a rejected call: the server's own object — its class, its fields.
    const e = await assertRejects(() => optin.save());
    assertStrictEquals(e, thrown);
    assert(e instanceof HttpError && e.status === 422);

    // (b) serverFn from the UI: the function itself — the argument by
    // reference, no access rule (this mount is anonymous), the error as thrown.
    const rich = { at: new Date(0), n: 1n };
    assertEquals(await api.keep(rich), "kept");
    assertStrictEquals(lastArg, rich);
    assertEquals(await admin.secret(), "s3");
    assertStrictEquals(await assertRejects(() => api.fail()), thrown);

    // (c) useAio().send: nothing runs, and nothing fails — known type or not.
    ui.KnownButton.click();
    ui.UnknownButton.click();
    await ui.settle();
    assertEquals([...optin.log], []);
  } finally {
    await ui.dispose();
  }
}

Deno.test("testUI wire, by default: a rejection, serverFn and useAio().send behave as on 1.0.19 — and the run is told once per kind what a client gets", async () => {
  await withEnv(undefined, async () => {
    const said = await wireNotes(theHarnessOf1_0_19);
    assertEquals(said.length, 3, said.join("\n"));
    const [rejection, sfn, send] = [
      "wire-optin.save() rejected",
      'serverFn("wire-optin-api").keep()',
      'useAio().send({ type: "wire-optin:take" }) did NOT run',
    ].map((part) => said.find((l) => l.includes(part)));
    assert(rejection?.includes("class HttpError, .status"), said.join("\n"));
    assert(sfn?.includes("access rule"), said.join("\n"));
    assert(send, said.join("\n"));
    for (const l of said) assert(l.includes("AIO_TEST_WIRE=strict"), l);
    // Once per run: the same test again says nothing, and still passes.
    assertEquals(await wireNotes(theHarnessOf1_0_19), []);
  });
});

/** The same three over the wire. */
async function strictHarness(opts: { wire?: { strict?: boolean } } = {}) {
  const ui = await testUI(Sender, { cells: [optin], ...opts });
  try {
    const e = await assertRejects(() => optin.save(), Error);
    assert(!(e instanceof HttpError), "the class crossed the wire");
    assertEquals(e.message, "unprocessable");

    await assertRejects(() => api.keep({ at: new Date(0) }), Error, "Date");
    await assertRejects(() => admin.secret(), Error, "[server] ");
    const f = await assertRejects(() => api.fail(), Error, "[server] ");
    assert(!(f instanceof HttpError));

    const before = optin.log.length;
    ui.KnownButton.click();
    await ui.settle();
    assertEquals(optin.log.length, before + 1, "send ran the method");
    ui.UnknownButton.click();
    await assertRejects(() => ui.settle(), Error, "no method of a cell");
  } finally {
    await ui.dispose();
  }
}

Deno.test("testUI wire: `wire: { strict: true }` or AIO_TEST_WIRE=strict crosses it — the option decides over the variable, and a strict run is told nothing", async () => {
  assertEquals(
    await wireNotes(async () => {
      await withEnv(undefined, () => strictHarness({ wire: { strict: true } }));
      await withEnv("strict", () => strictHarness());
    }),
    [],
  );
  // The option wins either way.
  await withEnv("strict", async () => {
    const ui = await testUI(Sender, {
      cells: [optin],
      wire: { strict: false },
    });
    try {
      assertStrictEquals(await assertRejects(() => optin.save()), thrown);
    } finally {
      await ui.dispose();
    }
  });
});

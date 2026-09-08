// A short call has to reach the person who made it.
//
// `am dispatch todo:add` for `add(s, text: string)` ran `add(s, undefined)` and
// put a row whose declared `text` is simply gone into state and onto the
// screen, under `{"ok":true}` (50audits §7). The no-payload shape is refused
// now — but a call that supplies an `args` array too SHORT still runs, and it
// must, because `fn.length` stops at the first defaulted parameter: a method
// that fills its own in (`reset(s, to) { to ??= 0 }`) reports as needing an
// argument it does not, and refusing would break a call that works today.
//
// So the framework warns instead — and warned into the SERVER LOG, while this
// route answered a clean `ok` to the operator. An agent driving a live app
// never reads that log. The fact was known in the one place it did not reach.
import { assert, assertEquals } from "@std/assert";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";

type S = { rows: { a: string; b: string }[] };
const box = cell("shortcall", {
  state: { rows: [] as { a: string; b: string }[] },
  methods: {
    addTwo(s: S, a: string, b: string) {
      s.rows.push({ a, b });
    },
    // The shape that makes an exact refusal impossible: `fn.length` says 1,
    // the method needs 0.
    reset(s: S, to?: number) {
      to ??= 0;
      s.rows.length = to;
    },
  },
  // deno-lint-ignore no-explicit-any
} as any);

async function dispatch(
  port: number,
  type: string,
  args: unknown[],
): Promise<Record<string, unknown>> {
  const r = await fetch(`http://127.0.0.1:${port}/__aio/trojan/dispatch`, {
    method: "POST",
    headers: { "x-aio": "1", "content-type": "application/json" },
    body: JSON.stringify({ type, payload: { args } }),
  });
  return await r.json() as Record<string, unknown>;
}

Deno.test("dispatch: a SHORT call still runs, and the reply says so", async () => {
  const port = freePort();
  const app = await aio.run({
    cells: [box],
    appId: `shortcall-${Deno.pid}`,
    client: "server-only",
    libraryMode: true,
    singleton: false,
    dbPath: ":memory:",
    port,
    // deno-lint-ignore no-explicit-any
  } as any);
  try {
    const short = await dispatch(port, "shortcall:addTwo", ["one"]);
    assertEquals(short.ok, true, "it RAN — this is not a refusal");
    assert(
      typeof short.short === "string",
      `the reply must carry the fact the log already had: ${
        JSON.stringify(short)
      }`,
    );
    const msg = short.short as string;
    assert(msg.includes("2 argument"), msg);
    assert(msg.includes("passed 1"), msg);
    assert(
      msg.includes("= 0") || msg.includes("SIGNATURE"),
      `it must name the spelling that removes the ambiguity for good: ${msg}`,
    );

    // …and a COMPLETE call says nothing. A warning on every dispatch is how a
    // real one gets scrolled past.
    const full = await dispatch(port, "shortcall:addTwo", ["one", "two"]);
    assertEquals(full.ok, true);
    assertEquals("short" in full, false, JSON.stringify(full));

    // The body-defaulter: `fn.length` says 1, the method needs none. It still
    // reports — the framework cannot tell it apart, and says which spelling
    // would let it — but it is NOT refused, which is the whole reason this is
    // a reply field and not a 400.
    const defaulted = await dispatch(port, "shortcall:reset", []);
    assertEquals(defaulted.ok, true, "a body-defaulter must keep working");
  } finally {
    await app.close();
  }
});

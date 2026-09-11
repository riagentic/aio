// A failing UI assertion should say how it GOT there.
//
// "dump the AIR tree and the last N dispatches, and name the file in the
// error" (trading-app report §9.5). A failure prints what the surface looks like NOW; what
// it can never print is the sequence, and reconstructing that from a test body
// is exactly the work this removes.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { h } from "../src/air/vdom.ts";

// deno-lint-ignore no-explicit-any
type D = any;

const counter = cell("tracecell", {
  state: { n: 0, note: "" },
  methods: {
    bump(s: { n: number }, by: number) {
      s.n += by;
    },
    setNote(s: { note: string }, t: string) {
      s.note = t;
    },
  },
} as D);

const App = () =>
  h("div", { class: "root" }, h("button", { type: "button" }, "Save"));

/** Provoke a miss and hand back its message. */
async function missMessage(): Promise<string> {
  await using ui = await testUI(App, { cells: [counter] } as D);
  await ui.settle();
  await (counter as D).bump(3);
  await (counter as D).setNote("a rather long note that will be summarised");
  await ui.settle();
  try {
    (ui as D).NoSuchButton.click();
    await ui.settle();
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  throw new Error("the miss did not throw");
}

Deno.test("a miss names a trace file, and the file holds the sequence", async () => {
  const msg = await missMessage();
  const m = /trace: (\S+\.json)/.exec(msg);
  assert(m, `the error must NAME the file: ${msg}`);
  const trace = JSON.parse(await Deno.readTextFile(m[1]!)) as {
    calls: string[];
    surface: unknown;
    html: string;
    state: Record<string, unknown>;
  };
  try {
    // The half a failing assertion can never print.
    assertEquals(trace.calls.length, 2, JSON.stringify(trace.calls));
    assertStringIncludes(trace.calls[0]!, "tracecell.bump(3)");
    assertStringIncludes(trace.calls[1]!, "tracecell.setNote(");
    // Arguments are SUMMARISED — a trace that inlines a 2 MB payload is one
    // nobody opens, and a secret in a payload does not belong in a file the
    // test leaves behind.
    assert(
      trace.calls[1]!.length < 60,
      `a long argument must be summarised: ${trace.calls[1]}`,
    );
    assert(trace.calls[1]!.includes("…"), "…and marked as cut");

    // And the state it got to.
    assertStringIncludes(trace.html, "Save");
    assertEquals((trace.state.tracecell as D).n, 3);
    assert(trace.surface, "the surface must be in it");
  } finally {
    await Deno.remove(m[1]!).catch(() => {});
  }
});

Deno.test("the trace never replaces the assertion's own error", async () => {
  // The failure is the point; the trace is a convenience. A read-only cwd or a
  // full disk must not turn a failed assertion into a filesystem error.
  const msg = await missMessage();
  assertStringIncludes(msg, "NoSuchButton");
  assertStringIncludes(msg, "available:");
  const m = /trace: (\S+\.json)/.exec(msg);
  if (m) await Deno.remove(m[1]!).catch(() => {});
});

Deno.test("the writer is synchronous — an async write would outlive the test", async () => {
  // `fail()` throws, so there is nothing to await a write. An async one would
  // be reported by the leak sanitizers against whichever test ran next, which
  // is the exact class this repo has spent two suite runs on.
  const src = await Deno.readTextFile(
    new URL("../src/testing/ui-test.ts", import.meta.url),
  );
  const fn = src.slice(src.indexOf("function writeTrace("));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assertStringIncludes(body, "writeTextFileSync");
  assertEquals(
    /await |\.then\(/.test(body),
    false,
    "a trace write must not be asynchronous",
  );
});

Deno.test("the trace directory is BOUNDED — a failing suite cannot fill a disk", async () => {
  // An unbounded artifact directory is one nobody ever cleans: it just grows
  // until someone notices the disk. The newest are the ones anyone reads.
  const dir = `${Deno.cwd()}/.aio/traces`;
  await Deno.mkdir(dir, { recursive: true });
  // Plant more than the cap, with names that sort oldest-first like real ones.
  for (let i = 0; i < 30; i++) {
    await Deno.writeTextFile(
      `${dir}/ui-000000000${i.toString().padStart(4, "0")}-old.json`,
      "{}",
    );
  }
  const msg = await missMessage();
  const m = /trace: (\S+\.json)/.exec(msg);
  assert(m, msg);
  const left = [...Deno.readDirSync(dir)].filter((e) =>
    e.name.endsWith(".json")
  );
  assert(
    left.length <= 20,
    `${left.length} traces left — the cap is 20`,
  );
  // …and the one just written is still there, which is the whole point of
  // pruning the OLDEST.
  assert(
    left.some((e) => m[1]!.endsWith(e.name)),
    "pruning removed the trace it had just named",
  );
  await Deno.remove(dir, { recursive: true }).catch(() => {});
});

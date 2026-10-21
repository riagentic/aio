// Every harness refusal carries a stable `code`, so an agent or a CI gate
// branches on `errorCode(e)` instead of matching prose in a 73-failure wall
// (feedback cc §5). DEAD_BOOT was the first (tests/dead-boot-code.test.ts).
// Additive: the prose is unchanged, the code is a new property.
//
// Two halves: a few refusals RUN, read with `errorCode`; and the source scan
// that keeps the documented table (docs/debugging/errors.md) and the emitted
// set the same, both ways.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  isDeliberateRejection,
  withRefusalCode,
} from "../src/state/method-rejection.ts";
import { fromFileUrl } from "@std/path";
import { cell, errorCode } from "../mod.ts";
import { crashWorker, testCell, testServer, testUI } from "../src/cell-test.ts";
import { h } from "../src/air.ts";

const ROOT = fromFileUrl(new URL("../", import.meta.url));

async function codeOf(fn: () => unknown): Promise<string | undefined> {
  try {
    await fn();
  } catch (e) {
    return errorCode(e);
  }
  throw new Error("expected a refusal, and the call went through");
}

const plain = cell("refusalCodesPlain", {
  state: { n: 0 },
  methods: {
    bump(s: { n: number }) {
      s.n++;
    },
  },
});
const unbooted = cell("refusalCodesUnbooted", {
  state: { n: 0 },
  methods: {},
});

Deno.test("harness refusal codes: testServer option, crashWorker", async () => {
  assertEquals(
    await codeOf(() =>
      testServer({ cells: [], workers: "bogus" as unknown as "real" })
    ),
    "HARNESS_OPTION",
  );
  assertEquals(
    await codeOf(() => crashWorker(plain as never)),
    "NOT_CRASHABLE",
  );
});

testCell(
  plain,
  "harness refusal codes: t.init with an unknown key",
  async (t) => {
    assertEquals(
      await codeOf(() => t.init({ nope: 1 } as never)),
      "UNKNOWN_STATE_KEY",
    );
  },
);

Deno.test("harness refusal codes: testUI — dialog, relative fetch, lookup, unbooted cell", async () => {
  await using ui = await testUI(() => h("p", null, "hi"), { cells: [plain] });
  assertEquals(
    await codeOf(() =>
      (globalThis as unknown as { alert(m: string): void }).alert("x")
    ),
    "NATIVE_DIALOG",
  );
  assertEquals(await codeOf(() => fetch("/x")), "RELATIVE_FETCH");
  assertEquals(
    await codeOf(() => (ui as unknown as Record<string, unknown>).NoSuchButton),
    "UI_LOOKUP",
  );
  assertEquals(
    await codeOf(() => ui.expectCell(unbooted as never, () => true)),
    "CELL_NOT_BOOTED",
  );
});

// ── The table and the code agree ────────────────────────────────────────

/** `DEAD_BOOT`'s `Object.assign(new Error(…), { code: "X" })` (1.0.21), and
 *  the tail of every `withRefusalCode(new Error(…), "X")` — the first
 *  `, "X")` after the call opens — however fmt wraps them. */
const ASSIGNED = /\{\s*code: "([A-Z][A-Z_]+)",?\s*\},?\s*\)/g;
const TAIL = /,\s*"([A-Z][A-Z_]+)",?\s*\)/;
function sites(text: string): string[] {
  const out = [...text.matchAll(ASSIGNED)].map((m) => m[1]!);
  const calls = text.split("withRefusalCode(").slice(1);
  for (const c of calls) {
    if (c.startsWith("e: E")) continue; // the declaration
    const m = TAIL.exec(c);
    assert(m, `a withRefusalCode call with no literal code: ${c.slice(0, 80)}`);
    out.push(m[1]!);
  }
  return out;
}

async function emitted(): Promise<Set<string>> {
  const files = [
    "src/standalone-air.ts",
    "src/state/cell-catalog.ts",
    "src/server/cell-worker-host.ts",
    ...[...Deno.readDirSync(`${ROOT}src/testing`)]
      .filter((e) => e.name.endsWith(".ts"))
      .map((e) => `src/testing/${e.name}`),
  ];
  const out = new Set<string>();
  for (const f of files) {
    const text = await Deno.readTextFile(`${ROOT}${f}`);
    for (const c of sites(text)) out.add(c);
  }
  return out;
}

Deno.test("harness refusal codes: docs/debugging/errors.md lists exactly the codes the harness emits", async () => {
  const doc = await Deno.readTextFile(`${ROOT}docs/debugging/errors.md`);
  const at = doc.indexOf("### Test-harness refusals");
  assert(at > 0, "the docs section is gone");
  const section = doc.slice(at, doc.indexOf("\n### ", at + 1));
  const listed = [...section.matchAll(/^\| `([A-Z][A-Z_]+)`/gm)].map((m) =>
    m[1]!
  );
  assertEquals(new Set(listed).size, listed.length, "a code listed twice");
  const codes = await emitted();
  assert(codes.size >= 20, `the source scan broke: ${[...codes]}`);
  assertEquals([...listed].sort(), [...codes].sort());
});

// ── The code is ADDITIVE: classification is unchanged ───────────────────
//
// `isDeliberateRejection` reads any `code` as "aio's own error, a bug". These
// refusals had no code until 1.0.23, so each was classified by its class and
// message — and `withRefusalCode` keeps it that way. On 79155b6d2 the testUI
// `alert()` refusal was a plain `new Error("testUI: alert(…) — …")`: thrown
// inside a method, a DELIBERATE rejection (the one info line), never the
// error box. It still is.

Deno.test("harness refusal codes: withRefusalCode never changes isDeliberateRejection", () => {
  // Each refusal with its classification on 79155b6d2 (before any code),
  // bare and inside a cause chain — with the code added, the same verdict.
  const cases: [() => Error, boolean][] = [
    [() => new Error('testUI: alert("x") — a native dialog'), true],
    [() => new Error('[aio] cell "w" runs in a worker isolate'), false],
    [() => new TypeError('testUI: fetch("/x") is a relative URL'), false],
    [() => new Error('crashWorker: cell "c" is not a worker cell'), true],
  ];
  const wrapped = (inner: Error) =>
    Object.assign(new Error("m"), { cause: inner });
  for (const [make, was] of cases) {
    assertEquals(isDeliberateRejection(make()), was);
    assertEquals(isDeliberateRejection(withRefusalCode(make(), "X_CODE")), was);
    assertEquals(isDeliberateRejection(wrapped(make())), was);
    assertEquals(
      isDeliberateRejection(wrapped(withRefusalCode(make(), "X_CODE"))),
      was,
    );
  }
  // Any OTHER code still reads as a bug, as before.
  assertEquals(
    isDeliberateRejection(Object.assign(new Error("x"), { code: "E_LOCKED" })),
    false,
  );
});

const dialogs = cell("refusalCodesDialog", {
  state: { n: 0 },
  methods: {
    ask(_s: { n: number }) {
      (globalThis as unknown as { alert(m: string): void }).alert("sure?");
    },
  },
});

Deno.test("harness refusal codes: alert() inside a method is still a deliberate rejection (the info line, as on 79155b6d2)", async () => {
  await using _ui = await testUI(() => h("p", null, "hi"), {
    cells: [dialogs],
  });
  const said: string[] = [];
  const keep = {
    info: console.info,
    error: console.error,
    warn: console.warn,
    log: console.log,
  };
  console.info =
    console.error =
    console.warn =
    console.log =
      (
        ...a: unknown[]
      ) => {
        said.push(a.map(String).join(" "));
      };
  let caught: unknown;
  try {
    await (dialogs as unknown as { ask(): Promise<void> }).ask();
  } catch (e) {
    caught = e;
  } finally {
    Object.assign(console, keep);
  }
  assert(caught instanceof Error, `the call was not refused: ${caught}`);
  assertStringIncludes(caught.message, "a native dialog");
  // The caller's code is the sync runner's, as on 79155b6d2.
  assertEquals(errorCode(caught), "REDUCE_ERROR");
  const out = said.join("\n");
  assertStringIncludes(out, "refusalCodesDialog:ask rejected: testUI: alert(");
  assert(!out.includes("REDUCE_ERROR"), `reported as a crash:\n${out}`);
});

Deno.test("harness refusal codes: every new code goes through withRefusalCode (only DEAD_BOOT is assigned directly)", async () => {
  const files = [
    "src/standalone-air.ts",
    "src/state/cell-catalog.ts",
    "src/server/cell-worker-host.ts",
    ...[...Deno.readDirSync(`${ROOT}src/testing`)]
      .filter((e) => e.name.endsWith(".ts"))
      .map((e) => `src/testing/${e.name}`),
  ];
  const assigned: string[] = [];
  for (const f of files) {
    const text = await Deno.readTextFile(`${ROOT}${f}`);
    for (const m of text.matchAll(ASSIGNED)) assigned.push(m[1]!);
  }
  assertEquals(assigned, ["DEAD_BOOT"]);
});

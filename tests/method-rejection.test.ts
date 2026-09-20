// A method's deliberate "no" is one info line; a bug keeps the error box.
// See src/state/method-rejection.ts for why (a validation throw printed
// `[REDUCE_ERROR] … check action payload shape` on every mistyped email).
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { bootCells } from "../src/cell-test.ts";
import { cell } from "../mod.ts";
import {
  isDeliberateRejection,
  rejectionLine,
} from "../src/state/method-rejection.ts";

Deno.test("isDeliberateRejection: a refusal vs a bug", () => {
  assertEquals(isDeliberateRejection(new Error("insufficient")), true);
  assertEquals(isDeliberateRejection("no"), true);
  class Denied extends Error {}
  assertEquals(isDeliberateRejection(new Denied("not yours")), true);
  // bugs
  assertEquals(isDeliberateRejection(new TypeError("x is undefined")), false);
  assertEquals(isDeliberateRejection(new RangeError("bad length")), false);
  assertEquals(
    isDeliberateRejection(new Error("[cell:x] stale reference")),
    false,
  );
  assertEquals(isDeliberateRejection(new Error("[Immer] frozen")), false);
  assertEquals(
    isDeliberateRejection(Object.assign(new Error("gone"), { code: "ENOENT" })),
    false,
  );
  assertEquals(isDeliberateRejection(undefined), false);
  assertEquals(isDeliberateRejection(new Error("")), false);
  // The runner WRAPS a sync throw (plain Error + cause): a bug inside the
  // wrapper is still a bug — this exact shape was misread once.
  assertEquals(
    isDeliberateRejection(
      new Error("wrapped", { cause: new TypeError("Cannot set properties") }),
    ),
    false,
  );
  assertStringIncludes(
    rejectionLine("bank:pay", new Error("insufficient")),
    "bank:pay rejected: insufficient",
  );
});

Deno.test("a method that says no prints one info line; a bug prints an error — caller rejected both ways", async () => {
  const bank = cell("rejbank", {
    state: { n: 0 },
    methods: {
      pay(_s) {
        throw new Error("insufficient");
      },
      async payLater(_s) {
        await Promise.resolve();
        throw new Error("insufficient later");
      },
      broken(s) {
        (s as unknown as { nope: { deeper: number } }).nope.deeper = 1;
      },
      async brokenLater(_s) {
        await Promise.resolve();
        (undefined as unknown as { go(): void }).go();
      },
    },
  });
  const out: { level: string; text: string }[] = [];
  const orig = { ...console };
  for (const level of ["error", "warn", "info", "log"] as const) {
    console[level] = (...a: unknown[]) =>
      void out.push({ level, text: a.map(String).join(" ") });
  }
  const rejected: string[] = [];
  try {
    await using _b = await bootCells([bank]);
    for (const m of ["pay", "payLater", "broken", "brokenLater"] as const) {
      await (bank[m] as () => Promise<unknown>)().then(
        () => rejected.push(`${m}: RESOLVED`),
        (e: Error) => rejected.push(`${m}: ${e.message}`),
      );
    }
  } finally {
    Object.assign(console, orig);
  }
  // The caller learns every failure, refusal or bug.
  assertEquals(rejected.length, 4);
  assert(!rejected.some((r) => r.includes("RESOLVED")), rejected.join("\n"));
  const loud = out.filter((o) => o.level === "error" || o.level === "warn");
  const said = (m: string) =>
    out.filter((o) =>
      o.text.includes(`rejbank:${m}`) || o.text.includes(`${m}()`)
    );
  // Refusals: one quiet line each, no error box.
  for (const m of ["pay", "payLater"]) {
    assert(
      said(m).some((o) => o.text.includes(`rejbank:${m} rejected:`)),
      `${m}: ${JSON.stringify(out)}`,
    );
    assert(
      !loud.some((o) =>
        o.text.includes(`rejbank:${m}`) || o.text.includes(`${m}()`)
      ),
      `${m} was loud`,
    );
  }
  // Bugs: still loud.
  assert(
    loud.some((o) =>
      o.text.includes("rejbank:broken") || o.text.includes("broken()")
    ),
    "sync bug went quiet",
  );
  assert(
    loud.some((o) => o.text.includes("brokenLater")),
    "async bug went quiet",
  );
});

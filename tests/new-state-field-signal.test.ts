// Adding a state key must SAY it is safe, not say nothing.
//
// _"A new field is safe — a stored blob without it deep-merges — but the author
// had to reason that out. Silence on the safe case and a loud warning on the
// unsafe one are indistinguishable from 'nobody checked'."_ (llama.master §10)
//
// The detector already walked both shapes at boot and threw this direction
// away: it reported a stored field the code no longer declares, and nothing at
// all about a declared field the store does not have.
import { assertEquals } from "@std/assert";
import {
  detectNewFields,
  detectShapeDrift,
  newFieldsSummary,
} from "../src/server/aio-boot.ts";

const names = (
  xs: ReadonlyArray<{ cell: string; path: string }>,
) => xs.map((x) => `${x.cell}.${x.path}`).sort();

Deno.test("a new top-level field is reported, with its type", () => {
  const added = detectNewFields(
    { cfg: { a: 1, retries: 3 } },
    { cfg: { a: 1 } },
  );
  assertEquals(names(added), ["cfg.retries"]);
  assertEquals(added[0]!.declaredType, "number");
});

Deno.test("a new NESTED field is reported at its full path", () => {
  const added = detectNewFields(
    { cfg: { net: { host: "h", port: 1 } } },
    { cfg: { net: { host: "h" } } },
  );
  assertEquals(names(added), ["cfg.net.port"]);
});

Deno.test("a wholly new SUBTREE is one arrival, not five", () => {
  // "cfg.retry arrived" is the fact; listing its sub-keys as five more
  // arrivals is the same news five times, and buries a second real one.
  const added = detectNewFields(
    { cfg: { a: 1, retry: { times: 3, backoff: "exp", jitter: true } } },
    { cfg: { a: 1 } },
  );
  assertEquals(names(added), ["cfg.retry"]);
  assertEquals(added[0]!.declaredType, "object");
});

Deno.test("a brand-new CELL is not a pile of new fields", () => {
  // Nothing was persisted for it yet. Reporting every key would bury a real
  // addition on the first boot after `am create`.
  assertEquals(
    detectNewFields({ fresh: { a: 1, b: 2, c: 3 } }, {}),
    [],
  );
});

Deno.test("an open record's keys are DATA, not shape", () => {
  // A declared empty object is a dynamic-key map — the same rule the drift
  // walk already applies in the other direction.
  assertEquals(detectNewFields({ c: { byId: {} } }, { c: { byId: {} } }), []);
  assertEquals(
    detectNewFields({ c: { byId: {} } }, { c: { byId: { x: 1 } } }),
    [],
  );
});

Deno.test("nothing new is nothing said", () => {
  assertEquals(detectNewFields({ c: { a: 1 } }, { c: { a: 2 } }), []);
  assertEquals(newFieldsSummary([]), "");
});

Deno.test("a migrated cell is skipped, exactly as drift skips it", () => {
  assertEquals(
    detectNewFields({ c: { a: 1, b: 2 } }, { c: { a: 1 } }, {
      skip: new Set(["c"]),
    }),
    [],
  );
});

Deno.test("the two directions are SEPARATE, and both are found at once", () => {
  // A rename is an addition AND a removal, and the two have different
  // remedies: one needs nothing, the other needs a version bump and
  // `onMigrate`. Mixing them into one list would make the safe half look
  // like part of the problem.
  const initial = { c: { newName: 1 } };
  const stored = { c: { oldName: 1 } };
  assertEquals(names(detectNewFields(initial, stored)), ["c.newName"]);
  assertEquals(
    detectShapeDrift(initial, stored).map((d) => `${d.cell}.${d.path}`),
    ["c.oldName"],
  );
});

Deno.test("the line says it is SAFE, and says why", () => {
  const line = newFieldsSummary([
    { cell: "cfg", path: "retries", declaredType: "number" },
  ]);
  // The whole point is that a reader does not have to reason it out.
  assertEquals(line.includes("no migration needed"), true, line);
  assertEquals(line.includes("cfg.retries (number)"), true, line);
  assertEquals(line.includes("filled from"), true, line);
  // …and it points at the line that is NOT safe, so the two are not confused.
  assertEquals(line.includes("shape drift"), true, line);
});

Deno.test("the report is capped — a huge new shape is still one line", () => {
  const decl: Record<string, unknown> = {};
  for (let i = 0; i < 300; i++) decl[`f${i}`] = i;
  const added = detectNewFields({ c: decl }, { c: { f0: 0 } });
  assertEquals(added.length <= 100, true, `uncapped: ${added.length}`);
  const line = newFieldsSummary(added);
  assertEquals(line.split("\n").length, 1, "one line, however much arrived");
  assertEquals(line.includes("more"), true, "…and it says there was more");
});

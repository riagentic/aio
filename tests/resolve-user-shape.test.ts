// A `resolveUser` (or `users:` entry) that answers with a malformed user — a
// bare string like "admin", `{ id }` with no role, an empty id — was accepted
// as authenticated without a word (a field report). Now: said once per shape
// in prod too; a record that names nobody is refused in dev (stricter), and
// still accepted in prod, so an app that works today keeps working.
import { assertEquals } from "@std/assert";
import { _buildUserResolver } from "../src/server/server-auth.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";
import { setDevModeOverride } from "../src/state/dev-flag.ts";
import { _said } from "../src/protocol/said-once.ts";

async function run(dev: boolean, answer: unknown) {
  const seen: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _c: string, msg: string) => {
        if (lvl === "warn") seen.push(msg);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  setDevModeOverride(dev);
  _said.clear();
  try {
    // deno-lint-ignore no-explicit-any
    const r = _buildUserResolver({ resolveUser: () => answer as any })!;
    const sync = r("t");
    const async_ = await _buildUserResolver({
      // deno-lint-ignore no-explicit-any
      resolveUser: () => Promise.resolve(answer as any),
    })!("t");
    r("t"); // a second identical answer: no second line
    return { sync, async_, seen };
  } finally {
    setDevModeOverride(null);
    setLogger(prev);
    _said.clear();
  }
}

Deno.test("resolveUser shape: a well-formed user and null pass silently", async () => {
  for (const dev of [true, false]) {
    const ok = await run(dev, { id: "ann", role: "admin", extra: 1 });
    assertEquals(ok.sync, { id: "ann", role: "admin", extra: 1 });
    assertEquals(ok.seen, []);
    const no = await run(dev, null);
    assertEquals([no.sync, no.async_, no.seen], [null, null, []]);
  }
});

Deno.test("resolveUser shape: a record naming nobody — refused in dev, accepted with a warning in prod", async () => {
  for (const bad of ["admin", { role: "admin" }, { id: "", role: "x" }, [1]]) {
    const dev = await run(true, bad);
    assertEquals([dev.sync, dev.async_], [null, null]);
    assertEquals(dev.seen.length, 1, JSON.stringify(dev.seen));
    assertEquals(dev.seen[0]!.includes("Refused in dev"), true);
    const prod = await run(false, bad);
    assertEquals([prod.sync, prod.async_], [bad, bad]);
    assertEquals(prod.seen.length, 1, JSON.stringify(prod.seen));
    assertEquals(prod.seen[0]!.includes("names nobody"), true);
  }
});

Deno.test("resolveUser shape: a user with no role is accepted in both, with a warning", async () => {
  for (const dev of [true, false]) {
    const r = await run(dev, { id: "ann" });
    assertEquals(r.sync as unknown, { id: "ann" });
    assertEquals(r.seen.length, 1);
    assertEquals(r.seen[0]!.includes("no string role"), true);
  }
});

Deno.test("resolveUser shape: a numeric id (`{ id: row.id }` from SQLite) is a user in dev and prod", async () => {
  for (const dev of [true, false]) {
    const r = await run(dev, { id: 42, role: "admin" });
    assertEquals([r.sync, r.async_] as unknown[], [
      { id: 42, role: "admin" },
      { id: 42, role: "admin" },
    ]);
    assertEquals(r.seen, []);
  }
  for (const bad of [{ id: NaN, role: "x" }, { id: Infinity, role: "x" }]) {
    assertEquals((await run(true, bad)).sync, null, "no usable id: refused");
  }
});

Deno.test("resolveUser shape: a fault is said once per KIND, not once per user", () => {
  const seen: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (lvl: string, _c: string, msg: string) => {
        if (lvl === "warn") seen.push(msg);
      },
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  setDevModeOverride(false);
  _said.clear();
  try {
    // deno-lint-ignore no-explicit-any
    const r = _buildUserResolver({ resolveUser: (t) => ({ id: t }) as any })!;
    for (let i = 0; i < 500; i++) r("u" + i);
    assertEquals(seen.length, 1, "one line for 500 role-less users");
    assertEquals(_said.size, 1, "one once-only key, not one per user");
  } finally {
    setDevModeOverride(null);
    setLogger(prev);
    _said.clear();
  }
});

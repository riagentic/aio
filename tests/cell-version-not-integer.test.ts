// cell({ version: "2.0.0", onMigrate }) was accepted silently: migrations
// compare the version as a number, NaN made every comparison false, and the
// onMigrate never ran. Still accepted (the compatibility rule) — but WARNED
// at definition, naming the cell, the value and the fix.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";

function warnsDuring(fn: () => void): string[] {
  const out: string[] = [];
  const orig = { warn: console.warn, error: console.error, log: console.log };
  for (const k of ["warn", "error", "log"] as const) {
    console[k] = (...a: unknown[]) => void out.push(a.map(String).join(" "));
  }
  try {
    fn();
  } finally {
    Object.assign(console, orig);
  }
  return out;
}

const uid = () => "cvn" + Math.random().toString(36).slice(2, 7);

Deno.test('version "2.0.0" + onMigrate: defined, and warned with the fix', () => {
  const name = uid();
  const out = warnsDuring(() =>
    cell(name, {
      state: { n: 0 },
      version: "2.0.0" as unknown as number,
      onMigrate: (s: unknown) => s as { n: number },
      methods: {},
    } as never)
  );
  const line = out.find((l) => l.includes(name) && l.includes('"2.0.0"'));
  assert(line, out.join("\n"));
  assert(line.includes("data-shape counter"), line);
  assert(line.includes("not the app's semver"), line);
});

Deno.test("version 1.5 and -1 are warned", () => {
  for (const v of [1.5, -1, NaN]) {
    const name = uid();
    const out = warnsDuring(() =>
      cell(name, { state: { n: 0 }, version: v, methods: {} } as never)
    );
    assert(
      out.some((l) => l.includes(name) && l.includes("version")),
      `${v}: ${out.join("\n")}`,
    );
  }
});

Deno.test("an integer version (and none) says nothing", () => {
  for (const v of [undefined, 0, 1, 7]) {
    const name = uid();
    const cfg: Record<string, unknown> = { state: { n: 0 }, methods: {} };
    if (v !== undefined) cfg.version = v;
    if (v) cfg.onMigrate = (s: unknown) => s;
    const out = warnsDuring(() => cell(name, cfg as never));
    assertEquals(
      out.filter((l) => l.includes(name) && l.includes("version")),
      [],
    );
  }
});

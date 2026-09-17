// The removed-API scan (`am pin` / `am migrate`) judges an API-shape row at
// its SITE, not anywhere its spelling appears. `appVersion:` is an
// `aio.run()` key — and also a perfectly ordinary state field; `type Action`
// is the aio/air import — and also an app's own action union; `every … backoff`
// is a `schedule.poll()` option object — and also any retry policy an app
// writes. Each refused a compatible pin with `--force` as the only way past
// (h8 F1). The canonical removals still hit, from the registry's own examples.
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { removalsInFile } from "../src/state/removals.ts";
import { preflight } from "../src/am/am-cmd-pin.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const keys = (src: string) => removalsInFile(src).map((h) => h.removal.key);

Deno.test("removals: app-owned spellings of API-shape rows are NOT hits", () => {
  const cases: Record<string, string> = {
    "own Action type, inline type modifier":
      `import { type Action, type Item } from "./types.ts";\nexport type X = Action;\n`,
    "appVersion as a state field": `import { cell } from "aio";
export const c = cell("c", { state: { count: 0, appVersion: "0.1" }, methods: {} });
`,
    "ui as a state field (theme)": `import { cell } from "aio";
export const c = cell("c", { state: { ui: "dark" }, methods: {} });
`,
    "ui filter object nested in state": `import { cell } from "aio";
export const c = cell("c", { state: { prefs: { ui: { exclude: ["x"] } } }, methods: {} });
`,
    "a retry policy with every+backoff":
      `export const retry = { every: 1000, backoff: 2 };\n`,
    "listensTo array in state": `import { cell } from "aio";
export const c = cell("c", { state: { listensTo: ["a"] }, methods: {} });
`,
    "killExisting in a plain object":
      `export const flags = { killExisting: false };
aio.run({ takeover: true });
`,
    "a local object named schedule":
      `const schedule = { blocking: true };\nexport const b = schedule.blocking;\n`,
    "return schedule.x( outside any cell":
      `import { schedule } from "aio";\nexport function plan() { return schedule.after(1000, () => {}); }\n`,
  };
  for (const [name, src] of Object.entries(cases)) {
    assertEquals(keys(src), [], `false positive: ${name}`);
  }
});

Deno.test("removals: the canonical API-shape removals still hit at their site", () => {
  const cases: Array<[string, string, string]> = [
    [
      "Action from aio/air",
      `import { type Action, h } from "aio/air";\n`,
      "Action (aio/air)",
    ],
    [
      "Action from aio (export form)",
      `export { type Action } from "aio";\n`,
      "Action (aio/air)",
    ],
    [
      "appVersion in aio.run",
      `aio.run({ cells: [], appVersion: "1.0" });\n`,
      "aio.run({ appVersion })",
    ],
    [
      "appVersion in a bound aio.run config",
      `const cfg = { cells: [], appVersion: "1.0" };\naio.run(cfg);\n`,
      "aio.run({ appVersion })",
    ],
    [
      "killExisting in aio.run",
      `aio.run({ killExisting: true });\n`,
      "aio.run({ killExisting })",
    ],
    [
      "cell ui: string",
      `export const c = cell("c", { state: { n: 0 }, ui: "all" });\n`,
      "cell({ ui })",
    ],
    [
      "cell ui: filter",
      `export const c = cell("c", {\n  state: { n: 0 },\n  ui: { exclude: ["n"] },\n});\n`,
      "cell({ ui })",
    ],
    [
      "cell listensTo array",
      `export const c = cell("c", { state: {}, listensTo: ["other"] });\n`,
      "listensTo: [...]",
    ],
    [
      "schedule.poll backoff",
      `schedule.poll("id", { every: 1000, backoff: 2 }, fn);\n`,
      "schedule.poll({ backoff })",
    ],
    [
      "schedule.poll backoff, bound options",
      `const opts = { every: 1000, backoff: 2 };\nschedule.poll("id", opts, fn);\n`,
      "schedule.poll({ backoff })",
    ],
    [
      "schedule.blocking from aio",
      `import { schedule } from "aio";\nexport const e = schedule.blocking("id", fn, 1);\n`,
      "schedule.blocking",
    ],
    [
      "return schedule.x( inside a cell method",
      `export const c = cell("c", {\n  state: {},\n  methods: { go(s) { return schedule.after(1, fn); } },\n});\n`,
      "return effect(s) from a method",
    ],
  ];
  for (const [name, src, key] of cases) {
    assertEquals(keys(src), [key], `missed: ${name}`);
  }
});

Deno.test("removals: a QUOTED removed key, a generic cell<…>( with parens, and an aliased cell import all hit (h8 F10)", () => {
  assertEquals(
    keys(
      `export const c = cell("c", { state: {}, "machine": { initial: "idle" } });\n`,
    ),
    ["machine"],
    "quoted key",
  );
  assertEquals(
    keys(
      `export const c = cell<Record<string, () => void>>("c", { state: {}, machine: {} });\n`,
    ),
    ["machine"],
    "generic with parens",
  );
  assertEquals(
    keys(
      `import { cell as defineCell } from "aio";\nexport const c = defineCell("c", { state: {}, machine: {} });\n`,
    ),
    ["machine"],
    "aliased import",
  );
});

Deno.test("removals: a same-named binding in an UNRELATED scope is not the cell's config (h8 F11)", () => {
  const src = `import { cell } from "aio";
import { config } from "./cfg.ts";
function other() {
  const config = { machine: { initial: "idle" } };
  return config;
}
export const c = cell("c", config);
`;
  assertEquals(keys(src), []);
  // …while a binding whose scope ENCLOSES the call is followed, as before.
  const scoped = `import { cell } from "aio";
export function make() {
  const config = { state: {}, machine: { initial: "idle" } };
  return cell("c", config);
}
`;
  assertEquals(keys(scoped), ["machine"]);
});

Deno.test("preflight: the scaffold counter with its own Action type and an appVersion field pins (h8 F1)", async () => {
  const dir = await tempDir("aio-pin-site-");
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "src/types.ts"),
      `export type Action = { kind: "inc" } | { kind: "dec" };\nexport type Item = { id: string };\n`,
    );
    await Deno.writeTextFile(
      join(dir, "src/cell.ts"),
      `import { cell } from "aio";
import { type Action, type Item } from "./types.ts";
export const counter = cell("counter", {
  state: { count: 0, appVersion: "0.1", items: [] as Item[], ui: "dark" },
  methods: { apply(s, a: Action) { if (a.kind === "inc") s.count++; else s.count--; } },
});
`,
    );
    assertEquals(await preflight(dir, "v1.0.2-beta"), []);
  } finally {
    await dropTempDir(dir);
  }
});

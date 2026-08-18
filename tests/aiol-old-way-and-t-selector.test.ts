// Two lints that turn documented footguns into squiggles.
//
// 1. `perfBudget.methods["cell:method"].timeout` is the OLD way to say "this
//    method may run as long as it needs". `long: [...]` is checked against the
//    cell's method list at cell() time; the string is checked by nobody. One
//    field report accumulated nine such entries BEFORE `long:` existed, and a
//    later project accumulated three AFTER it did — purely by copying the
//    canonical example.
// 2. `t` is a framework-owned test handle, STRIPPED before the DOM. It looks
//    like an attribute, so `querySelector('video[t="player"]')` and a CSS rule
//    `[t="x"]{…}` both match nothing, silently. Documented twice, and it still
//    shipped a dead Play button plus a set of no-op CSS rules in one repo.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import {
  checkOldWayPerfBudget,
  checkTestHandleSelectors,
} from "../aiol/checks.ts";

async function issues(
  files: Record<string, string>,
  check: typeof checkOldWayPerfBudget,
) {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1.0.0" } }),
    );
    for (const [rel, src] of Object.entries(files)) {
      await Deno.writeTextFile(join(dir, rel), src);
    }
    const { ctx, report } = await buildContext(dir);
    await check(ctx);
    return report.issues;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const CELL = `import { cell } from "aio";
export const models = cell("models", {
  state: { n: 0 },
  methods: {
    async scan(s: { n: number }) {
      await Promise.resolve();
      s.n++;
    },
  },
});
`;

Deno.test("aiol: a perfBudget timeout on a LOCAL method points at long:", async () => {
  const found = await issues({
    "src/cell.ts": CELL,
    "src/app.ts": `import { aio } from "aio";
import "./cell.ts";
await aio.run({
  perfBudget: { methods: { "models:scan": { timeout: 0 } } },
});
`,
  }, checkOldWayPerfBudget);
  assertEquals(found.length, 1);
  const m = found[0]!.message;
  assert(m.includes('long: ["scan"]'), `names the replacement exactly: ${m}`);
  assert(m.includes('cell("models"'), `names where it goes: ${m}`);
  assert(m.includes("rename"), `says WHY the string is worse: ${m}`);
});

Deno.test("aiol: a perfBudget entry with no timeout is left alone", async () => {
  // `effect` alone is a real budget for a genuinely slow method, not the
  // "no ceiling" declaration `long:` replaces.
  const found = await issues({
    "src/cell.ts": CELL,
    "src/app.ts": `import { aio } from "aio";
import "./cell.ts";
await aio.run({ perfBudget: { methods: { "models:scan": { effect: 250 } } } });
`,
  }, checkOldWayPerfBudget);
  assertEquals(found.length, 0);
});

Deno.test("aiol: a [t=] querySelector is an error, not a hint", async () => {
  const found = await issues({
    "src/ui.ts": `export function play() {
  const v = document.querySelector('video[t="video-player"]');
  v?.play();
}
`,
  }, checkTestHandleSelectors);
  assertEquals(found.length, 1);
  assertEquals(found[0]!.severity, "error");
  const m = found[0]!.message;
  assert(m.includes("never reaches the DOM"), m);
  assert(m.includes("returns null"), `says what actually happens: ${m}`);
});

Deno.test("aiol: a [t=] CSS rule is flagged too", async () => {
  const found = await issues({
    "src/style.css":
      `.panel { color: red }\n[t="result-image"] { border: 1px solid }\n`,
  }, checkTestHandleSelectors);
  assertEquals(found.length, 1);
  assert(found[0]!.message.includes("matches nothing"), found[0]!.message);
  assertEquals(found[0]!.line, 2);
});

Deno.test("aiol: ordinary selectors and ordinary [t] code are untouched", async () => {
  const found = await issues({
    "src/ui.ts": `type Row = { t: string };
const idx: Record<string, number> = {};
export const pick = (rows: Row[]) => rows.map((r) => idx[r.t]);
export const el = () => document.querySelector('[data-t="ok"]');
export const el2 = () => document.querySelector(".card button");
`,
    "src/style.css": `[data-t="ok"] { color: red }\n`,
  }, checkTestHandleSelectors);
  assertEquals(found.length, 0);
});

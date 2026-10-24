// `schedule.*` / `own.*` only BUILD an effect; `s.$do(…)` runs it. A bare
// statement `schedule.after(…)` schedules nothing and says nothing — the
// lint is the only place that can see it.
import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { ALL_CHECKS, checkDroppedEffect } from "../aiol/checks.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

async function lines(src: string): Promise<number[]> {
  const dir = await tempDir("aiol-dropped-effect-");
  try {
    await Deno.mkdir(join(dir, "src"));
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1.0.0" } }),
    );
    await Deno.writeTextFile(join(dir, "src", "cell.ts"), src);
    const { ctx, report } = await buildContext(dir);
    await checkDroppedEffect(ctx);
    return report.issues.map((i) => {
      assertStringIncludes(i.message, "throws it away");
      return i.line!;
    });
  } finally {
    await dropTempDir(dir);
  }
}

Deno.test("aiol dropped effect: a bare builder statement is reported", async () => {
  const src = [
    `import { cell, schedule, own as o } from "aio";`, // 1
    `export const t = cell("t", {`,
    `  state: { n: 0 },`,
    `  methods: {`,
    `    a(s) {`, // 5
    `      schedule.after("t.a", 10, self("b"));`, // 6 dropped
    `      if (s.n) schedule.cancel("t.a");`, // 7 dropped
    `      o.set("t:x", () => () => {});`, // 8 dropped (alias)
    `      s.n++`,
    `      schedule.every("t.e", 10, self("b"))`, // 10 dropped (ASI)
    `      // a comment line ends nothing`,
    `      schedule.poll("t.p", self("b"), { every: 10 });`, // 12 dropped
    `    },`,
    `    b(s) { s.n = 0; },`,
    `  },`,
    `});`,
  ].join("\n");
  assertEquals(await lines(src), [6, 7, 10, 12, 8]);
});

Deno.test("aiol dropped effect: a USED effect is silent", async () => {
  const src = [
    `import { aio, cell, schedule, own } from "aio";`,
    `// schedule.after("in a comment", 1, x);`,
    `const later = () => schedule.after("t.l", 10, self("b"));`,
    `const e = own.dispose("t:x");`,
    `export const t = cell("t", {`,
    `  state: { n: 0 },`,
    `  methods: {`,
    `    a(s) {`,
    `      s.$do(schedule.after("t.a", 10, self("b")));`,
    `      s.$do(`,
    `        schedule.cancel("t.a"),`,
    `        own.set("t:x", () => () => {}),`,
    `      );`,
    `      void schedule.next("t.n", self("b"));`,
    `      const msg = "schedule.after(x)";`,
    `      return aio.schedule.at("t.at", "09:00", self("b"));`,
    `    },`,
    `    b(s) { s.n = 0; },`,
    `  },`,
    `});`,
  ].join("\n");
  assertEquals(await lines(src), []);
  // A local named `own` that is NOT aio's is none of this rule's business.
  assertEquals(
    await lines(`const own = { set: (k: string) => k };\nown.set("x");\n`),
    [],
  );
});

Deno.test("aiol dropped effect: the rule runs", () => {
  assertEquals(ALL_CHECKS.includes(checkDroppedEffect), true);
});

// `s.x = { ...s.x, y }` inside an ASYNC cell method: `s` is a live proxy there,
// so the spread carries proxies for any nested object/array and the store refuses
// the write. The runtime now rejects the method that made it (see
// tests/proxy-write-loud.test.ts); this is the static half — named at lint time,
// before it runs. Suggested by the llama.master field report, which had to write
// this rule itself as a source-level regex guard in its own test suite.
//
// The SYNC case must stay silent: a sync method mutates an Immer draft, whose
// spread yields plain values, and that has always been legal. A linter that
// flagged both would teach developers to ignore it.
import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { buildContext } from "../aiol/context.ts";
import { checkProxySpreadBack } from "../aiol/checks.ts";

async function warnings(cellSource: string) {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "src"), { recursive: true });
    await Deno.writeTextFile(
      join(dir, "deno.json"),
      JSON.stringify({ imports: { aio: "jsr:@riagentic/aio@1.0.0" } }),
    );
    await Deno.writeTextFile(join(dir, "src", "builds.ts"), cellSource);
    const { ctx, report } = await buildContext(dir);
    await checkProxySpreadBack(ctx);
    return report.issues.filter((i) =>
      i.message.includes("spread and assigned")
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const wrap = (methods: string) =>
  `import { cell } from "aio";
type Job = { step: number; log: string[] };
export const builds = cell("builds", {
  state: { job: { step: 0, log: [] } as Job },
  methods: {
${methods}
  },
});
`;

Deno.test("aiol: flags spread-back inside an async method", async () => {
  const w = await warnings(wrap(
    `    async update(s: { job: Job }, step: number) {
      await new Promise((r) => setTimeout(r, 1));
      s.job = { ...s.job, step };
    },`,
  ));
  assertEquals(w.length, 1, JSON.stringify(w));
  assert(w[0]!.message.includes("s.job"), w[0]!.message);
  assert(
    /JSON\.parse|snapshot/i.test(w[0]!.message),
    `must state the fix: ${w[0]!.message}`,
  );
});

Deno.test("aiol: array spread-back is flagged too", async () => {
  const w = await warnings(wrap(
    `    async append(s: { job: Job; lines: string[] }, line: string) {
      await new Promise((r) => setTimeout(r, 1));
      s.lines = [...s.lines, line];
    },`,
  ));
  assertEquals(w.length, 1, JSON.stringify(w));
});

Deno.test("aiol: a SYNC method's draft spread is legal and stays silent", async () => {
  const w = await warnings(wrap(
    `    bump(s: { job: Job }) {
      s.job = { ...s.job, step: 1 };
    },`,
  ));
  assertEquals(
    w.length,
    0,
    "a sync method spreads an Immer draft — legal, and flagging it would be " +
      "the false positive that gets a linter ignored",
  );
});

Deno.test("aiol: spreading a DIFFERENT field is not the trap", async () => {
  const w = await warnings(wrap(
    `    async copy(s: { job: Job; prev: Job }) {
      await new Promise((r) => setTimeout(r, 1));
      s.prev = { ...s.job };
    },`,
  ));
  assertEquals(
    w.length,
    0,
    "assigning to a different key is a normal (if still proxy-carrying) write " +
      "— the rule targets the read-modify-write-back shape it can prove",
  );
});

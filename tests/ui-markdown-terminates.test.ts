// <Markdown> must FINISH on any input. Its source is user text and it renders
// under SSR, so a parse that does not terminate is a server crash, not a slow
// page: "```js title=\"x\"" (a fence with an info string) and "````" (a longer
// fence) matched the paragraph loop's "a block starts here" test but not the
// fence parser, the loop consumed zero lines, and it pushed empty <p>s until
// the heap ran out. `">".repeat(20000)` recursed once per `>` and blew the
// stack.
//
// Each case renders in a CHILD process with a small heap and a deadline: a hang
// or an OOM inside this test process would take the whole runner down with it
// instead of failing one test.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { renderToString } from "../src/air/vdom.ts";
import { Markdown } from "../src/ui/markdown.ts";

const md = (source: string): string => renderToString(Markdown({ source }));

/** Render every source in a child; resolve to the per-case HTML lengths. */
async function renderInChild(
  sources: string[],
  deadlineMs: number,
): Promise<number[]> {
  const mod = new URL("../src/ui/markdown.ts", import.meta.url).href;
  const vdom = new URL("../src/air/vdom.ts", import.meta.url).href;
  const script = `
    const { Markdown } = await import(${JSON.stringify(mod)});
    const { renderToString } = await import(${JSON.stringify(vdom)});
    const sources = JSON.parse(await new Response(Deno.stdin.readable).text());
    const lens = sources.map((source) =>
      renderToString(Markdown({ source })).length
    );
    console.log(JSON.stringify(lens));
  `;
  const child = new Deno.Command(Deno.execPath(), {
    args: ["eval", "--v8-flags=--max-old-space-size=256", script],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const w = child.stdin.getWriter();
  await w.write(new TextEncoder().encode(JSON.stringify(sources)));
  await w.close();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGKILL");
    } catch { /* already gone */ }
  }, deadlineMs);
  const out = await child.output();
  clearTimeout(timer);
  const stderr = new TextDecoder().decode(out.stderr).slice(-800);
  assert(!timedOut, `Markdown did not finish within ${deadlineMs}ms`);
  assert(out.success, `the render child crashed (code ${out.code}): ${stderr}`);
  return JSON.parse(new TextDecoder().decode(out.stdout).trim());
}

const ADVERSARIAL = [
  '```js title="x"\ncode\n```',
  "````\ncode\n````",
  "```js title=x",
  "```a`b\ntext",
  "````\n```\n````",
  "- a b",
  "# T x",
  "# a\u2028b",
  "- a\u2028b",
  "1. a\u2029b",
  "para\n```js x\ncode",
  "para\n# a\u2028b",
  "para\n- a\u2028b",
  ">".repeat(20000),
  "> ".repeat(20000),
  (">".repeat(40) + " deep\n").repeat(50),
  "*_".repeat(5000),
  "**__".repeat(4000),
  "[".repeat(10000) + "](x)",
  "![".repeat(5000),
  "`".repeat(9999),
  "#".repeat(10000) + " x",
  "-\n".repeat(5000),
];

/** Deterministic PRNG, so a failure names a reproducible case. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ATOMS = [
  "`",
  "```",
  "````",
  "#",
  "# ",
  ">",
  "> ",
  "-",
  "- ",
  "*",
  "**",
  "_",
  "__",
  "+ ",
  "1. ",
  "---",
  "***",
  "___",
  "[",
  "]",
  "(",
  ")",
  "![",
  "\n",
  "\n\n",
  " ",
  "\t",
  "\u2028",
  "x",
  "js",
  '"',
];

function randomSources(count: number, seed: number): string[] {
  const rnd = mulberry32(seed);
  return Array.from({ length: count }, () => {
    const n = 1 + Math.floor(rnd() * 60);
    let s = "";
    for (let k = 0; k < n; k++) s += ATOMS[Math.floor(rnd() * ATOMS.length)];
    return s;
  });
}

Deno.test("md terminates: adversarial and random sources all finish, with bounded output", async () => {
  const sources = [...ADVERSARIAL, ...randomSources(3000, 0xa10)];
  const lens = await renderInChild(sources, 30_000);
  assertEquals(lens.length, sources.length);
  lens.forEach((len, k) => {
    // Every block and inline node emits at most a few dozen bytes of markup
    // per source character; the runaway loop emitted empty <p>s forever.
    const bound = 64 * sources[k]!.length + 256;
    assert(
      len <= bound,
      `case ${k} ${
        JSON.stringify(sources[k]!.slice(0, 60))
      }: ${len} > ${bound}`,
    );
  });
});

Deno.test("md: a fence with an info string or 4+ backticks is a code block", () => {
  const titled = md('```js title="x"\nconst a = **b**;\n```');
  assertStringIncludes(
    titled,
    '<pre class="aio-md__pre"><code data-lang="js">const a = **b**;</code></pre>',
  );
  const four = md("````\n```\ninner\n```\n````\nafter");
  assertStringIncludes(four, "<code>```\ninner\n```</code>");
  assertStringIncludes(four, '<p class="aio-md__p">after</p>');
  // A backtick in the info string is not a fence (CommonMark) — inline code.
  assertStringIncludes(md("```a`b"), '<p class="aio-md__p">');
});

Deno.test("md: blockquotes nest up to a depth cap, the rest reads as text", () => {
  assertStringIncludes(md("> > inner"), "<blockquote");
  const deep = md(">".repeat(100) + " deep");
  assertEquals(deep.match(/<blockquote/g)?.length, 32);
  assertStringIncludes(deep, "&gt;".repeat(68) + " deep");
});

Deno.test("md: a heading or list item holding U+2028 is still that block", () => {
  assertStringIncludes(md("# a\u2028b"), "<h1>a\u2028b</h1>");
  assertStringIncludes(md("- a\u2028b"), "<li>a\u2028b</li>");
});

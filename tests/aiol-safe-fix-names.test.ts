// The rules about aio's `call`, `schedule` and `useCell` follow the BINDING,
// not the spelling: the name the file gives it (`import { call as c }`), a
// call with type arguments (`call<number>(…)`), a member access written over
// two lines. And the proof a fix needs is taken twice — over the code the
// mask shows and over the raw text where the mask says "not code" — so a
// mask that takes code for text can cost a fix, never cause a rewrite.
import { assert, assertEquals } from "@std/assert";
import {
  blockingUses,
  callTimeoutScan,
  pollBackoffCalls,
  scheduleBlockingToTop,
  specKinds,
  unreadUses,
  useCellCalls,
  whose,
} from "../aiol/fixes.ts";

const P1 = `() => Promise.resolve(1)`;
const line = (src: string, at: number) => src.slice(0, at).split("\n").length;

Deno.test("aiol call-timeout: a call under an alias or with type arguments is that call", () => {
  const fixed = (src: string) => {
    const { sites, fix } = callTimeoutScan(src);
    return [sites.length, fix.length];
  };
  const I = `import { call } from "aio";\n`;
  for (
    const [src, want] of [
      [I + `call<number>({ timeout: 5 }, ${P1});`, [1, 1]],
      [I + `call <number> ({ timeout: 5 }, ${P1});`, [1, 1]],
      [I + `call<Map<string, Set<number>>>({ timeout: 5 }, ${P1});`, [1, 1]],
      [I + `call<(a: number) => string>({ timeout: 5 }, ${P1});`, [1, 1]],
      [I + `call<{ a: Array<number> }>({ timeout: 5 }, ${P1});`, [1, 1]],
      // a comparison is no type-argument list
      [I + `const x = call < a; b > ({ timeout: 5 });`, [0, 0]],
      [I + `const x = call < a && b > ({ timeout: 5 });`, [0, 0]],
      [I + `const x = call < a || b > ({ timeout: 5 });`, [0, 0]],
      // the name the file gives it
      [
        `import { call as c } from "aio";\nc({ timeout: 5 }, ${P1});`,
        [1, 1],
      ],
      [
        `import { call as c } from "aio";\nc<number>({ timeout: 5 }, ${P1});`,
        [1, 1],
      ],
      // a member named like the alias is the object's own
      [
        `import { call as c } from "aio";\no.c({ timeout: 5 });\nthis.#c({ timeout: 5 });`,
        [0, 0],
      ],
      // …on a namespace of aio too: aio has no `c`
      [
        `import * as aio from "aio";\nimport { call as c } from "aio";\naio.c({ timeout: 5 });`,
        [0, 0],
      ],
      // the alias of ANOTHER export is not aio's `call`
      [`import { own as call } from "aio";\ncall({ timeout: 5 });`, [0, 0]],
      // another package's `call`, aliased
      [`import { call as c } from "npm:x";\nc({ timeout: 5 });`, [0, 0]],
      // a module nothing here can open: reported, not rewritten
      [`import { call as c } from "./x.ts";\nc({ timeout: 5 });`, [1, 0]],
      // an alias bound inside a function: reported, not rewritten
      [
        `const { call: c } = await import("aio");\nc({ timeout: 5 }, ${P1});`,
        [1, 0],
      ],
      // the options built elsewhere, under an alias
      [
        `import { call as c } from "aio";\nconst o = { timeout: 5 };\nc(o, ${P1});`,
        [1, 0],
      ],
    ] as const
  ) {
    assertEquals(fixed(src), [...want], src);
  }
});

Deno.test("aiol schedule.blocking / poll: the alias, the spaced member, the typed call", () => {
  const S = `import { schedule } from "aio";\n`;
  const A = `import { schedule as sch } from "aio";\n`;
  const uses = (src: string) =>
    blockingUses(src).map((u) => [
      src.slice(u.at, u.at + u.len),
      u.use.who,
    ]);
  assertEquals(uses(A + `sch.blocking("id", f, 0);`), [[
    "sch.blocking",
    "aio",
  ]]);
  assertEquals(
    uses(S + `schedule\n  .blocking("id", f, 0);`),
    [["schedule\n  .blocking", "aio"]],
  );
  assertEquals(
    uses(S + `schedule . blocking ("id", f, 0);`),
    [["schedule . blocking", "aio"]],
  );
  // `blocking` takes ONE type argument: a typed call is left to a person.
  const typed = blockingUses(
    S + `schedule.blocking<number, number>("id", f, 0);`,
  );
  assertEquals(typed.map((u) => u.use.who), ["shadowed"]);
  assert(typed[0]!.use.why.includes("type arguments"), typed[0]!.use.why);
  // A `blocking` the file already has: the hint says how to import aio's
  // beside it (the plain import would be a duplicate identifier).
  const [taken] = blockingUses(
    S + `const blocking = 1;\nschedule.blocking("id", f, 0);`,
  );
  assertEquals(taken!.use.who, "shadowed");
  assert(
    taken!.use.why.includes("import { blocking as runBlocking }"),
    taken!.use.why,
  );
  // Not called on the spot: not this rule's (it is an unread use, below).
  assertEquals(uses(S + `const b = schedule.blocking;`), []);
  // A member named like the alias is the object's own.
  assertEquals(uses(A + `o.sch.blocking("id");`), []);
  // The fix writes `blocking` over the whole spelling, and imports it where
  // the alias came from.
  const args = `("id", f, 0);\n`;
  assertEquals(
    scheduleBlockingToTop(A + "export const e = sch\n  .blocking" + args),
    `import { schedule as sch, blocking } from "aio";\n` +
      "export const e = blocking" + args,
  );
  assertEquals(
    scheduleBlockingToTop(S + `schedule.blocking<number, number>("id", f, 0);`),
    null,
  );

  const POLL = `.poll("p", 0, { type: "t" }, { every: 9, backoff: 2 })`;
  const polls = (src: string) =>
    pollBackoffCalls(src).map((c) => [c.keys.length, c.use.who]);
  assertEquals(polls(A + `sch${POLL};`), [[1, "aio"]]);
  assertEquals(polls(S + `schedule\n  ${POLL};`), [[1, "aio"]]);
  assertEquals(polls(A + `o.sch${POLL};`), []);
  // The options built elsewhere in the file: reported where they are
  // written, never rewritten.
  const built = S + `const o = { every: 9, backoff: 2 };\n` +
    `schedule.poll("p", 0, { type: "t" }, o);`;
  const [call] = pollBackoffCalls(built);
  assertEquals([call!.use.who, line(built, call!.keys[0]!)], ["shadowed", 2]);
  assert(call!.use.why.includes("built in `o` (line 2)"), call!.use.why);
  // …an object that is no opts (no `every`) is not.
  assertEquals(
    polls(
      S + `const o = { backoff: 2 };\nschedule.poll("p", 0, { type: "t" }, o);`,
    ),
    [],
  );
});

Deno.test("aiol useCell: a call under an alias or with type arguments is a call", () => {
  const calls = (name: string, src: string) =>
    useCellCalls(name, src).map((m) => m[0]);
  const U = `import { useCell as use } from "aio";\n`;
  assertEquals(calls("a.ts", U + `const n = use(c).state.n;`), ["use"]);
  assertEquals(calls("a.ts", U + `const n = o.use(c).state.n;`), []);
  // …on a namespace of aio too: aio has no `use`.
  assertEquals(
    calls(
      "a.ts",
      `import * as aio from "aio";\n` + U + `const n = aio.use(c).state.n;`,
    ),
    [],
  );
  assertEquals(
    calls("a.ts", `import { useCell } from "aio";\nconst n = useCell<T>(c);`),
    ["useCell"],
  );
  assertEquals(
    calls("a.ts", `import { useCell as use } from "npm:x";\nuse(c).state.n;`),
    [],
  );
});

Deno.test("aiol: a name the app's own barrel hands out under another name is followed to aio", () => {
  const files: Record<string, string> = {
    "/app/src/b.ts":
      `export { schedule as sched, call as invoke } from "aio";\n` +
      `export { mine as other } from "./mine.ts";\n`,
  };
  const kinds = specKinds({}, {
    root: "/app",
    from: "/app/src/a.ts",
    source: (p) => files[p],
  });
  assertEquals(kinds.origin?.("./b.ts", "sched"), "schedule");
  assertEquals(kinds.origin?.("./b.ts", "invoke"), "call");
  assertEquals(kinds.origin?.("./b.ts", "other"), undefined);
  assertEquals(kinds.origin?.("./b.ts", "schedule"), undefined);
  assertEquals(kinds.origin?.("./gone.ts", "sched"), undefined);
  assertEquals(kinds.origin?.("aio", "sched"), undefined);
  const src = `import { invoke, sched } from "./b.ts";\n` +
    `export const e = sched.blocking("id", f, 0);\n` +
    `export const r = invoke({ timeout: 5 }, ${P1});\n`;
  const [b] = blockingUses(src, kinds);
  assertEquals(b!.use.who, "maybe");
  assert(
    b!.use.why.includes("hands out aio's `schedule` as `sched`"),
    b!.use.why,
  );
  const scan = callTimeoutScan(src, kinds);
  assertEquals([scan.sites.length, scan.fix.length], [1, 0]);
  assertEquals(scheduleBlockingToTop(src, kinds), null);
});

Deno.test("aiol: a use of aio's `call` / `schedule` that no rule reads is named, once per name", () => {
  const unread = (src: string) =>
    unreadUses(src).map((u) => [u.exported, line(src, u.at)]);
  const S = `import { schedule } from "aio";\n`;
  const C = `import { call } from "aio";\n`;
  for (
    const [src, want] of [
      [S + `schedule?.blocking?.("id", f, 0);`, [["schedule", 2]]],
      [S + `(schedule as any)["blocking"]("id", f, 0);`, [["schedule", 2]]],
      [S + `const { blocking } = schedule;`, [["schedule", 2]]],
      [S + `const b = schedule.blocking;`, [["schedule", 2]]],
      [S + `xs.map(schedule.poll.bind(schedule));`, [["schedule", 2]]],
      [S + `run(schedule);`, [["schedule", 2]]],
      // one per name, the first
      [S + `run(schedule);\nconst k = schedule;`, [["schedule", 2]]],
      [C + `(0, call)({ timeout: 5 }, ${P1});`, [["call", 2]]],
      [C + `call.apply(null, [{ timeout: 5 }, ${P1}]);`, [["call", 2]]],
      [C + `const invoke = call;`, [["call", 2]]],
      // under an alias
      [
        `import { schedule as sch } from "aio";\nconst k = sch;`,
        [["schedule", 2]],
      ],
      // what the rules DO read
      [S + `schedule.after("t", 5, a);\nschedule.blocking("id", f, 0);`, []],
      [S + `schedule\n  .poll("p", 0, a, { every: 9 });`, []],
      [C + `call({ retries: 1 }, ${P1});\ncall<number>(o, ${P1});`, []],
      // a list that hands the binding on by name
      [C + S + `export { call, schedule };`, []],
      [C + `export { call as invoke };`, []],
      // another object's member; the app's own
      [S + `o.schedule;\nthis.schedule?.x;`, []],
      [`const schedule = make();\nrun(schedule);`, []],
      [`import { schedule } from "npm:x";\nrun(schedule);`, []],
      // nothing proves whose it is: the rules about the name say so
      [`run(schedule);`, []],
    ] as const
  ) {
    assertEquals(unread(src), want.map((w) => [...w]), src);
  }
  // In a file the rules already report for the name, a mention nothing reads
  // (a parameter of the same name) is their reason, not a second finding.
  const loud = S + `export const a = schedule.blocking("id", f, 0);\n` +
    `export const b = (schedule: Mine) => schedule.blocking("id");\n`;
  assertEquals(unread(loud), []);
  assertEquals(blockingUses(loud).map((u) => u.use.who), [
    "shadowed",
    "shadowed",
  ]);
});

// The backstop. In a file that may hold JSX the mask is not trusted: a name
// written anywhere the mask blanks is not proven — whatever the text there
// looks like, because a declaration the mask hid has its name exactly there.
Deno.test("aiol: in a file that may hold JSX, a name written where the mask blanks is not proven", () => {
  const I = `import { call } from "aio";\n`;
  const who = (src: string) => whose(src)(-1, "call").who;
  const use = `export const r = call({ timeout: 5 }, f);\n`;
  const El = `export const V = <p>x</p>;\n`;
  assertEquals(who(I + use + El), "aio");
  for (
    const hidden of [
      `const s = "(call) => 1";\n`,
      `const s = 'const call = 1';\n`,
      "const s = `({ call }) => 1`;\n",
      `const s = /call/;\n`,
      `const s = 1; // call the server\n`,
      `const s = 1; /* (call) => 1 */\n`,
      `export const W = <p>the (call) hook</p>;\n`,
      // Looking like a use excuses nothing…
      `const s = "call({ timeout: 5 })";\n`,
      `const s = "o.call(1)";\n`,
      `const s = "(...call) => 1";\n`,
      // …and neither does a comment that starts its line: text an element
      // shows may start a line with `//`, with a callback after it.
      `// (call) => 1\n`,
      `/**\n * call\n */\n`,
      // A specifier that could hold code is no specifier to trust.
      `import "./a (call) => b.ts";\n`,
    ]
  ) {
    const src = I + use + El + hidden;
    const got = whose(src)(-1, "call");
    assertEquals(got.who, "shadowed", hidden);
    const line = src.split("\n").length - (hidden.startsWith("/**") ? 2 : 1);
    assert(got.why.includes(`line ${line} writes \`call\` inside`), got.why);
  }
  // A self-closing element is JSX as well.
  assertEquals(
    who(I + use + `export const W = <br />;\n// call\n`),
    "shadowed",
  );
  // The name inside ANOTHER name is not the name.
  assertEquals(
    who(I + use + El + `// recall, call_, $call, callback\n`),
    "aio",
  );
  // A module statement's specifier made of specifier characters only is the
  // string it is: nothing in it can declare a name.
  assertEquals(who(I + use + El + `import "./call.ts";\n`), "aio");
  assertEquals(who(I + use + El + `export * from "npm:call@1/call";\n`), "aio");
  const ns = `import * as aio from "aio";\n` + El +
    `export const r = aio.call({ timeout: 5 }, f);\n`;
  assertEquals(whose(ns)(ns.indexOf("call("), "call").who, "aio");
  // `function` hidden at the end of a `//` line, the name in sight on the
  // next: the one declaration whose name the mask does not blank.
  const split = I + use + `export const V = (\n  // c\n  <pre>\n` +
    `    // see {function\n    call(o: unknown) { return o; }}\n  </pre>\n);\n`;
  assertEquals(who(split), "shadowed");
  // The NEW name a fix would write counts as taken where it is hidden.
  const sched = `import { schedule } from "aio";\n` + El +
    `export const r = schedule.blocking("id", f);\n`;
  assertEquals(blockingUses(sched).map((u) => u.use.who), ["aio"]);
  assertEquals(
    blockingUses(sched + `// {xs.map((blocking) => 1)}\n`).map((u) =>
      u.use.who
    ),
    ["shadowed"],
  );
  // A file that cannot hold JSX (no `</`, no `/>`) is read by the mask alone.
  assertEquals(who(I + use + `const s = "(call) => 1"; // call it\n`), "aio");
  // The same holds for the namespace a member is read from.
  const hiddenNs = `import * as aio from "aio";\n` + El +
    `const s = "(aio) => 1";\nexport const r = aio.call({ timeout: 5 }, f);\n`;
  assertEquals(whose(hiddenNs)(hiddenNs.indexOf("call("), "call").who, "maybe");
});

// Two things in a file mean no name in it is proven, whatever the name.
Deno.test("aiol: an identifier written with a \\u escape, or an element the reader did not take — nothing in the file is proven", () => {
  const I = `import { call } from "aio";\n`;
  const use = `export const r = call({ timeout: 5 }, f);\n`;
  const got = (src: string) => whose(src)(-1, "call");
  // `c\u0061ll` declares `call`. No JSX needed.
  const esc = I + use +
    `export const g = (c\\u0061ll: F) => call({ timeout: 5 });\n`;
  assertEquals(got(esc).who, "shadowed");
  assert(got(esc).why.includes("line 3 writes an identifier with a `\\u`"));
  // Any escape in the code, of any name: what it spells is not worked out.
  assertEquals(got(I + use + `const \\u{78} = 1;\n`).who, "shadowed");
  // In a string, a template's text, a regex or a comment it is no identifier.
  for (
    const text of [
      `const s = "c\\u0061ll \\u00a0";\n`,
      "const s = `\\u2026`;\n",
      `const s = /\\u0061/u;\n`,
      `// c\\u0061ll\n`,
    ]
  ) assertEquals(got(I + use + text).who, "aio", text);
  // …unless the file may hold JSX and the escape spells THIS name there.
  const El = `export const V = <p>x</p>;\n`;
  assertEquals(got(I + use + El + `// (c\\u0061ll) => 1\n`).who, "shadowed");
  assertEquals(got(I + use + El + `// (c\\u{61}ll) => 1\n`).who, "shadowed");
  assertEquals(
    got(I + use + El + `const s = "\\u00a0 rec\\u0061ll";\n`).who,
    "aio",
  );
  // A namespace is a name like any other.
  const ns = `import * as aio from "aio";\nconst \\u0061 = 1;\n` +
    `export const r = aio.call({ timeout: 5 }, f);\n`;
  assertEquals(whose(ns)(ns.indexOf("call("), "call").who, "maybe");

  // A closing tag anywhere in the raw text that closes no element the
  // reader took: an element it did not read, whose text was lexed as code.
  const S = `import { schedule } from "aio";\n`;
  const shown = (el: string) =>
    blockingUses(S + `export const V = () => ${el};\n`).map((u) => u.use);
  assertEquals(
    shown(`<p>{schedule.blocking("id", f)}</p>`).map((u) => u.who),
    ["aio"],
  );
  // A tag the reader cannot parse (a string among its type arguments).
  const lost = shown(
    `<List<"a" | "b"> items={[]}>\n  schedule.blocking(run) is it\n</List>`,
  );
  assertEquals(lost.map((u) => u.who), ["shadowed"]);
  assert(
    lost[0]!.why.includes("line 4 writes `</` where it closes no element"),
    lost[0]!.why,
  );
  for (
    const el of [
      // …its closing tag blanked by the text's own apostrophe
      `<List<"a" | "b"> items={[]}>schedule.blocking(run) isn't it</List>`,
      // an element where the reader never tries one, in code and blanked
      `void <p>\n  schedule.blocking(run) is it\n</p>`,
      `void <p>schedule.blocking(run) isn't it</p>`,
      `typeof <>schedule.blocking(run) isn't it</>`,
      // …inside an element the reader did take
      `<div>{void <p>schedule.blocking(run) isn't it</p>}</div>`,
      // however the closing tag is written: a comment in it, a name in
      // another script, a namespace, a line break, nothing but `</`
      `<List<"a" | "b"> items={[]}>schedule.blocking(run) is it</List /* end */>`,
      `void <Élément>schedule.blocking(run) is it</Élément>`,
      `void <a:b>schedule.blocking(run) is it</a:b>`,
      `void <p>schedule.blocking(run) is it</\n  p\n>`,
      `void <𝒳>schedule.blocking(run) is it</𝒳>`,
    ]
  ) assertEquals(shown(el).map((u) => u.who), ["shadowed"], el);
  // Wherever it is written: a string, a comment, a template.
  const Used = `export const V = <p>{schedule.blocking("id", f)}</p>;\n`;
  for (
    const text of [
      `export const s = "</p>";\n`,
      `// closes with </p>\n`,
      "export const s = `</>`;\n",
      `/* </a.b> */\n`,
      `// </\n`,
      `export const s = "</Élément>";\n`,
    ]
  ) {
    assertEquals(
      blockingUses(S + text + Used).map((u) => u.use.who),
      ["shadowed"],
      text,
    );
  }
  // …and wherever in the file: after elements whose closing tags are in
  // place too.
  assertEquals(
    blockingUses(S + Used + `// </p>\n`).map((u) => u.use.who),
    ["shadowed"],
  );
  // What is no closing tag is no sign: a generic arrow, a comparison, an
  // escaped one in a regex.
  for (
    const fine of [
      `export const id = <T,>(x: T) => x;\n`,
      `export const c = (a: number, b: number) => a < b || b > a;\n`,
      `export const re = /<\\/p>/;\n`,
    ]
  ) {
    assertEquals(
      blockingUses(S + fine + Used).map((u) => u.use.who),
      ["aio"],
      fine,
    );
  }
  // A file with neither `</` nor `/>` holds no JSX and is not asked.
  assertEquals(
    blockingUses(
      S +
        `export const s = "<p>"; // <b>\nexport const r = schedule.blocking("id", f);\n`,
    ).map((u) => u.use.who),
    ["aio"],
  );
});

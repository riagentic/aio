// The prototype-lookup ratchet must be able to SEE `k in data` — and must not
// drown it in for-in heads, mapped types and feature checks.
//
// `key in obj` is true for `toString` / `constructor` / `valueOf` on every
// plain object. It shipped as `!(k in out)` in cell-migrate (a stored
// `constructor` key dropped on restore). A gate with no test of its own is the
// "verify the instrument" trap wearing a ratchet, so this runs the scanner on
// TEXT and pins what it must catch, what it must not, and that an `aio-ok`
// justification is read from the comment the mask blanks.
import { assertEquals } from "@std/assert";
import { scanSource } from "../scripts/check-proto-in.ts";

Deno.test("proto-in gate: it sees the shipped spellings", () => {
  const r = scanSource(`
    if (!(k in out)) out[k] = stored[k];
    if (!(key in decl)) warn(key);
    const kept = Object.keys(stored).filter((k) => !(k in cellState));
    const has = a.b in c.d;
    const x = f(k) in o;
    const y = arr[0] in o;
  `);
  assertEquals(r.hits, [2, 3, 4, 5, 6, 7]);
  assertEquals(r.justified, 0);
});

Deno.test("proto-in gate: a builtin NAME as a literal key still counts", () => {
  const r = scanSource(`
    const a = "constructor" in x;
    const b = 'toString' in x;
    const c = "__proto__" in x;
  `);
  assertEquals(r.hits.length, 3, JSON.stringify(r.hits));
});

Deno.test("proto-in gate: iteration, types, literals and prose do not count", () => {
  const r = scanSource(`
    for (const k in obj) use(k);
    for (let k in obj) use(k);
    for (k in obj) use(k);
    for (const [a, b] in obj) use(a);
    type M<T> = { [K in keyof T]: T[K] };
    type R = { readonly [P in Keys]?: string };
    type S = { -readonly [P in Keys]-?: string };
    if ("value" in d) d.value;
    if ('then' in x) x.then;
    if (0 in arr) arr[0];
    // k in obj — a comment about the operator
    /* !(k in out) */
    const s = "k in obj";
    const t = \`logged in as \${name}\`;
    const re = /k in obj/;
    const o = { in: 1 };
    obj.in = 2;
    function f(inx: number) { return inx; }
  `);
  assertEquals(r.hits, [], JSON.stringify(r.hits));
});

Deno.test("proto-in gate: prose inside a template with NESTED templates is not code", () => {
  // code-mask.ts closes the outer template at the nested backtick and reads
  // the rest as code; the gate's mask must not. This exact shape put 30
  // English sentences into the count before the mask was switched.
  const r = scanSource(
    'const m = `a ${w ? `x` : "y"} is WRITING, so wrap the read in untrack` +\n' +
      "  `keep the draft in useLocal`;\n",
  );
  assertEquals(r.hits, [], JSON.stringify(r.hits));
});

Deno.test("proto-in gate: an `in` inside a template HOLE is code and counts", () => {
  const r = scanSource("const m = `${k in o ? 'y' : 'n'}`;");
  assertEquals(r.hits, [1]);
});

Deno.test("proto-in gate: aio-ok on the line, or the one above, justifies", () => {
  const here = scanSource(
    `if (k in el) el[k] = v; // aio-ok(proto-in): el is a DOM node, the prototype IS the API`,
  );
  assertEquals(here.hits, []);
  assertEquals(here.justified, 1);

  const above = scanSource(`
    // aio-ok: a class instance — inherited members are the point
    if (k in inst) call(k);
  `);
  assertEquals(above.hits, []);
  assertEquals(above.justified, 1);

  // A bare marker is a mute button; a marker for another gate is not this one's.
  assertEquals(scanSource(`if (k in o) f(); // aio-ok`).hits.length, 1);
  assertEquals(
    scanSource(`if (k in o) f(); // aio-ok(silent-catch): other rule`).hits
      .length,
    1,
  );
});

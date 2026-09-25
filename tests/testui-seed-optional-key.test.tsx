// A seed of an OPTIONAL key the cell never declared (`state: {} as { user?: U }`)
// mounted fine in 1.0.11 (the seed was silently dropped). The surface is frozen,
// so it still mounts — and the dropped seed is WARNED, naming the key and the
// one-line fix. (`t.init` already refused it in 1.0.11 and still does.)
import { assert, assertStringIncludes } from "@std/assert";
import { cell } from "../mod.ts";
import { testUI } from "../src/testing/ui-test.ts";
import { testCell } from "../src/testing/cell-test.ts";

type U = { name: string };
const auth = cell("seed-optional-auth", {
  state: {} as { user?: U },
  methods: {
    login(s: { user?: U }, name: string) {
      s.user = { name };
    },
  },
});

function App() {
  return <p class="who">{auth.user?.name ?? "anon"}</p>;
}

Deno.test("seed: an undeclared optional key still mounts, warning with `key: undefined` as the fix", async () => {
  const warned: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => warned.push(a.map(String).join(" "));
  try {
    await using ui = await testUI(App, {
      seed: { "seed-optional-auth": { user: { name: "bob" } } },
    });
    assertStringIncludes(ui.html(), "who");
  } finally {
    console.warn = orig;
  }
  const w = warned.filter((m) => m.includes("[aio] seed:"));
  assert(w.length === 1, `one seed warning expected, got ${w.length}`);
  const msg = w[0] ?? "";
  assertStringIncludes(msg, `"user"`);
  assertStringIncludes(msg, "declare `user: undefined` in `state:`");
});

const auth2 = cell("seed-optional-auth2", {
  state: { user: undefined } as { user?: U },
  methods: {},
});

function App2() {
  return <p class="who">{auth2.user?.name ?? "anon"}</p>;
}

Deno.test("seed: the named fix works — a declared `user: undefined` takes the seed", async () => {
  await using ui = await testUI(App2, {
    seed: { "seed-optional-auth2": { user: { name: "bob" } } },
  });
  assertStringIncludes(ui.html(), "bob");
});

testCell(auth, "t.init: an undeclared optional key names the same fix", (t) => {
  let msg = "";
  try {
    (t.init as (s: Record<string, unknown>) => void)({ user: { name: "x" } });
  } catch (e) {
    msg = (e as Error).message;
  }
  assertStringIncludes(msg, "declare `user: undefined` in `state:`");
});

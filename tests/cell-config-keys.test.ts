// `cell()` refuses an option key it does not read — and the allow-list that
// decides that cannot drift from the type it mirrors.
//
// `aio.run()` has validated its 156 config keys for releases and exits(1) on a
// typo. The OTHER half of an app's configuration — the cell definition, where
// `sync`, `access`, `persist`, `version` and `worker` live — validated nothing:
// `method:` for `methods:` produced a cell with no methods, `presist:` persisted
// anyway, `acces:` left the access gate open, and `sync: { mrege: … }` silently
// resolved every conflict last-write-wins instead of the strategy the app
// declared. Each of those is a feature the author configured and never got,
// with no error at any point.
import { assert, assertEquals, assertThrows } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { normalizeSyncConfig } from "../src/sync/types.ts";

const uniq = () => `probe-${crypto.randomUUID().slice(0, 8)}`;

Deno.test("cell(): a misspelled option is refused, with the key it meant", () => {
  const cases: [Record<string, unknown>, string, string][] = [
    [{ state: { n: 0 }, method: {} }, "method", "methods"],
    [{ state: { n: 0 }, methods: {}, presist: false }, "presist", "persist"],
    [{ state: { n: 0 }, methods: {}, acces: "server" }, "acces", "access"],
    [{ state: { n: 0 }, methods: {}, selector: {} }, "selector", "selectors"],
    [{ state: { n: 0 }, methods: {}, vesrion: 2 }, "vesrion", "version"],
  ];
  for (const [config, bad, meant] of cases) {
    // deno-lint-ignore no-explicit-any
    const e = assertThrows(() => cell(uniq(), config as any), Error);
    assert(e.message.includes(`"${bad}"`), `names the bad key: ${e.message}`);
    assert(
      e.message.includes(`did you mean "${meant}"`),
      `suggests the right one: ${e.message}`,
    );
  }
});

Deno.test("cell(): a key nobody could have meant is still refused, with the list", () => {
  // deno-lint-ignore no-explicit-any
  const e = assertThrows(
    // deno-lint-ignore no-explicit-any
    () => cell(uniq(), { state: {}, methods: {}, zzz: 1 } as any),
    Error,
  );
  assert(e.message.includes('"zzz"'));
  assert(e.message.includes("Valid keys:"), "lists what IS valid");
  assert(e.message.includes("methods"));
});

Deno.test("cell(): every documented option is accepted", () => {
  // The valid list is exercised, not just asserted — a key that is in the
  // allow-list but blows up somewhere else is not "valid".
  const full = {
    state: { n: 0 },
    methods: {
      inc: (s: { n: number }) => void s.n++,
      // an async method, so `long`/`cancelOn` have something to name
      load: async (s: { n: number }) => {
        await Promise.resolve();
        s.n = 1;
      },
    },
    selectors: { double: (s: { n: number }) => s.n * 2 },
    persist: true,
    visible: "all", // `ui` is its deprecated alias — one or the other
    access: true,
    long: ["load"],
    cancelOn: { load: "self" },
    listensTo: [] as string[],
    transaction: false,
    version: 1,
    onInit: () => {},
    onDestroy: () => {},
  };
  // deno-lint-ignore no-explicit-any
  const c = cell(uniq(), full as any);
  assert(c, "a cell using every option still builds");
});

Deno.test("cell(): the allow-list and MethodsCellConfig name the same keys", async () => {
  // The gate against a stale list: the type is the contract, this is the
  // runtime check, and they must not drift.
  const src = await Deno.readTextFile(
    new URL("../src/state/cell-config-types.ts", import.meta.url),
  );
  const typed = new Set(
    [...src.matchAll(/^ {2}([a-zA-Z_][\w]*)\??:/gm)].map((m) => m[1]!),
  );
  const runtime = new Set(
    [...(await Deno.readTextFile(
      new URL("../src/state/cell-create.ts", import.meta.url),
    )).matchAll(/^ {2}"([a-zA-Z_][\w]*)",$/gm)].map((m) => m[1]!),
  );
  const missing = [...typed].filter((k) => !runtime.has(k));
  assertEquals(
    missing,
    [],
    "these are typed options that cell() would now REFUSE at runtime",
  );
});

Deno.test("sync: a misspelled merge key is refused, not ignored", () => {
  // The most expensive typo in the framework: the app declares a CRDT strategy,
  // the key never matches, and every conflict silently resolves last-write-wins.
  const e = assertThrows(
    // deno-lint-ignore no-explicit-any
    () => normalizeSyncConfig({ mrege: { count: "counter" } } as any),
    Error,
  );
  assert(e.message.includes('"mrege"'));
  assert(e.message.includes("Valid keys:"));
  // …and the real shapes still normalize.
  assertEquals(normalizeSyncConfig(true).merge, {});
  assertEquals(
    normalizeSyncConfig({ merge: { count: "counter" } }).merge,
    { count: "counter" },
  );
});

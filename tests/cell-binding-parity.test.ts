// A cell has THREE bindings — the server catalog (`cell-create.ts`), the
// reactive client binding (`cell-reactive.ts`), and the browser's own `cell()`
// stub (`protocol/protocol-cell.ts`) — and the browser stub is a separate
// implementation, not a wrapper. Every time a per-cell fact the CLIENT branches
// on has been added, it has been added to two of the three:
//
//   • `asyncMethods` — the server tagged async calls with a `_callId`, the stub
//     didn't, so `await cell.method()` in a browser resolved `undefined`
//     (alpha34).
//   • `syncConfig` + the replay reducer — set together, or the engine gets a
//     cell it can stamp ops for and never replay.
//
// Both were found by hand, in a browser, after shipping. So this file is the
// gate: any `__aio.<key>` that client-side code reads must be produced by the
// browser stub too, or be listed here with the reason it cannot be. A new key
// gets neither for free — the same shape as the config-bridge gate, which has
// held that line for the server config.
import { assert, assertEquals } from "@std/assert";
import { cell as serverCell } from "../src/state/cell-create.ts";
import { cell as browserCell } from "../src/protocol/protocol-cell.ts";
import { _resetAioRuntime } from "../src/state/runtime-reset.ts";

/** Client-side sources: whatever these read off `__aio`, the stub must supply.
 *  The scan is deliberately literal — it matches `def.__aio.<key>`, so client
 *  code spells it that way rather than aliasing `const a = def.__aio`. A gate
 *  you can defeat by renaming a variable is not a gate. */
const CLIENT_SOURCES = [
  "src/browser",
  "src/air",
  "src/protocol",
  "src/ui",
  "src/state/cell-reactive.ts",
  "src/state/state-signals.ts",
];

/** Keys client code reads that the browser stub legitimately never sets. */
const SERVER_ONLY: Record<string, string> = {
  ui: "visibility is enforced against the SERVER's filter; the stub has no " +
    "ui config to enforce and the slice arrives pre-filtered",
  clientMethods: "set by the stub, but only for scope:'client' cells — the " +
    "one case where the browser owns the methods",
  enableSync: "browser-only by construction: the server resolves localFirst " +
    "at compose time and never needs a late-binding hook",
  syncOptOut: "read on both sides; the stub sets it from `sync: false`",
  reduce: "set by the stub together with syncConfig (see enableSync)",
};

async function readAll(paths: string[]): Promise<string> {
  const out: string[] = [];
  for (const p of paths) {
    const url = new URL(`../${p}`, import.meta.url);
    const stat = await Deno.stat(url);
    if (stat.isFile) {
      out.push(await Deno.readTextFile(url));
      continue;
    }
    for await (const e of Deno.readDir(url)) {
      if (e.isFile && e.name.endsWith(".ts")) {
        out.push(
          await Deno.readTextFile(
            new URL(`../${p}/${e.name}`, import.meta.url),
          ),
        );
      }
    }
  }
  return out.join("\n");
}

Deno.test("cell binding: every __aio key the client reads is produced by the browser stub", async () => {
  const clientSrc = await readAll(CLIENT_SOURCES);
  const stubSrc = await Deno.readTextFile(
    new URL("../src/protocol/protocol-cell.ts", import.meta.url),
  );
  const keys = new Set<string>();
  for (const m of clientSrc.matchAll(/__aio\.([a-zA-Z_]\w*)/g)) keys.add(m[1]!);

  const missing: string[] = [];
  for (const key of keys) {
    if (key in SERVER_ONLY) continue;
    // Set as a literal (`id: prefix`), shorthand (`asyncMethods,`), or
    // assigned (`.syncConfig = …` / `["syncConfig"] = …`).
    const produced = new RegExp(
      `(^\\s*${key}\\s*[:,]$)|(^\\s*${key}:)|(\\.${key}\\s*=)|(\\["${key}"\\]\\s*=)`,
      "m",
    ).test(stubSrc);
    if (!produced) missing.push(key);
  }
  assertEquals(
    missing,
    [],
    `client code reads these off __aio, and the browser cell() stub never sets ` +
      `them — in a browser they are undefined and the branch quietly takes the ` +
      `wrong path. Set them in protocol-cell.ts, or list them in SERVER_ONLY ` +
      `with the reason.`,
  );

  for (const key of Object.keys(SERVER_ONLY)) {
    assert(
      keys.has(key),
      `SERVER_ONLY lists '${key}', but no client code reads it any more — ` +
        `drop the exemption so the list stays honest`,
    );
  }
});

Deno.test("cell binding: server and browser cell() agree on the facts the client branches on", () => {
  _resetAioRuntime();
  const config = {
    state: { n: 0, secret: "x" },
    methods: {
      inc(s: { n: number }) {
        s.n += 1;
      },
      async load(s: { n: number }) {
        await Promise.resolve();
        s.n = 1;
      },
    },
    selectors: { double: (s: { n: number }) => s.n * 2 },
  };
  const srv = serverCell("parity-a", config as never);
  _resetAioRuntime();
  // deno-lint-ignore no-explicit-any
  const brw = browserCell("parity-a", config as any) as any;

  assertEquals(brw.__aio.id, srv.__aio.id);
  assertEquals(
    [...(brw.__aio.asyncMethods as Set<string>)].sort(),
    [...(srv.__aio.asyncMethods as Set<string>)].sort(),
    "async classification decides _callId tagging — a mismatch loses return values",
  );
  assertEquals(
    Object.keys(brw.__aio.selectors).sort(),
    Object.keys(srv.__aio.selectors).sort(),
  );
  // The server catalog also carries internal reducer synonyms (`__setLoad`,
  // `__error`, `__effects`) — plumbing the browser never dispatches. Every
  // PUBLIC key must match; the internals are allowed to be server-only.
  const publicKeys = (ks: string[]) =>
    ks.filter((k) => !k.startsWith("__")).sort();
  assertEquals(
    publicKeys(brw.__aio.actionKeys),
    publicKeys(srv.__aio.actionKeys),
  );
  assertEquals(
    brw.__aio.actionKeys.filter((k: string) => k.startsWith("__")),
    [],
    "the stub carries no internal keys — if that changes, the two catalogs " +
      "have started to disagree about what a dispatchable action is",
  );
  _resetAioRuntime();
});

Deno.test("cell binding: sync-capable means config AND replay reducer, on both sides", () => {
  _resetAioRuntime();
  const config = {
    state: { notes: [] as string[] },
    sync: true as const,
    methods: {
      add(s: { notes: string[] }, t: string) {
        s.notes.push(t);
      },
    },
  };
  // deno-lint-ignore no-explicit-any
  const brw = browserCell("parity-sync", config as any) as any;
  assert(brw.__aio.syncConfig, "syncConfig");
  assertEquals(
    typeof brw.__aio.reduce,
    "function",
    "a syncConfig without a reducer is a cell the engine can stamp ops for " +
      "and never replay — optimistic updates would vanish on rebase",
  );
  // And the localFirst path must produce exactly the same pair.
  _resetAioRuntime();
  // deno-lint-ignore no-explicit-any
  const adopted = browserCell("parity-adopt", {
    state: config.state,
    methods: config.methods,
    // deno-lint-ignore no-explicit-any
  } as any) as any;
  assertEquals(adopted.__aio.syncConfig, undefined, "not sync by itself");
  adopted.__aio.enableSync(true);
  assert(adopted.__aio.syncConfig, "adopted: syncConfig");
  assertEquals(typeof adopted.__aio.reduce, "function", "adopted: reducer");
  _resetAioRuntime();
});

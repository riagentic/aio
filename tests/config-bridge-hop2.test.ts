// HOP 2 of the config bridge — `AioConfig` → `setupTransport`.
//
// tests/config-bridge-completeness.test.ts gates HOP 1 (`CellsConfig` →
// `buildLegacyConfig`) with a sentinel round-trip. Hop 2 had no gate, and it
// was a HAND-COPIED literal at the call site in aio.ts — the same bug class
// that already landed as `strictOrigin`, `redactActions`, `appDir` and
// `renderBudget` at hop 1 landed twice more here, both silent:
//
//   • `serveDirs` — typed, allowlisted (so validation says nothing),
//     documented, tested against the HANDLER only. Through `aio.run()` it was
//     `undefined` all the way down: every mapped path 404'd, and the author
//     got back the exact blank-screen symptom the feature exists to cure.
//   • `_cellNames` — dropped, so the `cfg` frame carried no `bootedCells` and
//     the browser's cell-set-drift warning (`_warnCellSetDrift`) returned on
//     its first line: dead code, in a release that shipped it as a feature.
//
// The fix is mechanical, not vigilant: the call site hands over the WHOLE
// config object and `TransportConfig` (aio-server.ts) is the single list of
// what may be read. This file makes that unrottable from both ends:
//
//   1. every key `TransportConfig` declares must be a real, developer-settable
//      config key — a rename or typo on EITHER side is a red test instead of a
//      permanent `undefined`;
//   2. the call site must stay a bare passthrough — the moment a literal comes
//      back, so does the bug class.
//
// The runtime proof that the object really arrives lives in
// tests/serve-dirs-boot.test.ts (a real `aio.run()` serving through
// `serveDirs`) and tests/cfg-handshake.test.ts (`bootedCells` on the frame).
import { assert, assertEquals } from "@std/assert";
import { VALID_AIO_CONFIG_KEYS } from "../src/server/config.ts";
import { childCoverageDir } from "../src/testing/temp-dir.ts";

const REPO = new URL("..", import.meta.url).pathname;
const _childCovDir = childCoverageDir();

/** Property names of an exported interface/type alias, via `deno doc --json`
 *  (the real type, not a source-text guess). Underscore keys included — the
 *  internal ones are exactly where hop 2 lost `_cellNames`. */
async function typedKeys(file: string, typeName: string): Promise<string[]> {
  const out = await new Deno.Command(Deno.execPath(), {
    env: { DENO_COVERAGE_DIR: _childCovDir },
    args: ["doc", "--json", file],
    cwd: REPO,
    stdout: "piped",
    stderr: "null",
  }).output();
  const doc = JSON.parse(new TextDecoder().decode(out.stdout)) as {
    nodes: Record<string, { symbols: Array<Record<string, unknown>> }>;
  };
  const symbols = Object.values(doc.nodes)[0]!.symbols;
  const sym = symbols.find((s) => s.name === typeName) as {
    // deno-lint-ignore no-explicit-any
    declarations: Array<{ kind: string; def: any }>;
  } | undefined;
  assert(sym, `type ${typeName} not found in ${file} doc output`);
  const props: string[] = [];
  // deno-lint-ignore no-explicit-any
  const collect = (t: any): void => {
    if (!t) return;
    if (t.kind === "typeLiteral") {
      for (const p of t.value?.properties ?? t.typeLiteral?.properties ?? []) {
        props.push(p.name);
      }
    } else if (t.kind === "intersection" || t.kind === "union") {
      for (const part of t.value ?? []) collect(part);
    }
  };
  for (const decl of sym.declarations) {
    if (decl.kind === "interface") {
      for (const p of decl.def?.properties ?? []) props.push(p.name);
    }
    if (decl.kind === "typeAlias") collect(decl.def?.tsType);
  }
  assert(
    props.length > 3,
    `extracted too few keys for ${typeName} — doc shape drifted?`,
  );
  return props;
}

Deno.test("config bridge hop 2: every key the transport reads is a real config key", async () => {
  const transportKeys = await typedKeys(
    "src/server/aio-server.ts",
    "TransportConfig",
  );
  const aioKeys = new Set(
    await typedKeys("src/server/aio-types.ts", "AioConfig"),
  );

  // (a) The developer can actually set it — otherwise validateConfig would
  //     kill the app for using it, or nothing would ever fill it.
  const unsettable = transportKeys.filter((k) => !VALID_AIO_CONFIG_KEYS.has(k));
  assertEquals(
    unsettable,
    [],
    "TransportConfig declares key(s) that are not in VALID_AIO_CONFIG_KEYS — " +
      "the transport reads something no one can set, so it is permanently " +
      "undefined; add the key to src/server/config.ts or drop it here",
  );

  // (b) The typed source carries it under the SAME name — a rename on the
  //     AioConfig side would otherwise leave the transport reading undefined
  //     forever, exactly how `serveDirs`/`_cellNames` behaved.
  const orphaned = transportKeys.filter((k) => !aioKeys.has(k));
  assertEquals(
    orphaned,
    [],
    "TransportConfig key(s) missing from the AioConfig type — hop 2 hands the " +
      "config object across verbatim, so a name that does not exist on it can " +
      "never arrive",
  );
});

Deno.test("config bridge hop 2: the call site stays a mechanical passthrough", async () => {
  const src = await Deno.readTextFile(REPO + "src/server/aio.ts");
  const start = src.indexOf("setupTransport<S, A>({");
  assert(start > 0, "setupTransport call site not found in aio.ts");
  const end = src.indexOf("\n  });", start);
  assert(end > start, "could not delimit the setupTransport call");
  const call = src.slice(start, end);

  assert(
    /\n    config,\n/.test(call),
    "aio.ts must hand the WHOLE config object to setupTransport " +
      "(`config,`) — a hand-copied literal is the bug: it dropped serveDirs " +
      "and _cellNames in alpha45, silently, after four earlier instances at " +
      "hop 1. TransportConfig in aio-server.ts is the only list.",
  );
  assert(
    !/\bconfig:\s*\{/.test(call),
    "the hand-copied config literal is back at the setupTransport call site — " +
      "every key it forgets becomes a silently dead feature; pass `config,`",
  );
});

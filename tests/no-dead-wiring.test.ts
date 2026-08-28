// The source checks itself.
//
// `tests/no-vacuous-tests.test.ts` asks whether a green test proved anything.
// This asks the same question one layer down, of the code: does this exported
// function do anything, or does only its doc comment claim it does?
//
// `_noteDispatch` in `src/browser/protocol-subscription.ts` was exported,
// type-checked and documented down to the names of its two callers — and
// nothing in `src/` called it, so every DevTools state frame for the life of
// the feature was attributed to `@@aio/state` instead of the action that
// caused it. Being imported by a test is not being wired.
//
// `scripts/check-dead-wiring.ts` detects that statically: a symbol exported
// from a non-entry file under `src/` that no file under `src/` reaches. This
// runs it as part of the ordinary suite, so a new one cannot land while the
// suite is green — which is the only moment anybody would notice.
//
// The known offenders are frozen in that script's LEDGER, which may only get
// SHORTER. Adding one is red. Wiring one is also red, with the line to delete.
//
//   deno task check:dead-wiring --all           every offender, ledger included
//   deno task check:dead-wiring --print-ledger  regenerate the frozen list
import { assertEquals } from "@std/assert";
import { LEDGER, report, scan, verdict } from "../scripts/check-dead-wiring.ts";

Deno.test("no dead wiring: the ledger of exports nothing in src/ reaches only shrinks", async () => {
  const root = new URL("../", import.meta.url).pathname;
  const v = verdict(await scan(root), LEDGER);
  assertEquals(v.added, [], report(v));
  assertEquals(v.fixed, [], report(v));
});

// ── the widened scan: aiol/ and amui/ are judged too ──────────────────────
//
// A helper exported from `aiol/checks.ts` that only a test calls is dead in
// exactly the way `_noteDispatch` was. Each peer root is judged from ITSELF
// plus `src/` — never from the other peer, never from `tests/`.

import { PEER_ENTRIES, ROOTS } from "../scripts/check-dead-wiring.ts";
import { dirname, join } from "@std/path";

const REPO = new URL("../", import.meta.url).pathname;

Deno.test("dead-wiring: the scan walks src/, aiol/ and amui/ — not just src/", () => {
  assertEquals([...ROOTS].sort(), ["aiol", "amui", "src"]);
});

Deno.test("dead-wiring: PEER_ENTRIES are what deno.json's tasks actually run", async () => {
  const dj = JSON.parse(await Deno.readTextFile(REPO + "deno.json")) as {
    tasks: Record<string, string>;
  };
  assertEquals(PEER_ENTRIES.length > 0, true, "the peer roots are listed");
  for (const entry of PEER_ENTRIES) {
    const named = Object.values(dj.tasks).some((t) => t.includes(entry));
    assertEquals(named, true, `${entry} is not run by any deno.json task`);
  }
});

/** A throwaway repo: deno.json + the files given. Runs the REAL scan on it. */
async function scanFixture(files: Record<string, string>) {
  const dir = await Deno.makeTempDir({ prefix: "aio-deadwire-" });
  try {
    await Deno.writeTextFile(join(dir, "deno.json"), `{"exports":{}}`);
    await Deno.writeTextFile(join(dir, "mod.ts"), "");
    for (const [rel, body] of Object.entries(files)) {
      await Deno.mkdir(dirname(join(dir, rel)), { recursive: true });
      await Deno.writeTextFile(join(dir, rel), body);
    }
    const roots = ROOTS.filter((r) =>
      Object.keys(files).some((f) => f.startsWith(r + "/"))
    );
    return (await scan(dir + "/", roots)).map((o) => `${o.file}|${o.name}`);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("dead-wiring: an aiol/ export only a test reaches is RED", async () => {
  const hits = await scanFixture({
    "aiol/mod.ts": `import { live } from "./checks.ts"; live();`,
    "aiol/checks.ts": `export function live() {}\nexport function dead() {}`,
    "src/x/y.ts": ``,
  });
  assertEquals(hits, ["aiol/checks.ts|dead"]);
});

Deno.test("dead-wiring: an amui/ export is wired by amui/ itself or by src/, never by the other peer", async () => {
  const hits = await scanFixture({
    "amui/src/app.ts": `import { a } from "./ui/k.ts"; a();`,
    "amui/src/ui/k.ts":
      `export function a() {}\nexport function fromSrc() {}\nexport function fromAiol() {}`,
    "src/x/y.ts":
      `import { fromSrc } from "../../amui/src/ui/k.ts"; fromSrc();`,
    "aiol/mod.ts":
      `import { fromAiol } from "../amui/src/ui/k.ts"; fromAiol();`,
  });
  assertEquals(hits, ["amui/src/ui/k.ts|fromAiol"]);
});

Deno.test("dead-wiring: node_modules and .d.ts under a root are not scanned", async () => {
  const hits = await scanFixture({
    "amui/src/app.ts": ``,
    "amui/node_modules/pkg/index.ts": `export function vendored() {}`,
    "amui/src/types.d.ts": `export declare function ambient(): void;`,
  });
  assertEquals(hits, []);
});

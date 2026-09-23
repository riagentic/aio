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

// ── @decider: a function that claims to be THE decider is pinned by a test ──
//
// The tag, never the word: ~85 files say "THE decider" in prose. A JSDoc
// `@decider` tag is placed on purpose, and `checkDeciders` requires every
// tagged function to be exported and imported by some tests/**/*.test.ts(x),
// directly or through a re-export chain.

import {
  checkDeciders,
  readFile,
  specResolver,
  unpinnedDeciders,
} from "../scripts/check-dead-wiring.ts";

Deno.test("@decider: every tagged function in the repo is imported by a test", async () => {
  const miss = await checkDeciders(REPO);
  assertEquals(
    miss.map((o) => `${o.file}:${o.line} ${o.name} (${o.kind})`),
    [],
  );
});

/** Run the REAL check over in-memory files. `files` holds src/ and tests/. */
function decidersFixture(files: Record<string, string>): string[] {
  const all = Object.entries(files).map(([p, s]) => readFile(p, s));
  const tests = all.filter((f) => f.path.startsWith("tests/"));
  const sources = all.filter((f) => !f.path.startsWith("tests/"));
  const read = (p: string) => files[p];
  return unpinnedDeciders(
    sources,
    tests,
    specResolver({ aio: "./mod.ts" }),
    read,
  ).map((o) => `${o.name}|${o.kind}`);
}

const DECIDER_SRC = `/** THE rule for x.
 *
 *  @decider */
export function decideX(v: number): boolean {
  return v > 0;
}
`;

Deno.test("@decider: a tagged function no test imports is RED", () => {
  assertEquals(
    decidersFixture({
      "src/x/rule.ts": DECIDER_SRC,
      "tests/other.test.ts": `import { other } from "../src/x/other.ts";`,
    }),
    ["decideX|@decider no test imports"],
  );
});

Deno.test("@decider: a direct import from its file pins it", () => {
  assertEquals(
    decidersFixture({
      "src/x/rule.ts": DECIDER_SRC,
      "tests/rule.test.ts":
        `import { decideX } from "../src/x/rule.ts";\ndecideX(1);`,
    }),
    [],
  );
});

Deno.test("@decider: an import through a re-export chain (mod.ts → export *) pins it", () => {
  assertEquals(
    decidersFixture({
      "src/x/rule.ts": DECIDER_SRC,
      "src/x.ts": `export { decideX } from "./x/rule.ts";`,
      "mod.ts": `export * from "./src/x.ts";`,
      "tests/rule.test.ts": `import { decideX } from "aio";\ndecideX(1);`,
    }),
    [],
  );
});

Deno.test("@decider: an import inside a fixture string or a comment does not pin it", () => {
  assertEquals(
    decidersFixture({
      "src/x/rule.ts": DECIDER_SRC,
      "tests/rule.test.ts": `// import { decideX } from "../src/x/rule.ts";\n` +
        'const fixture = `import { decideX } from "../src/x/rule.ts";`;',
    }),
    ["decideX|@decider no test imports"],
  );
});

Deno.test("@decider: the same NAME from another file does not pin it", () => {
  assertEquals(
    decidersFixture({
      "src/x/rule.ts": DECIDER_SRC,
      "src/y/rule.ts": `export function decideX() { return 0; }`,
      "tests/rule.test.ts": `import { decideX } from "../src/y/rule.ts";`,
    }),
    ["decideX|@decider no test imports"],
  );
});

Deno.test("@decider: a tagged but unexported function is RED — no test could import it", () => {
  assertEquals(
    decidersFixture({
      "src/x/rule.ts": DECIDER_SRC.replace("export function", "function"),
      "tests/rule.test.ts": `import { decideX } from "../src/x/rule.ts";`,
    }),
    ["decideX|@decider not exported"],
  );
});

Deno.test("@decider: a prose mention is not a tag — only `@decider` at the start of a doc line", () => {
  assertEquals(
    decidersFixture({
      "src/x/rule.ts":
        `/** THE decider for x — see the @decider rule. */\nexport function decideX() {}`,
    }),
    [],
  );
});

// ── the CLIs themselves run to completion ─────────────────────────────────
//
// The tests above import functions and never reach `import.meta.main`. A
// circular import between the two scripts once deadlocked the dead-wiring CLI
// on its own top-level await ("Top-level await promise never resolved") while
// every test here stayed green. So: spawn each CLI exactly as the task does.

for (const script of ["check-dead-wiring.ts", "check-persist-decider.ts"]) {
  Deno.test(`CLI: scripts/${script} runs to completion and exits 0 on this tree`, async () => {
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-read", `${REPO}scripts/${script}`],
      cwd: REPO,
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(out.stdout) +
      new TextDecoder().decode(out.stderr);
    assertEquals(out.code, 0, text);
    assertEquals(/— clean\./.test(text), true, text);
  });
}

// Three places `am` answered without saying what it had left out.
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { AIO_RUNTIME_FLAGS } from "../src/diagnostics/runtime-flags.ts";
import { noCdpMessage } from "../src/am/am-cmd-shot.ts";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { tempDir } from "../src/testing/temp-dir.ts";

// ── 1. a result set that was truncated, silently ─────────────────────────────
//
// `am sql` injects `LIMIT 10000` when the query names none, and said nothing
// about it: a 12,000-row table answered 10,000 rows with exit 0, and anyone —
// or any agent — reading that concludes the table holds exactly 10,000. The
// BYTE cap beside it answers 413 and says what to do; the row cap did not.
Deno.test({
  name: "am sql: more rows than the cap is REFUSED, not quietly cut",
  sanitizeOps: false, // aio-ok: a live server, closed below
  sanitizeResources: false, // aio-ok: same
  fn: async () => {
    const c = cell("sqlrows", { state: { n: 0 }, methods: {} });
    const port = freePort();
    const dir = await tempDir("aio-sqlrows-");
    const app = await aio.run({
      cells: [c],
      appId: `sqlrows-${crypto.randomUUID().slice(0, 8)}`,
      client: "server-only",
      // A real database, because `am sql` is the door onto one.
      persist: true,
      dbPath: `${dir}/state.db`,
      libraryMode: true,
      singleton: false,
      port,
      baseDir: dir,
      // deno-lint-ignore no-explicit-any
    } as any);
    const sql = (q: string) =>
      fetch(`http://127.0.0.1:${port}/__aio/trojan/sql`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-AIO": "1" },
        body: JSON.stringify({ query: q }),
      });
    const RECURSE = (n: number) =>
      `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<${n}) SELECT x FROM c`;
    try {
      // Under the cap: answered in full, as before.
      const small = await sql(RECURSE(50));
      assertEquals(small.status, 200);
      assertEquals(((await small.json()) as unknown[]).length, 50);

      // Over it: refused, and it says what to do.
      const big = await sql(RECURSE(12000));
      const body = await big.text();
      assertEquals(
        big.status,
        413,
        `a truncated answer reads as the whole table: ${body.slice(0, 120)}`,
      );
      assertStringIncludes(body, "LIMIT");

      // …and the caller's OWN limit is honoured without complaint.
      const own = await sql(`${RECURSE(12000)} LIMIT 3`);
      assertEquals(own.status, 200);
      assertEquals(((await own.json()) as unknown[]).length, 3);
    } finally {
      await app.close();
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// ── 2. the flag registry that two guards read ────────────────────────────────
//
// `aio-cli.ts` parses `--watch=`, `--watch=false` and `--no-watch`, and none
// of them was in `AIO_RUNTIME_FLAGS`. So `declareAppFlags(["--watch="])`
// passed the collision guard and the app then LOST the flag to aio — verbatim
// the failure that guard's own message describes. And `aio/cli`'s `args()`,
// which passes aio's own flags through, refused `--no-watch` as an unknown
// flag, though `am help` advertises it as the way to turn live reload off.
Deno.test("runtime flags: every flag aio's CLI parses is in the registry", () => {
  for (const f of ["--watch", "--no-watch", "--port", "--cdp", "--prod"]) {
    assert(
      AIO_RUNTIME_FLAGS.has(f),
      `${f} is parsed by aio and missing from the registry the appFlags ` +
        `collision guard and aio/cli both read`,
    );
  }
});

// ── 3. one explanation, two verbs ────────────────────────────────────────────
//
// `am shot` and `am eval` share the `--cdp` refusal deliberately — two verbs
// that need the same flag must not explain it two ways. The message was
// hardcoded to a screenshot, so `am eval "1+1"` answered "a screenshot needs
// it… then `am shot` again" to someone evaluating an expression.
Deno.test("noCdpMessage: names the caller's own job", () => {
  const shot = noCdpMessage("myapp");
  assertStringIncludes(shot, "a screenshot");
  assertStringIncludes(shot, "am shot again");

  const evaluate = noCdpMessage("myapp", undefined, {
    what: "evaluating an expression in the page",
    verb: "eval",
  });
  assertStringIncludes(evaluate, "evaluating an expression");
  assertStringIncludes(evaluate, "am eval again");
  assert(
    !evaluate.includes("a screenshot"),
    `the eval refusal must not talk about screenshots: ${evaluate}`,
  );
  // The windowless variant too — same sentence, same substitution.
  const windowless = noCdpMessage("myapp", "server-only", {
    what: "evaluating an expression in the page",
    verb: "eval",
  });
  assertStringIncludes(windowless, "evaluating an expression");
  assert(!windowless.includes("for a screenshot"), windowless);
});

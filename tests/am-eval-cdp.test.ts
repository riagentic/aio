// `am eval` against a REAL Chromium.
//
// A fake CDP endpoint would prove only that I wrote both sides of the
// conversation. Every assertion here is a wrong answer the real engine gave
// before the wrapper existed, and each one would have shipped a verb that
// answers confidently and falsely — the exact failure this verb was asked for
// to prevent ("I was one step from editing working code").
//
// The four, measured:
//   getBoundingClientRect()          → {}        (returnByValue flattens it)
//   Promise.resolve(42)              → {}        (replMode breaks awaitPromise)
//   { a: 1 }                         → 1         (a block, not an object)
//   document.body                    → {}        (a Node is not JSON)
//
// Skipped when the box has no Chromium — an environment that cannot look must
// not report a pass.
import { assert, assertEquals } from "@std/assert";
import { cdpConnect, cdpTargets } from "../src/am/am-cdp.ts";
import { evalOutcome, wrapExpression } from "../src/am/am-cmd-eval.ts";
import { findChromium, freePort } from "../src/testing/server-test.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const CHROME = findChromium();
const PAGE =
  "data:text/html,<style>.row{height:26px}</style><div class=row id=r>hello</div>";

async function withPage(
  fn: (
    run: (expr: string) => Promise<ReturnType<typeof evalOutcome>>,
  ) => Promise<void>,
): Promise<void> {
  const port = freePort();
  const profile = await tempDir("am-eval-");
  const child = new Deno.Command(CHROME!, {
    args: [
      "--headless=new",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--no-sandbox",
      "--disable-gpu",
      PAGE,
    ],
    stdout: "null",
    stderr: "null",
  }).spawn();
  try {
    let targets: Awaited<ReturnType<typeof cdpTargets>> | undefined;
    for (let i = 0; i < 80; i++) {
      try {
        targets = await cdpTargets(port, 1000);
        if (targets.some((t) => t.type === "page")) break;
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 250));
    }
    const page = targets?.find((t) => t.type === "page");
    assert(page, "chromium never exposed a page target");
    const cdp = await cdpConnect(page.webSocketDebuggerUrl, 8000);
    try {
      await fn(async (expr) =>
        evalOutcome(
          await cdp.call("Runtime.evaluate", {
            expression: wrapExpression(expr),
            returnByValue: true,
            awaitPromise: true,
          }) as Parameters<typeof evalOutcome>[0],
        )
      );
    } finally {
      cdp.close();
    }
  } finally {
    child.kill("SIGKILL");
    await child.status;
    await dropTempDir(profile);
  }
}

Deno.test({
  name: "am eval: geometry comes back as numbers, not {}",
  ignore: !CHROME,
  fn: () =>
    withPage(async (run) => {
      const r = await run(
        `document.querySelector('.row').getBoundingClientRect()`,
      );
      assert(r.ok, JSON.stringify(r));
      const rect = r.value as Record<string, number>;
      assertEquals(
        rect.height,
        26,
        "the single most-cited reason this verb was asked for is geometry — " +
          "returnByValue alone answers {} because a DOMRect's numbers are " +
          "prototype getters",
      );
      assert(typeof rect.width === "number" && rect.width > 0);
    }),
});

Deno.test({
  name: "am eval: a promise is awaited, not serialised",
  ignore: !CHROME,
  fn: () =>
    withPage(async (run) => {
      assertEquals((await run(`Promise.resolve(42)`)).ok, true);
      assertEquals(
        (await run(`Promise.resolve(42)`) as { value: unknown }).value,
        42,
      );
      // The async shape every real probe has.
      const fetched = await run(
        `fetch('data:text/plain,ok').then(r => r.status)`,
      );
      assert(fetched.ok);
      assertEquals((fetched as { value: unknown }).value, 200);
    }),
});

Deno.test({
  name: "am eval: an object literal is an object, not a labelled block",
  ignore: !CHROME,
  fn: () =>
    withPage(async (run) => {
      const r = await run(`{ a: 1 }`);
      assert(r.ok);
      assertEquals(
        (r as { value: unknown }).value,
        { a: 1 },
        "evaluated bare, this is a block whose value is 1 — a plausible " +
          "number, which is the dangerous kind of wrong answer",
      );
    }),
});

Deno.test({
  name: "am eval: a DOM node is summarised, not flattened to {}",
  ignore: !CHROME,
  fn: () =>
    withPage(async (run) => {
      const r = await run(`document.getElementById('r')`);
      assert(r.ok);
      const v = r.value as Record<string, unknown>;
      assertEquals(v.node, "DIV");
      assertEquals(v.id, "r");
      assertEquals(v.text, "hello");
      assert(
        (v.rect as { height: number }).height > 0,
        "a node's rect is what the asker wanted; JSON.stringify gives {}",
      );
    }),
});

Deno.test({
  name: "am eval: a throw is reported as a throw, not as undefined",
  ignore: !CHROME,
  fn: () =>
    withPage(async (run) => {
      for (
        const expr of [`nope.bad()`, `Promise.reject(new Error("boom"))`]
      ) {
        const r = await run(expr);
        assertEquals(r.ok, false, `${expr} must not read as a value`);
        assert(
          (r as { error: string }).error.length > 0,
          `${expr} must carry the reason`,
        );
      }
    }),
});

Deno.test({
  name: "am eval: undefined and null stay distinguishable",
  ignore: !CHROME,
  fn: () =>
    withPage(async (run) => {
      const u = await run(`undefined`);
      const n = await run(`null`);
      assert(u.ok && n.ok);
      assertEquals((u as { type: string }).type, "undefined");
      assertEquals((n as { value: unknown }).value, null);
    }),
});

Deno.test({
  name: "am eval: a circular value is named, not thrown",
  ignore: !CHROME,
  fn: () =>
    withPage(async (run) => {
      const r = await run(`(() => { const o = {}; o.self = o; return o; })()`);
      assert(
        r.ok,
        "JSON.stringify throws on a cycle — reporting that as an " +
          "evaluation failure would blame the expression for succeeding",
      );
      assert("__aio_unserializable" in (r.value as object));
    }),
});

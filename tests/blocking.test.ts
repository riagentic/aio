// a field report #7 — schedule.blocking(): a named, cancellable, backpressured
// worker pool that runs self-contained functions OFF the main isolate so FFI/CPU
// work can't freeze rendering. Tests drive the pool factory directly (each test
// disposes → no leaked workers).
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createBlockingPool } from "../src/state/blocking.ts";

Deno.test("blocking: runs a self-contained fn off-thread and returns its result", async () => {
  const pool = createBlockingPool({ size: 2 });
  try {
    const out = await pool.run<number>("double", (x) => (x as number) * 2, 21);
    assertEquals(out, 42);
  } finally {
    await pool.dispose();
  }
});

Deno.test("blocking: a throwing fn rejects with its message", async () => {
  const pool = createBlockingPool({ size: 1 });
  try {
    await assertRejects(
      () =>
        pool.run("boom", () => {
          throw new Error("kaboom");
        }),
      Error,
      "kaboom",
    );
  } finally {
    await pool.dispose();
  }
});

Deno.test("blocking: backpressure — size 1 serializes tasks, both still complete", async () => {
  const pool = createBlockingPool({ size: 1 });
  try {
    const results = await Promise.all([
      pool.run<number>("a", (x) => (x as number) + 1, 1),
      pool.run<number>("b", (x) => (x as number) + 1, 10),
      pool.run<number>("c", (x) => (x as number) + 1, 100),
    ]);
    assertEquals(results, [2, 11, 101]);
    assertEquals(pool.size, 1);
  } finally {
    await pool.dispose();
  }
});

Deno.test("blocking: cancel a queued task rejects it while the running one finishes", async () => {
  const pool = createBlockingPool({ size: 1 });
  try {
    // 'slow' occupies the single worker; 'queued' waits behind it.
    const slow = pool.run<string>(
      "slow",
      () => new Promise((r) => setTimeout(() => r("done"), 120)),
    );
    const queued = pool.run("queued", () => "never");
    assertEquals(pool.cancel("queued"), true);
    await assertRejects(() => queued, Error, "cancelled");
    assertEquals(await slow, "done"); // the running task is untouched
  } finally {
    await pool.dispose();
  }
});

Deno.test("blocking: cancel a RUNNING task terminates its worker and rejects", async () => {
  const pool = createBlockingPool({ size: 1 });
  try {
    const running = pool.run(
      "long",
      () => new Promise((r) => setTimeout(r, 5000)),
    );
    // let it reach the worker, then cancel
    await new Promise((r) => setTimeout(r, 30));
    assertEquals(pool.cancel("long"), true);
    await assertRejects(() => running, Error, "cancelled");
    // pool still usable afterward (a fresh worker spins up)
    assertEquals(
      await pool.run<number>("after", (x) => (x as number) * 3, 4),
      12,
    );
  } finally {
    await pool.dispose();
  }
});

Deno.test("blocking: dispose rejects in-flight work", async () => {
  const pool = createBlockingPool({ size: 1 });
  const inflight = pool.run("x", () => new Promise((r) => setTimeout(r, 5000)));
  await new Promise((r) => setTimeout(r, 20));
  await pool.dispose();
  await assertRejects(() => inflight, Error, "disposed");
});

// ── the module form: pool.run(id, new URL("./job.ts", import.meta.url), arg) ──
//
// An inline function crosses as SOURCE TEXT, so it can use nothing of the
// module it was written in (first assertion: the same body, inline, fails).
// A module URL is imported by the worker and its default export called.
Deno.test("blocking: a module URL runs the module's default export, with the module's own imports and helpers", async () => {
  const pool = createBlockingPool({ size: 1 });
  const PREFIX = "job";
  try {
    await assertRejects(
      () => pool.run("inline", (x) => `${PREFIX}:${x}`, "a"),
      Error,
      "SELF-CONTAINED",
    );
    const out = await pool.run<string>(
      "module",
      new URL("./_blocking_job.ts", import.meta.url),
      { a: "x", b: "y" },
    );
    assertEquals(out, "job:x/y");
  } finally {
    await pool.dispose();
  }
});

Deno.test("blocking: a module with no default function, a missing module, and a non-function are refused by name", async () => {
  const pool = createBlockingPool({ size: 1 });
  try {
    await assertRejects(
      () =>
        pool.run(
          "nodefault",
          new URL("./totp-window-helper.ts", import.meta.url),
        ),
      Error,
      "no default export that is a function",
    );
    await assertRejects(
      () => pool.run("missing", new URL("./_no_such_job.ts", import.meta.url)),
      Error,
      "_no_such_job.ts",
    );
    await assertRejects(
      () => pool.run("number", 5 as never),
      Error,
      "must be a function or a module URL",
    );
    // A string is a function's SOURCE (the test below): a path is not one,
    // and its failure says what to pass for a module.
    await assertRejects(
      () => pool.run("string", "./job.ts" as never),
      Error,
      'new URL("./job.ts", import.meta.url)',
    );
    // The pool survives all four.
    assertEquals(await pool.run<number>("ok", () => 1), 1);
  } finally {
    await pool.dispose();
  }
});

// The task has always been `fn.toString()`, so a source STRING as the second
// argument ran through 1.0.19 — untyped, and used: a job kept as text has no
// closure to capture by accident. Measured on a `git archive v1.0.19-beta`
// tree: the three strings below give 42, 2 and ["x","object"]; a build after
// it rejected every one with "must be a function or a module URL — got
// string".
Deno.test("blocking: a function's source text as the second argument runs, as it did on 1.0.19", async () => {
  const pool = createBlockingPool({ size: 1 });
  const run = (src: unknown, arg: unknown) =>
    pool.run("text", src as never, arg);
  try {
    assertEquals(await run("(a) => a * 2", 21), 42);
    assertEquals(await run("function f(a) { return a + 1 }", 1), 2);
    assertEquals(
      await run("async (a) => { await 0; return [a, typeof Deno] }", "x"),
      ["x", "object"],
    );
    // …and whatever stringifies to one.
    assertEquals(await run({ toString: () => "(a) => a" }, 7), 7);
  } finally {
    await pool.dispose();
  }
});

// The PUBLIC door takes the module form too — until 1.0.20 only the pool did,
// so the documented fix for "my job needs an import" was not callable.
Deno.test("blocking(id, URL, arg): the public export runs a module's default export", async () => {
  const { blocking } = await import("../mod.ts");
  try {
    const out = await blocking<string>(
      "public-module",
      new URL("./_blocking_job.ts", import.meta.url),
      { a: "p", b: "q" },
    );
    assertEquals(out, "job:p/q");
    // …and the inline form is exactly what it was.
    assertEquals(
      await blocking<number>("public-inline", (x) => (x as number) + 1, 1),
      2,
    );
  } finally {
    await blocking.dispose();
  }
});

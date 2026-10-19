// A stray error a SETTLED blocking task left behind (a timer that throws, a
// promise it never awaited) is that task's, not the next one's. Under load the
// next task is already running on the same worker when the stray lands; it
// used to be rejected with the other task's error ("blocking worker crashed: …
// stray-A"). The worker now runs each task in its own async context and says
// whose a stray is: a settled task's is logged under its id and the running
// task goes on; the running task's own is still its crash (no hang).
import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { createBlockingPool } from "../src/state/blocking.ts";
import { getLogger, setLogger } from "../src/diagnostics/logger-api.ts";

async function withLogs(fn: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const prev = getLogger();
  setLogger(
    {
      logDir: "",
      pub: (level: string, _cat: string, msg: string) =>
        seen.push(`${level} ${msg}`),
      perf: () => {},
      flush: () => Promise.resolve(),
      // deno-lint-ignore no-explicit-any
    } as any,
  );
  try {
    await fn();
  } finally {
    setLogger(prev);
  }
  return seen;
}

const LEAVES = {
  "a timer that throws": () => {
    setTimeout(() => {
      throw new Error("stray-A");
    }, 60);
    return "A";
  },
  "a promise it never awaited": () => {
    (async () => {
      await new Promise((r) => setTimeout(r, 60));
      throw new Error("stray-A");
    })();
    return "A";
  },
};

for (const [kind, leave] of Object.entries(LEAVES)) {
  Deno.test(`blocking: ${kind} after its task settled is that task's, not the running one's`, async () => {
    const pool = createBlockingPool({ size: 1 });
    try {
      const logs = await withLogs(async () => {
        const a = pool.run("task-a", leave);
        const b = pool.run("task-b", async () => {
          await new Promise((r) => setTimeout(r, 250));
          return "B";
        });
        assertEquals(await a, "A");
        assertEquals(await b, "B");
        // The worker lived: a third task runs on it.
        assertEquals(await pool.run("task-c", () => "C"), "C");
      });
      const line = logs.find((l) => l.includes("stray-A"));
      assertStringIncludes(line ?? logs.join("\n"), "task-a");
    } finally {
      await pool.dispose();
    }
  });
}

Deno.test("blocking: a running task's own stray is still its crash (it does not hang)", async () => {
  const pool = createBlockingPool({ size: 1 });
  try {
    await withLogs(async () => {
      await assertRejects(
        () =>
          pool.run("own", () =>
            new Promise(() => {
              (async () => {
                await new Promise((r) => setTimeout(r, 10));
                throw new Error("mine");
              })();
            })),
        Error,
        "mine",
      );
      await assertRejects(
        () =>
          pool.run("own-timer", () =>
            new Promise(() => {
              setTimeout(() => {
                throw new Error("mine");
              }, 10);
            })),
        Error,
        "blocking worker crashed",
      );
    });
  } finally {
    await pool.dispose();
  }
});

// `am dispatch counter:increment abc` on the stock counter example: the method
// does `s.count += by`, so `count` became the STRING "0abc". The dispatch
// replied ok:true (a warning went to the log only), the value was persisted —
// and the NEXT dev boot refused to start: "REFUSING to boot (dev) — counter:
// count (string stored, number declared)". The refusal exists for a
// DECLARATION that changed without a migration (a rename, a removed field, a
// retyped one — what docs/basics/pitfalls.md promises); here the declaration
// had not changed at all. The app's own committed write bricked its own boot,
// and the only offered ways out discarded data or needed a migration for a
// schema that never moved.
//
// Every write now stamps each written cell's declared-shape fingerprint beside
// the slice (same transaction). A dev boot whose drift sits in a cell stored
// under THIS declaration degrades like production (declared default restored,
// said loudly, naming the field and the fix); drift under a different or
// unknown declaration still refuses.
import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { aio, cell } from "../mod.ts";
import { freePort } from "../src/testing/server-test.ts";
import { _resetParsedCli } from "../src/server/aio-cli.ts";
import { dropTempDir, tempDir } from "../src/testing/temp-dir.ts";

const _argsDesc = Object.getOwnPropertyDescriptor(Deno, "args")!;
function devMode(): void {
  Object.defineProperty(Deno, "args", {
    value: [],
    configurable: true,
    enumerable: true,
  });
  _resetParsedCli();
}
function restoreArgs(): void {
  Object.defineProperty(Deno, "args", _argsDesc);
  _resetParsedCli();
}

Deno.test("shape drift the app itself wrote does not brick the next dev boot", async () => {
  const dir = await tempDir("drift-app-written-");
  const dbPath = join(dir, "data.db");
  const appId = "drift-app-written";
  const boot = (declared: Record<string, unknown>) => {
    const counter = cell("counter", {
      state: declared,
      methods: {
        increment(s: Record<string, unknown>, by: unknown = 1) {
          // deno-lint-ignore no-explicit-any
          (s as any).count += by; // "0" + "abc" — exactly what the example does
        },
      },
    });
    return {
      counter,
      app: aio.run({
        cells: [counter],
        appId,
        client: "server-only",
        libraryMode: true,
        port: freePort(),
        dbPath,
        baseDir: dir,
        persistDebounceMs: 10,
      }),
    };
  };
  devMode();
  try {
    // Boot A (dev): the app writes a string into its number field.
    {
      const { counter, app } = boot({ count: 0 });
      const a = await app;
      await (counter as unknown as { increment: (v: unknown) => Promise<void> })
        .increment("abc");
      // deno-lint-ignore no-explicit-any
      assertEquals((a.getState() as any).counter.count, "0abc");
      await new Promise((r) => setTimeout(r, 300));
      await a.close();
    }
    // Boot B (dev), SAME declaration: boots, says so by name, and restores
    // the declared default.
    {
      const warned: string[] = [];
      const origWarn = console.warn;
      console.warn = (...a: unknown[]) => warned.push(a.map(String).join(" "));
      let a: Awaited<ReturnType<typeof aio.run>> | null = null;
      try {
        a = await boot({ count: 0 }).app;
      } finally {
        console.warn = origWarn;
      }
      try {
        const w = warned.join("\n");
        assert(w.includes("counter.count"), `names the field: ${w}`);
        assert(w.includes("string"), `names the stored type: ${w}`);
        assert(w.includes("own methods"), `says why it booted: ${w}`);
        // deno-lint-ignore no-explicit-any
        assertEquals((a.getState() as any).counter.count, 0);
      } finally {
        await a.close();
      }
    }
    // Boot C (dev), the declaration CHANGED (the field is gone) and a stored
    // value still carries it: still refused — that is the promise.
    {
      const { counter, app } = boot({ count: 0, note: "" });
      const a = await app;
      // deno-lint-ignore no-explicit-any
      (counter as any).increment(1);
      await new Promise((r) => setTimeout(r, 300));
      await a.close();
    }
    await assertRejects(
      () => boot({ count: 0 }).app,
      Error,
      "REFUSING to boot (dev)",
    );
  } finally {
    restoreArgs();
    await dropTempDir(dir);
  }
});

// The stamp means "THIS declaration's own methods wrote the slice". A snapshot
// load puts a slice in state verbatim — from a backup taken under an OLDER
// declaration, with a field since renamed away — and the next write stamped
// it with the current fingerprint all the same. The next dev boot then called
// the stale field the app's own write ("its own methods wrote them"), booted,
// and dropped it — the refusal that exists for exactly that stale shape was
// gone, and the message said the opposite of what happened.
Deno.test("a snapshot loaded from another declaration still refuses the next dev boot", async () => {
  const dir = await tempDir("drift-snapshot-load-");
  const dbPath = join(dir, "data.db");
  const appId = "drift-snapshot-load";
  const boot = () => {
    const counter = cell("counter", {
      state: { count: 0 },
      methods: {
        increment(s: { count: number }) {
          s.count++;
        },
      },
    });
    return {
      counter,
      app: aio.run({
        cells: [counter],
        appId,
        client: "server-only",
        libraryMode: true,
        port: freePort(),
        dbPath,
        baseDir: dir,
        persistDebounceMs: 10,
      }),
    };
  };
  devMode();
  try {
    {
      const { counter, app } = boot();
      const a = await app;
      // A write of this build first: the slice is stamped — the load below
      // must take that stamp away, not merely not add one.
      // deno-lint-ignore no-explicit-any
      await (counter as any).increment();
      await new Promise((r) => setTimeout(r, 300));
      // A backup from before `total` was renamed to `count`.
      a.loadSnapshot!(JSON.stringify({ counter: { count: 3, total: 3 } }));
      await new Promise((r) => setTimeout(r, 300));
      await a.close();
    }
    await assertRejects(
      () => boot().app,
      Error,
      "REFUSING to boot (dev)",
    );
  } finally {
    restoreArgs();
    await dropTempDir(dir);
  }
});

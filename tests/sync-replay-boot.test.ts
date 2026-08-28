// tests/sync-replay-boot.test.ts — field report §3.1 through the REAL boot: the
// replay context `bootStorage` registers (declared versions, onMigrate hooks,
// the KV version stamp) must reach `replaySyncOps`; `sync` + a `persist`
// filter is refused at `cell()` and — for a `cellDefaults.persist` filter that
// would land on a sync cell — at `aio.run()`, before any socket opens.
import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { freePort } from "../src/testing/server-test.ts";
import { log } from "../src/diagnostics/logger-api.ts";

type Entry = { text: string };

Deno.test({
  name:
    "boot: a sync cell's snapshot carries its version; the next build migrates it through onMigrate",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "aio-sync-ver-" });
    const prevApps = Deno.env.get("AIO_APPS_DIR");
    Deno.env.set("AIO_APPS_DIR", dir);
    const warnings: string[] = [];
    const origWarn = log.warn.bind(log);
    // deno-lint-ignore no-explicit-any
    log.warn = ((a: string, b?: string) => warnings.push(b ?? a)) as any;
    try {
      const { aio } = await import("../mod.ts");
      const { _resetAioRuntime } = await import(
        "../src/state/runtime-reset.ts"
      );

      // v1: entries are strings. A server-side call is a server-origin write,
      // which folds into the sync snapshot on shutdown (stamped v1).
      const v1 = cell("vaultboot", {
        version: 1,
        sync: true,
        state: { entries: [] as string[] },
        methods: {
          add(s: { entries: string[] }, v: string) {
            s.entries.push(v);
          },
        },
      });
      const a = await aio.run({
        cells: [v1],
        appId: "sync-ver-probe",
        appDir: dir,
        client: "server-only",
        libraryMode: true,
        port: freePort(),
        // deno-lint-ignore no-explicit-any
      } as any);
      // deno-lint-ignore no-explicit-any
      await (v1 as any).add("keep me");
      await a.close();

      // v2: entries are objects. A `persist` filter on it is REFUSED at
      // definition — the op-log cannot honour one.
      _resetAioRuntime();
      const refused = assertThrows(
        () =>
          cell("vaultboot", {
            version: 2,
            sync: true,
            persist: { exclude: ["cache"] },
            state: { entries: [] as Entry[], cache: "" },
            methods: {},
            // deno-lint-ignore no-explicit-any
          } as any),
        Error,
        "[cell:vaultboot] sync: true + a persist filter (exclude: cache)",
      );
      assert(refused.message.includes("turn sync off"), refused.message);
      _resetAioRuntime();
      const v2 = cell("vaultboot", {
        version: 2,
        sync: true,
        state: { entries: [] as Entry[], cache: "" },
        onMigrate(s: Record<string, unknown>, from: number) {
          return from < 2
            ? {
              ...s,
              entries: (s.entries as string[]).map((text) => ({ text })),
            }
            : s;
        },
        methods: {
          add(s: { entries: Entry[] }, v: Entry) {
            s.entries.push(v);
          },
        },
        // deno-lint-ignore no-explicit-any
      } as any);
      assert(
        !warnings.some((w) => /persist filter/.test(w)),
        `no persist-filter warning survives — the combination is refused, not warned: ${
          warnings.join(" | ")
        }`,
      );
      const b = await aio.run({
        cells: [v2],
        appId: "sync-ver-probe",
        appDir: dir,
        client: "server-only",
        libraryMode: true,
        port: freePort(),
        // deno-lint-ignore no-explicit-any
      } as any);
      try {
        const s = b.getState() as {
          vaultboot: { entries: Entry[]; cache: string };
        };
        assertEquals(
          s.vaultboot,
          { entries: [{ text: "keep me" }], cache: "" },
          "the v1 snapshot was migrated through onMigrate; the new field at its default",
        );
      } finally {
        await b.close();
      }
    } finally {
      log.warn = origWarn;
      if (prevApps === undefined) Deno.env.delete("AIO_APPS_DIR");
      else Deno.env.set("AIO_APPS_DIR", prevApps);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

Deno.test({
  name:
    "boot: a cellDefaults.persist filter that would land on a sync cell REFUSES aio.run(), naming the source",
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "aio-sync-cd-" });
    try {
      const { aio } = await import("../mod.ts");
      const { _resetAioRuntime } = await import(
        "../src/state/runtime-reset.ts"
      );
      _resetAioRuntime();
      const c = cell("cd-sync", {
        sync: true,
        state: { entries: [] as string[], cache: "" },
        methods: {},
      });
      const err = await assertRejects(
        () =>
          aio.run({
            cells: [c],
            cellDefaults: { persist: { exclude: ["cache"] } },
            appId: "sync-cd-probe",
            appDir: dir,
            client: "server-only",
            libraryMode: true,
            singleton: false,
            port: freePort(),
            // deno-lint-ignore no-explicit-any
          } as any),
        Error,
        "[cell:cd-sync] sync: true + a persist filter (exclude: cache, from cellDefaults.persist)",
      );
      assert(err.message.includes('persist: "all"'), err.message);
    } finally {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});

// A boot failure must reach the app's own error sink.
//
// Boot is the phase most likely to fail — a migration that throws, a corrupt
// database, a `db:` binding that resolves to nothing — and those are exactly
// the failures an operator wants routed to their alerting. They were not:
// `_reportOpts` (and the `tt` it closes over) were declared ~100 lines BELOW
// the `bootStorage()` call, so `getReportOpts()` during boot hit the temporal
// dead zone and threw a `ReferenceError` *inside the error path*. The app
// never heard about the failure it most needed to hear about, and the
// ReferenceError masked the real cause.
//
// Found while fixing a data-destroying migration path; the guard added there
// kept the refusal working, which is precisely why this stayed invisible.
import { assert, assertEquals } from "@std/assert";
import { cell } from "../src/state/cell-create.ts";
import { freePort } from "../src/testing/server-test.ts";
import type { AioError } from "../src/diagnostics/error.ts";

Deno.test({
  name: "boot: a migration that throws reaches the app's onError",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "aio-boot-err-" });
    const prevApps = Deno.env.get("AIO_APPS_DIR");
    Deno.env.set("AIO_APPS_DIR", dir);
    try {
      const { aio } = await import("../mod.ts");

      // v1: store something worth losing.
      const v1 = cell("booterr", {
        version: 1,
        state: { items: [] as string[] },
        methods: {
          add(s: { items: string[] }, v: string) {
            s.items.push(v);
          },
        },
      });
      const a = await aio.run({
        cells: [v1],
        appId: "boot-err-probe",
        appVersion: "0.0.0",
        client: "server-only",
        libraryMode: true,
        port: freePort(),
        // deno-lint-ignore no-explicit-any
      } as any);
      // deno-lint-ignore no-explicit-any
      await (v1 as any).add("keep me");
      await a.close();

      // v2: a migration that throws. The app must be TOLD, through its own
      // sink — not only through the console.
      const { _resetAioRuntime } = await import(
        "../src/state/runtime-reset.ts"
      );
      _resetAioRuntime();
      const v2 = cell("booterr", {
        version: 2,
        state: { items: [] as string[], extra: "" },
        onMigrate(_s: unknown): never {
          throw new Error("migration is broken on purpose");
        },
        methods: {
          add(s: { items: string[] }, v: string) {
            s.items.push(v);
          },
        },
        // deno-lint-ignore no-explicit-any
      } as any);

      const seen: AioError[] = [];
      let booted = false;
      try {
        const b = await aio.run({
          cells: [v2],
          appId: "boot-err-probe",
          appVersion: "0.0.0",
          client: "server-only",
          libraryMode: true,
          port: freePort(),
          onError: (e: AioError) => void seen.push(e),
          // deno-lint-ignore no-explicit-any
        } as any);
        booted = true;
        await b.close();
      } catch { /* refusing to boot is the correct outcome */ }

      assertEquals(booted, false, "a broken migration must refuse to boot");
      assert(
        seen.length > 0,
        "the app's onError must fire for a boot failure — it used to hit a " +
          "temporal dead zone and report nothing",
      );
      const text = seen.map((e) => `${e.code} ${e.message}`).join(" | ");
      assert(
        !/is not defined|Cannot access/.test(text),
        `the error must be the REAL cause, not a ReferenceError from the ` +
          `error path itself: ${text}`,
      );
      assert(
        /migration|migrate/i.test(text),
        `the reported error must name the real failure: ${text}`,
      );
    } finally {
      if (prevApps === undefined) Deno.env.delete("AIO_APPS_DIR");
      else Deno.env.set("AIO_APPS_DIR", prevApps);
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    }
  },
});
